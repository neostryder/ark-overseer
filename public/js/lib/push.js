import { api } from '../api.js';

// Alerts on this device: the browser's push subscription, kept in step with the server's record of it.
export function pushSupported(env = globalThis) {
  return Boolean(env.navigator && 'serviceWorker' in env.navigator && env.window && 'PushManager' in env.window);
}

// iPhones and iPads deliver alerts only to an app added to the Home Screen.
export function needsHomeScreen({ userAgent = '', standalone = false } = {}) {
  return /iPhone|iPad|iPod/.test(userAgent) && !standalone;
}

export function keyBytes(text) {
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.register('/sw.js');
}

// The alert types this device has, or null when it has none.
export async function pushState() {
  const found = await navigator.serviceWorker.getRegistration('/');
  const subscription = await found?.pushManager.getSubscription();
  if (!subscription) return null;
  try {
    return await api.post('/api/push/state', { endpoint: subscription.endpoint });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function enablePush(events) {
  if (Notification.permission === 'denied') throw new Error('denied');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const worker = await registration();
  await navigator.serviceWorker.ready;
  const info = await api.get('/api/push');
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) }));
  return api.put('/api/push/subscription', { subscription: subscription.toJSON(), events });
}

export async function changeEvents(events) {
  const found = await navigator.serviceWorker.getRegistration('/');
  const subscription = await found?.pushManager.getSubscription();
  if (!subscription) return null;
  return api.put('/api/push/subscription', { subscription: subscription.toJSON(), events });
}

export async function disablePush() {
  const found = await navigator.serviceWorker.getRegistration('/');
  const subscription = await found?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await api.del('/api/push/subscription', { endpoint: subscription.endpoint });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  await subscription.unsubscribe();
}

export async function sendTestPush() {
  const found = await navigator.serviceWorker.getRegistration('/');
  const subscription = await found?.pushManager.getSubscription();
  if (!subscription) throw new Error('This device is not subscribed.');
  return api.post('/api/push/test', { endpoint: subscription.endpoint });
}
