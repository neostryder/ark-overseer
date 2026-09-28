import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamCmdLine } from '../src/steamcmd/progress.js';

test('download state parses byte progress', () =>
  assert.deepEqual(parseSteamCmdLine(' Update state (0x61) downloading, progress: 12.34 (1234567890 / 10000000000)'), {
    kind: 'progress',
    phase: 'downloading',
    fraction: 0.1234,
    doneBytes: 1234567890,
    totalBytes: 10000000000,
  }));
test('other update phases parse', () => {
  for (const phase of ['reconfiguring', 'verifying update', 'committing'])
    assert.equal(parseSteamCmdLine(` Update state (0x3) ${phase}, progress: 50.00 (5 / 10)`).phase, phase);
});
test('self update percentages and thousands separators parse', () =>
  assert.deepEqual(parseSteamCmdLine('[----] Downloading update (1,234 of 50,358 KB)...'), {
    kind: 'selfUpdate',
    fraction: 1234 / 50358,
    message: 'Downloading update (1,234 of 50,358 KB)...',
  }));
test('success and error lines parse', () => {
  assert.equal(parseSteamCmdLine("Success! App '2430930' fully installed.").kind, 'success');
  assert.deepEqual(parseSteamCmdLine("ERROR! Failed to install app '2430930' (Disk write failure)"), {
    kind: 'error',
    message: "ERROR! Failed to install app '2430930' (Disk write failure)",
  });
});
test('unrelated output is ignored', () => assert.equal(parseSteamCmdLine('Connecting...'), null));

test('real self-update lines from a SteamCMD first run parse as expected', () => {
  // Captured from a real first run on 2026-09-27.
  assert.deepEqual(parseSteamCmdLine('[  0%] Downloading update (3,200 of 29,791 KB)...'), {
    kind: 'selfUpdate',
    fraction: 3200 / 29791,
    message: 'Downloading update (3,200 of 29,791 KB)...',
  });
  assert.equal(parseSteamCmdLine('[100%] Download complete.').fraction, 1);
  assert.equal(parseSteamCmdLine('[----] Installing update...').fraction, null);
  assert.equal(parseSteamCmdLine('[  0%] Checking for available updates...').fraction, 0);
  assert.equal(
    parseSteamCmdLine('CWorkThreadPool::~CWorkThreadPool: work processing queue not empty: 2 items discarded.'),
    null,
  );
  assert.equal(parseSteamCmdLine("Redirecting stderr to 'C:\\steamcmd\\logs\\stderr.txt'"), null);
});
