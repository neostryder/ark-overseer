import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSteamCmd, extractZip } from '../src/steamcmd/steamcmd.js';
import { createProcessRunner } from '../src/steamcmd/runner.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeRunner(script = {}) {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    for (const line of script.lines ?? []) options.onLine?.(line);
    if (script.wait) await script.wait(options.signal);
    return { code: script.code ?? 0 };
  };
  return { calls, runner };
}
const ok = "Success! App '2430930' fully installed.";

test('appUpdate uses exact arguments and reports progress', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({
    lines: [' Update state (0x61) downloading, progress: 50.00 (2000000000 / 4000000000)', ok],
  });
  const cmd = createSteamCmd({ root, runner: fake.runner });
  const events = [];
  await cmd.appUpdate({ installDir: 'C:\\ARK Server', progress: (...args) => events.push(args) });
  assert.deepEqual(fake.calls[0].args, [
    '+force_install_dir',
    'C:\\ARK Server',
    '+login',
    'anonymous',
    '+app_update',
    '2430930',
    '+quit',
  ]);
  assert.deepEqual(events, [[0.5, 'Downloading: 2.0 of 4.0 GB']]);
});

test('appUpdate adds beta and validate arguments in order', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({ lines: ["Success! App '2430930' already up to date."] });
  await createSteamCmd({ root, runner: fake.runner }).appUpdate({
    installDir: 'D:\\ASA',
    branch: 'staging_1',
    validate: true,
  });
  assert.deepEqual(fake.calls[0].args, [
    '+force_install_dir',
    'D:\\ASA',
    '+login',
    'anonymous',
    '+app_update',
    '2430930',
    '-beta',
    'staging_1',
    'validate',
    '+quit',
  ]);
});

test('appUpdate rejects invalid branches before spawning', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner();
  await assert.rejects(
    createSteamCmd({ root, runner: fake.runner }).appUpdate({ installDir: 'x', branch: 'bad branch' }),
    /Invalid/,
  );
  assert.equal(fake.calls.length, 0);
});
test('appUpdate accepts installed and up to date success lines', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  for (const [line, value] of [
    [ok, 'installed'],
    ["Success! App '2430930' already up to date.", 'up to date'],
  ])
    assert.deepEqual(
      await createSteamCmd({ root, runner: fakeRunner({ lines: [line] }).runner }).appUpdate({ installDir: 'x' }),
      { output: value },
    );
});
test('appUpdate rejects SteamCMD errors and missing success', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const cmd = createSteamCmd({
    root,
    runner: fakeRunner({ lines: ["ERROR! Failed to install app '2430930' (Disk write failure)"] }).runner,
  });
  await assert.rejects(cmd.appUpdate({ installDir: 'x' }), /Disk write failure/);
  await assert.rejects(
    createSteamCmd({ root, runner: fakeRunner().runner }).appUpdate({ installDir: 'x' }),
    /exit code 0/,
  );
});
test('appUpdate refuses to spawn if SteamCMD is absent', async (t) => {
  const root = temp(t);
  const fake = fakeRunner();
  await assert.rejects(createSteamCmd({ root, runner: fake.runner }).appUpdate({ installDir: 'x' }), /not installed/);
  assert.equal(fake.calls.length, 0);
});

test('installSelf streams the download, extracts, removes zip, and bootstraps', async (t) => {
  const root = temp(t);
  const fake = fakeRunner({ lines: ['[ 45%] Downloading update (22,000 of 50,358 KB)...'], code: 7 });
  const chunks = [];
  const fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('zip'));
          c.close();
        },
      }),
    );
  const cmd = createSteamCmd({
    root,
    runner: fake.runner,
    fetch,
    extract: async (_zip, dest) => {
      chunks.push(fs.readFileSync(path.join(dest, 'steamcmd.zip'), 'utf8'));
      fs.writeFileSync(path.join(dest, 'steamcmd.exe'), 'exe');
    },
  });
  const updates = [];
  await cmd.installSelf({ progress: (...a) => updates.push(a) });
  assert.deepEqual(chunks, ['zip']);
  assert.equal(fs.existsSync(path.join(root, 'steamcmd.zip')), false);
  assert.deepEqual(fake.calls[0].args, ['+quit']);
  assert.equal(updates[0][0], 22000 / 50358);
});
test('installSelf rejects a non-ok response without leaving a zip', async (t) => {
  const root = temp(t);
  await assert.rejects(
    createSteamCmd({
      root,
      fetch: async () => new Response(null, { status: 500 }),
      extract: async () => {},
    }).installSelf(),
    /download failed/,
  );
  assert.equal(fs.existsSync(path.join(root, 'steamcmd.zip')), false);
});

test('readManifest reads SteamCMD and Steam client manifest locations', async (t) => {
  const root = temp(t);
  const content = '"AppState" { "StateFlags" "4" "buildid" "25535041" }';
  const first = path.join(root, 'steamapps');
  fs.mkdirSync(first);
  fs.writeFileSync(path.join(first, 'appmanifest_2430930.acf'), content);
  const cmd = createSteamCmd({ root });
  assert.deepEqual(cmd.readManifest(root), {
    buildId: '25535041',
    stateFlags: '4',
    fullyInstalled: true,
    path: path.join(first, 'appmanifest_2430930.acf'),
  });
  const client = path.join(root, 'library', 'steamapps', 'common', 'ASA');
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(path.join(root, 'library', 'steamapps', 'appmanifest_2430930.acf'), content);
  assert.ok(createSteamCmd({ root }).readManifest(client));
  assert.equal(createSteamCmd({ root }).readManifest(path.join(root, 'empty')), null);
});

test('latestBuildId finds public and named branches', async (t) => {
  const root = temp(t);
  const fake = fakeRunner({
    lines: [
      'status',
      '"2430930"',
      '{',
      ' "depots" { "branches" { "public" { "buildid" "100" } "beta" { "buildid" "200" } } }',
      '}',
    ],
  });
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const cmd = createSteamCmd({ root, runner: fake.runner });
  assert.equal(await cmd.latestBuildId(), '100');
  assert.equal(await cmd.latestBuildId({ branch: 'beta' }), '200');
});

test('appUpdate abort rejects with AbortError', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const controller = new AbortController();
  const fake = fakeRunner({
    wait: (signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => {
          const e = new Error();
          e.name = 'AbortError';
          reject(e);
        }),
      ),
  });
  const pending = createSteamCmd({ root, runner: fake.runner }).appUpdate({
    installDir: 'x',
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('extractZip uses Windows tar to extract a real archive', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows tar is only available on Windows');
  const root = temp(t);
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  fs.mkdirSync(source);
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(source, 'sample.txt'), 'archive contents');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  await createProcessRunner()(tar, ['-a', '-cf', path.join(root, 'sample.zip'), '-C', source, 'sample.txt'], {});
  await extractZip(path.join(root, 'sample.zip'), dest);
  assert.equal(fs.readFileSync(path.join(dest, 'sample.txt'), 'utf8'), 'archive contents');
});

test('process runner rejects with AbortError when its signal is aborted', async (t) => {
  if (process.platform !== 'win32') return t.skip('taskkill is Windows only');
  const controller = new AbortController();
  const pending = createProcessRunner()(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
});

// Captured from a real run of `steamcmd +login anonymous +app_info_update 1 +app_info_print 2430930
// +quit` on 2026-09-27, status lines before and after the block included.
const REAL_APP_INFO = fs.readFileSync(new URL('./fixtures/steamcmd-app-info-2430930.txt', import.meta.url), 'utf8');

test('latestBuildId reads real app_info_print output, ignoring the status lines after the block', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({ lines: REAL_APP_INFO.split('\n') });
  const cmd = createSteamCmd({ root, runner: fake.runner });
  assert.equal(await cmd.latestBuildId(), '25535041');
  assert.equal(await cmd.latestBuildId({ branch: 'public_test_realm' }), '21994402');
});

test('latestBuildId refuses to run when SteamCMD is not installed', async (t) => {
  const fake = fakeRunner();
  const cmd = createSteamCmd({ root: temp(t), runner: fake.runner });
  await assert.rejects(cmd.latestBuildId(), /not installed/);
  assert.equal(fake.calls.length, 0);
});

test('a download shorter than its Content-Length is refused and leaves no zip', async (t) => {
  const root = temp(t);
  let extracted = false;
  const fetch = async () =>
    new Response(new Blob([new Uint8Array(10)]).stream(), { headers: { 'content-length': '20' } });
  const cmd = createSteamCmd({
    root,
    runner: fakeRunner().runner,
    fetch,
    extract: async () => {
      extracted = true;
    },
  });
  await assert.rejects(cmd.installSelf(), /cut off: 10 of 20 bytes/);
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(path.join(root, 'steamcmd.zip')), false);
});

test('a failed extract leaves no zip behind', async (t) => {
  const root = temp(t);
  const fetch = async () => new Response(new Blob([new Uint8Array(4)]).stream());
  const extract = async () => {
    throw new Error('Could not extract steamcmd.zip (tar exit code 1)');
  };
  const cmd = createSteamCmd({ root, runner: fakeRunner().runner, fetch, extract });
  await assert.rejects(cmd.installSelf(), /tar exit code 1/);
  assert.equal(fs.existsSync(path.join(root, 'steamcmd.zip')), false);
});

test('extractZip rejects when tar exits with an error', async () => {
  const runner = async () => ({ code: 1 });
  await assert.rejects(extractZip('C:/nowhere/steamcmd.zip', 'C:/nowhere', { runner }), /tar exit code 1/);
});

test('an error followed by a success on a SteamCMD retry counts as success', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({
    lines: ['ERROR! Timed out waiting for AppInfo update.', "Success! App '2430930' fully installed."],
  });
  const cmd = createSteamCmd({ root, runner: fake.runner });
  assert.deepEqual(await cmd.appUpdate({ installDir: path.join(root, 'server') }), { output: 'installed' });
});

test('a relative install folder is passed to SteamCMD as an absolute path', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({ lines: ["Success! App '2430930' already up to date."] });
  const cmd = createSteamCmd({ root, runner: fake.runner });
  await cmd.appUpdate({ installDir: 'relative-server' });
  assert.equal(fake.calls[0].args[1], path.resolve('relative-server'));
});

test('readManifest treats a half-written manifest as no manifest', (t) => {
  const root = temp(t);
  const installDir = path.join(root, 'server');
  fs.mkdirSync(path.join(installDir, 'steamapps'), { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'steamapps', 'appmanifest_2430930.acf'),
    '"AppState"\n{\n\t"buildid"\t\t"1"\n',
  );
  const cmd = createSteamCmd({ root, runner: fakeRunner().runner });
  assert.equal(cmd.readManifest(installDir), null);
});

test('installSelf fails if the bootstrap run leaves no steamcmd.exe', async (t) => {
  const root = temp(t);
  const fetch = async () => new Response(new Blob([new Uint8Array(4)]).stream());
  const extract = async () => fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const runner = async () => {
    fs.rmSync(path.join(root, 'steamcmd.exe'));
    return { code: 7 };
  };
  const cmd = createSteamCmd({ root, runner, fetch, extract });
  await assert.rejects(cmd.installSelf(), /removed steamcmd.exe/);
});

test('latestBuildId runs the app_info command', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({ lines: REAL_APP_INFO.split('\n') });
  const cmd = createSteamCmd({ root, runner: fake.runner });
  await cmd.latestBuildId();
  assert.deepEqual(fake.calls[0].args, [
    '+login',
    'anonymous',
    '+app_info_update',
    '1',
    '+app_info_print',
    '2430930',
    '+quit',
  ]);
});

test('the real runner keeps a multi-byte character that is split across two output chunks', async () => {
  // The euro sign is three bytes in UTF-8; the child writes them in two separate chunks.
  const script =
    'process.stdout.write(Buffer.from([0x70, 0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 50);';
  const lines = [];
  await createProcessRunner()(process.execPath, ['-e', script], { onLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['p\u20ac']);
});

test('appUpdate tries a fresh SteamCMD again once after its first-run "Missing configuration" error', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push(args);
    options.onLine?.(calls.length === 1 ? "ERROR! Failed to install app '2430930' (Missing configuration)" : ok);
    return { code: 0 };
  };
  const result = await createSteamCmd({ root, runner }).appUpdate({ installDir: 'C:\ARK Server' });
  assert.equal(result.output, 'installed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
});

test('appUpdate gives up when the same error comes back, and does not retry other errors', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const attempts = async (message) => {
    let count = 0;
    const runner = async (command, args, options = {}) => {
      count++;
      options.onLine?.(message);
      return { code: 0 };
    };
    await assert.rejects(
      createSteamCmd({ root, runner }).appUpdate({ installDir: 'C:\ARK Server' }),
      /Failed to install/,
    );
    return count;
  };
  assert.equal(await attempts("ERROR! Failed to install app '2430930' (Missing configuration)"), 2);
  assert.equal(await attempts("ERROR! Failed to install app '2430930' (No subscription)"), 1);
});

test('appUpdate does not report the empty "unknown, 0 / 0" line SteamCMD prints at the end of a run', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'steamcmd.exe'), '');
  const fake = fakeRunner({
    lines: [
      ' Update state (0x61) downloading, progress: 50.00 (2000000000 / 4000000000)',
      ' Update state (0x81) unknown, progress: 0.00 (0 / 0)',
      ok,
    ],
  });
  const events = [];
  await createSteamCmd({ root, runner: fake.runner }).appUpdate({
    installDir: 'C:\ARK Server',
    progress: (...args) => events.push(args),
  });
  assert.deepEqual(events, [[0.5, 'Downloading: 2.0 of 4.0 GB']]);
});
