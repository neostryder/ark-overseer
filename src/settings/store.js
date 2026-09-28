import { SETTINGS_FIELDS } from './fields.js';
import {
  readIniFile,
  writeIniFile,
  getIniKey,
  setIniKey,
  removeIniKey,
  fileFor,
  sectionFor,
  SESSION_SETTINGS,
} from './ini.js';
import { validateSettings } from './validate.js';

export function createSettingsStore({ gameUserSettingsPath, gameIniPath }) {
  const paths = { gameusersettings: gameUserSettingsPath, game: gameIniPath };

  function readFiles() {
    return { gameusersettings: readIniFile(gameUserSettingsPath), game: readIniFile(gameIniPath) };
  }

  // An absent key reads as null. It is never turned into 0, false or '', because the game's own
  // default for an absent key is usually not the bottom of the range: writing 0 back for an absent
  // DinoResistanceMultiplier once made every creature invulnerable.
  function readSettings() {
    const files = readFiles();
    const settings = { sessionName: getIniKey(files.gameusersettings.lines, SESSION_SETTINGS, 'SessionName') ?? '' };
    for (const field of SETTINGS_FIELDS) {
      if (field.launchFlag) continue;
      settings[field.key] = getIniKey(files[fileFor(field)].lines, sectionFor(field), field.key);
    }
    return settings;
  }

  // Only keys named in body change, and only the files they live in are rewritten, so a save that
  // never mentions a Game.ini field cannot create an empty Game.ini. A null value removes the key.
  function writeSettings(body) {
    const errors = validateSettings(body);
    if (errors.length) {
      const error = new Error(errors.join(' '));
      error.errors = errors;
      throw error;
    }
    const files = readFiles();
    const touched = new Set();
    if (typeof body.sessionName === 'string' && body.sessionName.trim()) {
      setIniKey(files.gameusersettings.lines, SESSION_SETTINGS, 'SessionName', body.sessionName.trim());
      touched.add('gameusersettings');
    }
    for (const field of SETTINGS_FIELDS) {
      if (!Object.hasOwn(body, field.key) || field.launchFlag || field.locked) continue;
      const file = fileFor(field);
      const value = body[field.key];
      if (value === null) {
        removeIniKey(files[file].lines, sectionFor(field), field.key);
      } else {
        setIniKey(
          files[file].lines,
          sectionFor(field),
          field.key,
          field.type === 'bool' ? (value ? 'True' : 'False') : String(value),
        );
      }
      touched.add(file);
    }
    for (const file of touched) writeIniFile(paths[file], files[file]);
    return { written: [...touched] };
  }

  // Resets every field to its documented default, except ServerAdminPassword (blanking it would cut
  // the manager off from RCON) and locked fields. A default of '(none)' writes an empty value; any
  // other default in parentheses removes the key so the game's built-in default applies.
  function resetToDefaults() {
    const files = readFiles();
    const skipped = [];
    const touched = new Set();
    for (const field of SETTINGS_FIELDS) {
      if (field.locked || field.key === 'ServerAdminPassword') {
        skipped.push(field.key);
        continue;
      }
      if (field.launchFlag) continue;
      const file = fileFor(field);
      const lines = files[file].lines;
      const section = sectionFor(field);
      if (field.default === '(none)') {
        setIniKey(lines, section, field.key, '');
      } else if (typeof field.default === 'string' && field.default.startsWith('(')) {
        removeIniKey(lines, section, field.key);
      } else {
        setIniKey(
          lines,
          section,
          field.key,
          field.type === 'bool' ? (field.default ? 'True' : 'False') : String(field.default),
        );
      }
      touched.add(file);
    }
    for (const file of touched) writeIniFile(paths[file], files[file]);
    return { skipped };
  }

  return { readSettings, writeSettings, resetToDefaults };
}
