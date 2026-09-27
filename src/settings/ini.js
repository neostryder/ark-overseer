import fs from 'node:fs';
import { writeFileAtomic } from '../util/fsutil.js';

export const SERVER_SETTINGS = '[ServerSettings]';
export const SESSION_SETTINGS = '[SessionSettings]';
// Not every curated field lives in GameUserSettings.ini. The breeding multipliers are only read from
// Game.ini's game-mode section; written into [ServerSettings] they sit in the file looking correct
// and are silently ignored, which is exactly how a 0.5 cuddle interval kept behaving like 1.0.
// A field carrying iniFile: 'game' routes here, everything else to [ServerSettings].
export const GAME_MODE_SETTINGS = '[/script/shootergame.shootergamemode]';

export function fileFor(field) {
  return field.iniFile === 'game' ? 'game' : 'gameusersettings';
}

// Two levels of routing, because a handful of options live in neither of the usual two sections.
// Ports and MultiHome belong to [SessionSettings], the message of the day to [MessageOfTheDay], and
// Ragnarok's volcano and unicorn settings to [Ragnarok]. A field naming its own iniSection wins;
// everything else falls back to whichever section its file normally uses. Getting this wrong writes
// a real key into the wrong section, where the game never looks for it.
export function sectionFor(field) {
  if (field.iniSection) return field.iniSection;
  return field.iniFile === 'game' ? GAME_MODE_SETTINGS : SERVER_SETTINGS;
}

// ---- surgical ini read/write (touches only the keys we own, leaves every other line untouched) ----

// A file is read together with its format, so a write puts back the same encoding, byte order mark
// and line endings. The game writes UTF-8 without a BOM, but other tools save these files as UTF-8
// with a BOM or as UTF-16. A BOM left on the first line hides the first section header, so the next
// write appends a duplicate section; rewriting an LF file as CRLF changes every line in it.
export function readIniFile(iniPath) {
  if (!fs.existsSync(iniPath)) return { lines: [], encoding: 'utf8', bom: false, eol: '\r\n' };
  const bytes = fs.readFileSync(iniPath);
  let encoding = 'utf8';
  let bom = false;
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf16le';
    bom = true;
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    text = bytes.subarray(3).toString('utf8');
  } else {
    text = bytes.toString('utf8');
  }
  const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), encoding, bom, eol };
}

export function writeIniFile(iniPath, { lines, encoding = 'utf8', bom = false, eol = '\r\n' }) {
  const body = Buffer.from(lines.join(eol), encoding);
  const prefix = !bom ? Buffer.alloc(0) : Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xef, 0xbb, 0xbf]);
  writeFileAtomic(iniPath, Buffer.concat([prefix, body]));
}

export function readIniLines(iniPath) {
  return readIniFile(iniPath).lines;
}

export function writeIniLines(iniPath, lines) {
  writeIniFile(iniPath, { lines });
}

// Section headers are matched without regard to case, because ARK writes them one way and documents
// them another - GameUserSettings.ini carries [ServerSettings] while Game.ini's game-mode header
// appears as both [/Script/ShooterGame.ShooterGameMode] and the all-lowercase spelling used here. An
// exact match that missed would not read as an error: findSection returns null, and setIniKey then
// appends a SECOND copy of the section at the end of the file, where the game ignores it.
//
// A header is read the way the game reads it: the name between the brackets, ignoring anything after
// the closing bracket, so "[ServerSettings] ; managed" is still [ServerSettings].
function headerName(line) {
  const m = line.trimStart().match(/^\[([^\]]*)\]/);
  return m ? m[1].trim().toLowerCase() : null;
}

// Every block with this header, in file order. Files edited by hand or by other tools can repeat a
// section, and the game merges the repeats, so a key has to be looked for in all of them.
export function findSections(lines, sectionHeader) {
  const wanted = headerName(sectionHeader);
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (headerName(lines[i]) !== wanted) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (headerName(lines[j]) !== null) {
        end = j;
        break;
      }
    }
    sections.push({ start: i, end });
  }
  return sections;
}

export function findSection(lines, sectionHeader) {
  return findSections(lines, sectionHeader)[0] ?? null;
}

// Keys are matched without regard to case, for the same reason as sections. ARK's own wiki spells
// several of them with a leading lower-case letter - serverPVE, globalVoiceChat, noTributeDownloads -
// and the game reads them either way. Comparing exactly meant a file containing serverPVE=False was
// never found when looking for ServerPVE, so a save appended a second line for the same setting and
// left the file holding two answers to one question.
// Values are trimmed, since the game reads "ServerPVE = False" as False.
export function findKeyLine(lines, section, key) {
  return findKeyLines(lines, [section], key)[0] ?? null;
}

function findKeyLines(lines, sections, key) {
  const wanted = key.trim().toLowerCase();
  const found = [];
  for (const section of sections) {
    for (let i = section.start + 1; i < section.end; i++) {
      const m = lines[i].match(/^([^=]+)=(.*)$/);
      if (m && m[1].trim().toLowerCase() === wanted) found.push({ index: i, value: m[2].trim() });
    }
  }
  return found;
}

// When a key appears more than once, the last line is the one the game uses.
export function getIniKey(lines, sectionHeader, key) {
  const found = findKeyLines(lines, findSections(lines, sectionHeader), key);
  return found.length ? found.at(-1).value : null;
}

// Sets the line the game reads and drops earlier copies of the key, so the file holds one answer.
// These helpers are for single-value keys only: repeatable keys such as OverrideEngramEntries are
// edited through the raw INI, never here.
export function setIniKey(lines, sectionHeader, key, value) {
  const sections = findSections(lines, sectionHeader);
  const found = findKeyLines(lines, sections, key);
  if (found.length) {
    lines[found.at(-1).index] = `${key}=${value}`;
    for (const { index } of found.slice(0, -1).reverse()) lines.splice(index, 1);
    return;
  }
  const section = sections[0];
  if (!section) {
    // A section the file does not have yet gets appended, separated by a blank line. Without the
    // separator, two sections created in the same save ran together as [Ragnarok] immediately
    // followed by [MessageOfTheDay] - still valid, but the file is meant to stay readable by hand.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(sectionHeader, `${key}=${value}`);
    return;
  }
  lines.splice(section.start + 1, 0, `${key}=${value}`);
}

export function removeIniKey(lines, sectionHeader, key) {
  const found = findKeyLines(lines, findSections(lines, sectionHeader), key);
  for (const { index } of found.reverse()) lines.splice(index, 1);
}
