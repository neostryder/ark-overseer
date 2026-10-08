import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createProcessRunner } from './runner.js';
import { parseSteamCmdLine } from './progress.js';
import { findAppInfo, parseKeyValues } from './keyvalues.js';

const APP_ID = '2430930';
const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

export function readAppManifest(installDir) {
  const exists = (file) => fs.existsSync(file);
  const candidates = [
    // A SteamCMD install keeps its manifest inside the install folder. A Steam client install lives
    // in <library>/steamapps/common/<name>, with the manifest two levels up.
    path.join(installDir, 'steamapps', `appmanifest_${APP_ID}.acf`),
    path.resolve(installDir, '..', '..', `appmanifest_${APP_ID}.acf`),
  ];
  for (const manifestPath of candidates) {
    if (!exists(manifestPath)) continue;
    // A manifest SteamCMD is still writing, or left half-written by a failed update, reads as no
    // manifest rather than an error, so a failure is never hidden behind a parse error.
    let app;
    try {
      app = parseKeyValues(fs.readFileSync(manifestPath, 'utf8')).AppState;
    } catch {
      continue;
    }
    if (app)
      return {
        buildId: app.buildid ?? null,
        stateFlags: app.StateFlags ?? null,
        fullyInstalled: app.StateFlags === '4',
        path: manifestPath,
      };
  }
  return null;
}

export async function extractZip(zipPath, destDir, { runner = createProcessRunner(), signal } = {}) {
  // Windows' own bsdtar reads zip files. The tar on PATH can be GNU tar, which cannot.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const { code } = await runner(tar, ['-xf', zipPath, '-C', destDir], { signal });
  if (code !== 0) throw new Error(`Could not extract ${path.basename(zipPath)} (tar exit code ${code})`);
}

export function createSteamCmd({
  root,
  runner = createProcessRunner(),
  fetch = globalThis.fetch,
  extract = extractZip,
}) {
  const exePath = path.join(root, 'steamcmd.exe');
  const exists = (file) => fs.existsSync(file);
  async function appUpdate({ installDir, branch = 'public', validate = false, signal, progress }) {
    if (!exists(exePath)) throw new Error('SteamCMD is not installed');
    if (!/^[A-Za-z0-9_.-]+$/.test(branch)) throw new Error('Invalid Steam branch');
    // SteamCMD resolves a relative install folder against its own folder, not ours.
    const args = ['+force_install_dir', path.resolve(installDir), '+login', 'anonymous', '+app_update', APP_ID];
    if (branch !== 'public') args.push('-beta', branch);
    if (validate) args.push('validate');
    args.push('+quit');
    // A SteamCMD that was installed moments ago answers its first app_update with "Missing configuration"
    // and accepts the same command the next time, so that one error is tried again once.
    for (let attempt = 1; ; attempt++) {
      // SteamCMD can print an error and then succeed on its own retry, so the last result line decides.
      let outcome;
      let steamError;
      const { code } = await runner(exePath, args, {
        cwd: root,
        signal,
        onLine: (line) => {
          const parsed = parseSteamCmdLine(line);
          // SteamCMD ends a run with an "unknown, 0 / 0" line, which would replace the last real message.
          if (parsed?.kind === 'progress' && parsed.totalBytes > 0)
            progress?.(
              parsed.fraction,
              `${parsed.phase[0].toUpperCase()}${parsed.phase.slice(1)}: ${(parsed.doneBytes / 1e9).toFixed(1)} of ${(parsed.totalBytes / 1e9).toFixed(1)} GB`,
            );
          if (parsed?.kind === 'success') {
            outcome = parsed.message.includes('fully installed.') ? 'installed' : 'up to date';
            steamError = undefined;
          }
          if (parsed?.kind === 'error') {
            steamError = parsed.message;
            outcome = undefined;
          }
        },
      });
      if (steamError && attempt === 1 && /Missing configuration/i.test(steamError)) continue;
      if (steamError) throw new Error(steamError);
      if (!outcome) throw new Error(`SteamCMD finished without reporting success (exit code ${code})`);
      return { output: outcome };
    }
  }
  function readManifest(installDir) {
    return readAppManifest(installDir);
  }
  // Every branch the app has on Steam, from one app_info_print: the build id, when Steam last changed the
  // branch, and the manifest of the game depot, which names the exact files that build holds.
  async function branchInfo({ signal } = {}) {
    if (!exists(exePath)) throw new Error('SteamCMD is not installed');
    let output = '';
    await runner(exePath, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', APP_ID, '+quit'], {
      cwd: root,
      signal,
      onLine: (line) => {
        output += `${line}
`;
      },
    });
    return parseBranchInfo(findAppInfo(output, APP_ID), APP_ID);
  }
  return {
    exePath,
    isInstalled: () => exists(exePath),
    async installSelf({ signal, progress } = {}) {
      await fsp.mkdir(root, { recursive: true });
      const zipPath = path.join(root, 'steamcmd.zip');
      const response = await fetch(STEAMCMD_URL, { signal });
      if (!response.ok) throw new Error(`SteamCMD download failed: HTTP ${response.status}`);
      // A cut-off download must never be extracted, and the partial zip never left behind.
      try {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zipPath));
        const expected = Number(response.headers.get('content-length'));
        const actual = (await fsp.stat(zipPath)).size;
        if (expected && actual !== expected) {
          throw new Error(`SteamCMD download was cut off: ${actual} of ${expected} bytes`);
        }
        await extract(zipPath, root, { runner, signal });
      } finally {
        await fsp.rm(zipPath, { force: true });
      }
      if (!exists(exePath)) throw new Error('SteamCMD extraction did not create steamcmd.exe');
      await runner(exePath, ['+quit'], {
        cwd: root,
        signal,
        onLine: (line) => {
          const parsed = parseSteamCmdLine(line);
          if (parsed?.kind === 'selfUpdate') progress?.(parsed.fraction, parsed.message);
        },
      });
      // The first run replaces steamcmd.exe with an updated copy, and any exit code is fine as long
      // as the exe is still there afterwards.
      if (!exists(exePath)) throw new Error('SteamCMD removed steamcmd.exe while updating itself');
      return { installed: true };
    },
    appUpdate,
    readManifest,
    branchInfo,
    async latestBuildId({ branch = 'public', signal } = {}) {
      const branches = await branchInfo({ signal });
      const id = branches[branch]?.buildId;
      if (!id) throw new Error(`Could not find build id for branch ${branch}`);
      return String(id);
    },
  };
}

// The branches of one app's info block, as { name: { buildId, timeUpdated, manifestId } }. timeUpdated is an
// ISO time or null. manifestId is the manifest of the app's largest depot for that branch, which is the game
// itself, or null when the branch lists none.
export function parseBranchInfo(info, appId = APP_ID) {
  const app = info?.[appId];
  const result = {};
  for (const [name, branch] of Object.entries(app?.depots?.branches ?? {})) {
    if (!branch?.buildid) continue;
    const seconds = Number(branch.timeupdated);
    let manifestId = null;
    let largest = -1;
    for (const depot of Object.values(app.depots)) {
      const manifest = depot?.manifests?.[name];
      if (!manifest?.gid) continue;
      const size = Number(manifest.size) || 0;
      if (size > largest) {
        largest = size;
        manifestId = String(manifest.gid);
      }
    }
    result[name] = {
      buildId: String(branch.buildid),
      timeUpdated: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
      manifestId,
    };
  }
  return result;
}
