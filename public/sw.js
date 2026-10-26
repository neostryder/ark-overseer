// Shows alerts that the server pushes and opens the right page when one is tapped. It caches nothing, so an
// updated Overseer never runs old scripts.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title = typeof message.title === 'string' && message.title ? message.title : 'Overseer';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      tag: typeof message.tag === 'string' ? message.tag : undefined,
      icon: '/icons/icon-192.png',
      actions: (Array.isArray(message.actions) ? message.actions : [])
        .filter((item) => item && typeof item.action === 'string' && typeof item.title === 'string')
        .slice(0, 2)
        .map((item) => ({ action: item.action, title: item.title })),
      data: { url: typeof message.url === 'string' ? message.url : '/', idle: message.idle ?? null },
    }),
  );
});

// A button on an empty-server alert answers it from the notification. If that fails, for example because the
// sign-in has lapsed, the page opens so the answer can be given there.
async function answerIdle(notification, action) {
  const idle = notification.data?.idle;
  if (!idle || !Number.isInteger(idle.serverId)) return false;
  try {
    const body = action === 'shutdown' ? { action } : { action, value: idle.extend?.value, unit: idle.extend?.unit };
    const response = await fetch(`/api/servers/${idle.serverId}/idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return false;
    const result = await response.json();
    await self.registration.showNotification(notification.title, {
      body: typeof result.message === 'string' ? result.message : '',
      tag: notification.tag,
      icon: '/icons/icon-192.png',
      data: { url: notification.data.url },
    });
    return true;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'shutdown' || event.action === 'extend') {
    event.waitUntil(
      answerIdle(event.notification, event.action).then((done) => {
        if (!done) return openTarget(event.notification);
      }),
    );
    return;
  }
  event.waitUntil(openTarget(event.notification));
});

function openTarget(notification) {
  return (async () => {
    const target = new URL(notification.data?.url ?? '/', self.location.origin);
    if (target.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) await client.navigate(target.href);
      return;
    }
    await self.clients.openWindow(target.href);
  })();
}
