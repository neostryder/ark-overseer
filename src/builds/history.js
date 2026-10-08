// What each install received from Steam and when. The depot manifest recorded with a build is what lets an
// exact older build be fetched again, since a branch only ever names its newest build.

export const BRANCH_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// The branch a test install runs on. Steam names it, and the game's own guide calls it the Public Test Realm.
export const TEST_BRANCH = 'public_test_realm';
export const isTestBranch = (branch) => branch !== 'public';

export function recordInstallBuild(db, installId, { branch, buildId, reason, now = () => Date.now() }) {
  // The manifest comes from what Steam offered on this branch, and only counts when it is the same build the
  // install holds. A build that is no longer the newest has no manifest to record here.
  const offered = db.prepare('SELECT build_id, manifest_id FROM steam_builds WHERE branch = ?').get(branch);
  const manifestId =
    offered && buildId != null && String(offered.build_id) === String(buildId) ? offered.manifest_id : null;
  db.prepare(
    'INSERT INTO install_builds (install_id, branch, build_id, manifest_id, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(installId, branch, buildId == null ? null : String(buildId), manifestId, reason, new Date(now()).toISOString());
}

export function listInstallBuilds(db, installId, limit = 20) {
  return db.prepare('SELECT * FROM install_builds WHERE install_id = ? ORDER BY id DESC LIMIT ?').all(installId, limit);
}

// A server on a test branch starts with its mods suspended, since mods built for the live game are not expected
// to load there. The list is kept beside the server's settings so leaving the test branch can put it back.
// Both functions take and return the settings JSON text, and return it unchanged when there is nothing to do.
function parse(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function suspendMods(settingsJson) {
  const settings = parse(settingsJson);
  if (!settings || !Array.isArray(settings.mods) || !settings.mods.length) return settingsJson;
  const { mods, ...rest } = settings;
  return JSON.stringify({ ...rest, suspendedMods: mods });
}

// Puts the suspended list back only when no mods are active now, so mods chosen on the test branch are kept.
export function resumeMods(settingsJson) {
  const settings = parse(settingsJson);
  if (!settings || !Array.isArray(settings.suspendedMods)) return settingsJson;
  const { suspendedMods, ...rest } = settings;
  const active = Array.isArray(rest.mods) && rest.mods.length;
  return JSON.stringify(active || !suspendedMods.length ? rest : { ...rest, mods: suspendedMods });
}
