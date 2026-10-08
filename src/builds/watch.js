import { BRANCH_NAME } from './history.js';

// Watches Steam for new dedicated-server builds on every branch, live and test alike, and tells the person
// the moment one changes. Steam's own branch list is the source, so a branch that appears later is picked up
// without any change here.

export const INTERVAL_MS = 15 * 60 * 1000;
export const WEBHOOK_KEY = 'builds_webhook_url';
// Discord accepts a webhook only at its own address, so nothing else is ever sent a build alert.
const DISCORD_WEBHOOK =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;
// Flag 4096 posts silently, so a build alert does not ping the channel.
const SUPPRESS_NOTIFICATIONS = 4096;

export const MESSAGES = {
  badWebhook: 'Use a Discord webhook address, https://discord.com/api/webhooks/<id>/<token>.',
  notInstalled: 'SteamCMD is not installed yet, so Steam cannot be checked.',
  busy: 'SteamCMD is busy with an install or update, so Steam is checked later.',
  alertFailed: 'The build alert did not reach Discord: {reason}',
};
const LABEL = { public: 'the live game', public_test_realm: 'the Public Test Realm' };
export const branchLabel = (branch) => LABEL[branch] ?? `the ${branch} branch`;

export function checkWebhook(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DISCORD_WEBHOOK.test(value.trim()))
    throw Object.assign(new Error(MESSAGES.badWebhook), { status: 400 });
  return value.trim();
}

export function createBuildWatch({
  db,
  steamcmd,
  // True while a job is using SteamCMD, since two runs from one folder can collide.
  isBusy = () => false,
  now = () => Date.now(),
  fetch = globalThis.fetch,
  log = () => {},
  intervalMs = INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let started = false;
  let running = null;
  const stamp = () => new Date(now()).toISOString();
  const setting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;

  function webhook() {
    return setting(WEBHOOK_KEY);
  }
  function setWebhook(value) {
    const url = checkWebhook(value);
    if (url === null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(WEBHOOK_KEY);
    else
      db.prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(WEBHOOK_KEY, url, stamp());
    return url !== null;
  }

  async function alert(changes) {
    const url = webhook();
    if (!url || !changes.length) return;
    const lines = changes.map(
      (change) =>
        `New ARK dedicated server build ${change.buildId} on ${branchLabel(change.branch)}` +
        (change.previousBuildId ? ` (was ${change.previousBuildId}).` : '.'),
    );
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: lines.join('\n'), flags: SUPPRESS_NOTIFICATIONS }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (cause) {
      log(MESSAGES.alertFailed.replace('{reason}', cause.message));
    }
  }

  // One look at Steam. The first time a branch is seen it is only recorded, since nothing changed; after that
  // each new build id is a change. Returns the changes so a caller can show them.
  async function check({ signal } = {}) {
    if (!steamcmd.isInstalled()) return { checked: false, reason: MESSAGES.notInstalled, changes: [] };
    if (isBusy()) return { checked: false, reason: MESSAGES.busy, changes: [] };
    const branches = await steamcmd.branchInfo({ signal });
    const at = stamp();
    const changes = [];
    for (const [branch, info] of Object.entries(branches)) {
      if (!BRANCH_NAME.test(branch)) continue;
      const seen = db.prepare('SELECT build_id FROM steam_builds WHERE branch = ?').get(branch);
      if (!seen) {
        db.prepare(
          'INSERT INTO steam_builds (branch, build_id, manifest_id, time_updated, previous_build_id, first_seen_at, changed_at, checked_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
        ).run(branch, info.buildId, info.manifestId, info.timeUpdated, at, info.timeUpdated ?? at, at);
      } else if (seen.build_id !== info.buildId) {
        db.prepare(
          'UPDATE steam_builds SET build_id = ?, manifest_id = ?, time_updated = ?, previous_build_id = ?, changed_at = ?, checked_at = ? WHERE branch = ?',
        ).run(info.buildId, info.manifestId, info.timeUpdated, seen.build_id, info.timeUpdated ?? at, at, branch);
        changes.push({ branch, buildId: info.buildId, previousBuildId: seen.build_id });
      } else {
        db.prepare('UPDATE steam_builds SET manifest_id = ?, checked_at = ? WHERE branch = ?').run(
          info.manifestId,
          at,
          branch,
        );
      }
    }
    await alert(changes);
    return { checked: true, changes };
  }

  // Overlapping checks would run SteamCMD twice at once, so a second caller shares the first one's result.
  function checkOnce(options) {
    running ??= check(options).finally(() => {
      running = null;
    });
    return running;
  }

  function list() {
    return db.prepare('SELECT * FROM steam_builds ORDER BY branch').all();
  }

  function arm(wait) {
    if (!started) return;
    // A second start() must not leave the first timer running beside the new one.
    if (timer !== null) clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      try {
        await checkOnce();
      } catch (cause) {
        log(`The Steam build check failed: ${cause.message}`);
      }
      arm(intervalMs);
    }, wait);
    timer.unref?.();
  }

  return {
    check: checkOnce,
    list,
    webhook: () => ({ configured: webhook() !== null }),
    setWebhook,
    start() {
      started = true;
      // The first look comes a short while after start-up, not during it.
      arm(30 * 1000);
    },
    stop() {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
