import { checkEndpoint, checkKeys, generateVapidKeys, sendPush } from './webpush.js';

// What a device can ask to hear about.
export const EVENTS = ['crash', 'build'];
export const PUSH_API_MESSAGES = {
  badEvents: 'Choose from the alert types this server offers.',
  badSubscription: 'The browser sent a subscription this server cannot use.',
  notSubscribed: 'This device is not subscribed.',
};
const VAPID_KEY = 'push_vapid';
const SUBJECT_KEY = 'push_subject';
// A contact address the push services can use. A https origin is preferred; this is the fallback.
const FALLBACK_SUBJECT = 'https://github.com/neostryder/ark-overseer';

export function checkEvents(value) {
  if (!Array.isArray(value) || value.some((event) => !EVENTS.includes(event))) {
    throw new Error(PUSH_API_MESSAGES.badEvents);
  }
  return [...new Set(value)];
}

export function createPush({
  db,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
  // A server that keeps crashing sends one alert per this many milliseconds, not one per restart.
  crashQuietMs = 10 * 60 * 1000,
}) {
  const stamp = () => new Date(now()).toISOString();
  const getSetting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  const setSetting = (key, value) =>
    db
      .prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, stamp());
  const lastCrash = new Map();

  // Made the first time anything needs it, and kept: a new pair would orphan every subscription.
  function vapid() {
    const stored = getSetting(VAPID_KEY);
    if (stored) return JSON.parse(stored);
    const keys = generateVapidKeys();
    setSetting(VAPID_KEY, JSON.stringify(keys));
    return keys;
  }

  // The first real https address this app is reached at becomes the contact the push services see.
  function learnOrigin(origin) {
    if (getSetting(SUBJECT_KEY) || typeof origin !== 'string') return;
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:' && url.hostname !== 'localhost') setSetting(SUBJECT_KEY, url.origin);
    } catch {
      // An origin that does not parse is ignored.
    }
  }

  function subscribe(subscription, events, origin) {
    let endpoint;
    try {
      endpoint = checkEndpoint(subscription?.endpoint);
      checkKeys(subscription?.keys);
    } catch {
      throw new Error(PUSH_API_MESSAGES.badSubscription);
    }
    const list = checkEvents(events ?? EVENTS);
    learnOrigin(origin);
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, events_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, events_json = excluded.events_json`,
    ).run(endpoint, subscription.keys.p256dh, subscription.keys.auth, JSON.stringify(list), stamp());
    return { events: list };
  }

  function state(endpoint) {
    const row = db.prepare('SELECT events_json FROM push_subscriptions WHERE endpoint = ?').get(String(endpoint));
    return row ? { events: JSON.parse(row.events_json) } : null;
  }

  function unsubscribe(endpoint) {
    return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint)).changes > 0;
  }

  async function deliver(row, message) {
    const subject = getSetting(SUBJECT_KEY) ?? FALLBACK_SUBJECT;
    try {
      const result = await sendPush({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, message, {
        vapid: { ...vapid(), subject },
        fetchFn,
        now,
      });
      if (result.gone) unsubscribe(row.endpoint);
      else if (!result.ok) log(`A push alert was refused with HTTP ${result.status}.`);
      return result.ok;
    } catch (cause) {
      log(`A push alert could not be sent: ${cause.message}`);
      return false;
    }
  }

  async function notify(kind, message) {
    const rows = db
      .prepare('SELECT endpoint, p256dh, auth, events_json FROM push_subscriptions')
      .all()
      .filter((row) => JSON.parse(row.events_json).includes(kind));
    const sent = await Promise.all(rows.map((row) => deliver(row, message)));
    return { devices: rows.length, delivered: sent.filter(Boolean).length };
  }

  async function test(endpoint) {
    const row = db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?')
      .get(String(endpoint));
    if (!row) throw new Error(PUSH_API_MESSAGES.notSubscribed);
    return {
      delivered: await deliver(row, { title: 'Overseer', body: 'Alerts work on this device.', url: '/', tag: 'test' }),
    };
  }

  // A server went down on its own, or the crash guard stopped restarting it.
  function notifyCrash(server, reason) {
    const last = lastCrash.get(server.id);
    if (last !== undefined && now() - last < crashQuietMs) return Promise.resolve({ devices: 0, delivered: 0 });
    lastCrash.set(server.id, now());
    return notify('crash', {
      title: `${server.name} needs attention`,
      body: reason === 'crash loop' ? 'It keeps crashing, so Overseer stopped restarting it.' : 'It crashed.',
      url: `/#/servers/${server.id}/overview`,
      tag: `crash-${server.id}`,
    });
  }

  function notifyBuilds(changes) {
    if (!changes.length) return Promise.resolve({ devices: 0, delivered: 0 });
    const first = changes[0];
    return notify('build', {
      title: 'New ARK server build',
      body:
        changes.length === 1
          ? `Build ${first.buildId} is out on the ${first.branch} branch.`
          : `${changes.length} branches have a new build.`,
      url: '/#/host',
      tag: 'build',
    });
  }

  return {
    publicKey: () => vapid().publicKey,
    subscribe,
    state,
    unsubscribe,
    test,
    notify,
    notifyCrash,
    notifyBuilds,
  };
}
