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
    // SteamCMD can print an error and then succeed on its own retry, so the last result line decides.
    let outcome;
    let steamError;
    const { code } = await runner(exePath, args, {
      cwd: root,
      signal,
      onLine: (line) => {
        const parsed = parseSteamCmdLine(line);
        if (parsed?.kind === 'progress')
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
    if (steamError) throw new Error(steamError);
    if (!outcome) throw new Error(`SteamCMD finished without reporting success (exit code ${code})`);
    return { output: outcome };
  }
  function readManifest(installDir) {
    return readAppManifest(installDir);
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
    async latestBuildId({ branch = 'public', signal } = {}) {
      if (!exists(exePath)) throw new Error('SteamCMD is not installed');
      let output = '';
      await runner(exePath, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', '2430930', '+quit'], {
        cwd: root,
        signal,
        onLine: (line) => {
          output += `${line}\n`;
        },
      });
      const info = findAppInfo(output, APP_ID);
      const id = info?.[APP_ID]?.depots?.branches?.[branch]?.buildid;
      if (!id) throw new Error(`Could not find build id for branch ${branch}`);
      return String(id);
    },
  };
}
