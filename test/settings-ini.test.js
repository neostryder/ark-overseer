import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import {
  readIniFile,
  writeIniFile,
  readIniLines,
  writeIniLines,
  getIniKey,
  setIniKey,
  removeIniKey,
  fileFor,
  sectionFor,
  GAME_MODE_SETTINGS,
} from '../src/settings/ini.js';

const field = (key) => SETTINGS_FIELDS.find((f) => f.key === key);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a section header matches regardless of case and is never duplicated', () => {
  const lines = ['[/Script/ShooterGame.ShooterGameMode]', 'bDisablePhotoMode=False'];
  setIniKey(lines, GAME_MODE_SETTINGS, 'BabyCuddleIntervalMultiplier', '0.5');
  assert.deepEqual(lines, [
    '[/Script/ShooterGame.ShooterGameMode]',
    'BabyCuddleIntervalMultiplier=0.5',
    'bDisablePhotoMode=False',
  ]);
});

test('a key matches regardless of case, leaving one line for it', () => {
  const lines = ['[ServerSettings]', 'serverPVE=False'];
  setIniKey(lines, '[ServerSettings]', 'ServerPVE', 'True');
  assert.deepEqual(lines, ['[ServerSettings]', 'ServerPVE=True']);
  assert.equal(getIniKey(lines, '[serversettings]', 'SERVERPVE'), 'True');
});

test('a missing section is appended after a blank line, a missing key goes right after its header', () => {
  const lines = ['[ServerSettings]', 'ServerPVE=True'];
  setIniKey(lines, '[Ragnarok]', 'EnableVolcano', 'True');
  assert.deepEqual(lines, ['[ServerSettings]', 'ServerPVE=True', '', '[Ragnarok]', 'EnableVolcano=True']);
  setIniKey(lines, '[ServerSettings]', 'ServerHardcore', 'False');
  assert.deepEqual(lines.slice(0, 3), ['[ServerSettings]', 'ServerHardcore=False', 'ServerPVE=True']);
});

test('lines the helpers do not own come through unchanged', () => {
  const original = [
    '; kept comment',
    '',
    '[ServerSettings]',
    'Unknown=abc',
    'ServerPVE=False',
    '',
    '[Other]',
    'Thing=1',
    '',
  ];
  const lines = [...original];
  setIniKey(lines, '[ServerSettings]', 'ServerPVE', 'True');
  removeIniKey(lines, '[ServerSettings]', 'ServerPVE');
  assert.deepEqual(
    lines,
    original.filter((line) => line !== 'ServerPVE=False'),
  );
});

test('a missing file reads as no lines, and a new file is written with CRLF', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readIniLines(path.join(dir, 'missing.ini')), []);
  const target = path.join(dir, 'new.ini');
  writeIniLines(target, ['[ServerSettings]', 'ServerPVE=True', '']);
  assert.equal(fs.readFileSync(target, 'utf8'), '[ServerSettings]\r\nServerPVE=True\r\n');
});

test('a write keeps the file encoding, byte order mark and line endings', (t) => {
  const dir = tempDir(t);
  const cases = [
    {
      name: 'utf8-bom.ini',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[ServerSettings]\r\nServerPVE=False\r\n')]),
    },
    {
      name: 'utf16.ini',
      bytes: Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('[ServerSettings]\r\nServerPVE=False\r\n', 'utf16le'),
      ]),
    },
    { name: 'lf.ini', bytes: Buffer.from('[ServerSettings]\nServerPVE=False\n') },
  ];
  for (const { name, bytes } of cases) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, bytes);
    const file = readIniFile(target);
    // The header must be found through the BOM, or the write below would append a second section.
    assert.equal(getIniKey(file.lines, '[ServerSettings]', 'ServerPVE'), 'False', name);
    setIniKey(file.lines, '[ServerSettings]', 'ServerPVE', 'True');
    writeIniFile(target, file);
    const expected = Buffer.from(bytes.toString('latin1').replace('False', 'True'), 'latin1');
    if (name === 'utf16.ini') {
      assert.deepEqual(
        fs.readFileSync(target),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[ServerSettings]\r\nServerPVE=True\r\n', 'utf16le')]),
      );
    } else {
      assert.deepEqual(fs.readFileSync(target), expected, name);
    }
  }
});

test('fields route to the file and section the game reads them from', () => {
  const cases = [
    ['BabyCuddleIntervalMultiplier', 'game', '[/script/shootergame.shootergamemode]'],
    ['Port', 'gameusersettings', '[SessionSettings]'],
    ['EnableVolcano', 'gameusersettings', '[Ragnarok]'],
    ['Message', 'gameusersettings', '[MessageOfTheDay]'],
    ['ServerPVE', 'gameusersettings', '[ServerSettings]'],
  ];
  for (const [key, file, section] of cases) {
    assert.equal(fileFor(field(key)), file, key);
    assert.equal(sectionFor(field(key)), section, key);
  }
});

test('a repeated section is searched as one, and a write leaves one line for the key', () => {
  const lines = ['[ServerSettings]', 'ServerPVE=True', 'Foo=1', '', '[ServerSettings]', 'ServerPVE=False'];
  // The last line is the one the game uses.
  assert.equal(getIniKey(lines, '[ServerSettings]', 'ServerPVE'), 'False');
  setIniKey(lines, '[ServerSettings]', 'ServerPVE', 'True');
  assert.deepEqual(lines, ['[ServerSettings]', 'Foo=1', '', '[ServerSettings]', 'ServerPVE=True']);
  removeIniKey(lines, '[ServerSettings]', 'ServerPVE');
  assert.equal(getIniKey(lines, '[ServerSettings]', 'ServerPVE'), null);
});

test('a header followed by a comment is still that section', () => {
  const lines = ['[ServerSettings] ; managed', 'ServerPVE=False', '[Other] ; x', 'ServerPVE=True'];
  assert.equal(getIniKey(lines, '[ServerSettings]', 'ServerPVE'), 'False');
  setIniKey(lines, '[ServerSettings]', 'ServerHardcore', 'True');
  assert.deepEqual(lines, [
    '[ServerSettings] ; managed',
    'ServerHardcore=True',
    'ServerPVE=False',
    '[Other] ; x',
    'ServerPVE=True',
  ]);
});

test('values are read without the spaces around them', () => {
  assert.equal(getIniKey(['[ServerSettings]', 'ServerPVE = False '], '[ServerSettings]', 'ServerPVE'), 'False');
});
