import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOwnedProcess, isSameProcess, normalizeCimDate } from '../src/supervisor/ownership.js';
const exePath = 'C:\\ARK\\Server.exe';

test('ownership matches executable path and exact game port case insensitively', () => {
  assert.deepEqual(
    pickOwnedProcess(
      [{ pid: 1, exePath: 'c:\\ark\\server.exe', commandLine: 'x -PORT=7777', startedAt: 'x' }],
      exePath,
      7777,
    ),
    { pid: 1, startedAt: 'x' },
  );
  assert.equal(pickOwnedProcess([{ pid: 1, exePath, commandLine: '-port=77770' }], exePath, 7777), null);
});

test('ownership rejects zero or multiple process matches', () => {
  assert.equal(pickOwnedProcess([], exePath, 7777), null);
  const list = [1, 2].map((pid) => ({ pid, exePath, commandLine: '-port=7777' }));
  assert.equal(pickOwnedProcess(list, exePath, 7777), null);
});

test('same-process check requires matching pid path and start time within tolerance', () => {
  const record = { pid: 1, exePath, startedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(isSameProcess(record, { ...record, pid: 2 }), false);
  assert.equal(isSameProcess(record, { ...record, exePath: 'C:\\Elsewhere\\x.exe' }), false);
  assert.equal(isSameProcess(record, { ...record, startedAt: '2026-01-01T00:00:03.000Z' }), false);
  assert.equal(isSameProcess(record, { ...record, startedAt: '2026-01-01T00:00:02.000Z' }), true);
  assert.equal(isSameProcess(record, { ...record, startedAt: null }), true);
});

test('CIM dates normalize from the PowerShell JSON representation', () => {
  assert.equal(normalizeCimDate('/Date(1727000000000)/'), '2024-09-22T10:13:20.000Z');
});
