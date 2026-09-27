// Proves the settings catalog accounts for every server option ARK: Survival Ascended documents.
//
// Passes when every key in the reference is either a field or a declared raw-only option. Also fails
// on the mistakes that are easy to make while editing the catalog by hand: a duplicate key, a field
// whose default sits outside its own min/max or off its step, a numeric field missing a bound, a key
// whose file or section disagrees with the reference, or a raw-only entry that is also a field.

// ARK reads INI keys without regard to case and the wiki is not consistent about capitalisation
// (serverPVE, globalVoiceChat, noTributeDownloads), so every comparison here folds case.
const lower = (s) => String(s).toLowerCase();

// Fields that are launch flags rather than INI keys, so they are expected to be missing from the
// reference. Any other field missing from it is more likely a typo in a key name.
const LAUNCH_FLAG_ONLY = new Set(['maxplayers', 'disablebattleye']);

// SessionName is documented and editable, but it has its own input and metadata (SESSION_NAME_META)
// rather than a row in SETTINGS_FIELDS, because it is embedded in the launch connect string.
const HANDLED_ELSEWHERE = new Map([
  ['sessionname', 'dedicated input at the top of the settings page, see SESSION_NAME_META'],
]);
const SECTION_FOR_FILE = { game: '[/script/shootergame.shootergamemode]', gameusersettings: '[serversettings]' };

export function checkCoverage({ reference, fields, rawOnly }) {
  const problems = [];
  const note = (kind, message) => problems.push({ kind, message });

  const seen = new Map();
  for (const field of fields) {
    const key = lower(field.key);
    if (seen.has(key)) note('duplicate', `${field.key} appears twice in SETTINGS_FIELDS`);
    seen.set(key, field);

    if (!field.category) note('shape', `${field.key} has no category, so it would not render under any tab`);
    if (!field.description) note('shape', `${field.key} has no description`);

    if (field.type === 'int' || field.type === 'float') {
      if (field.min === undefined || field.max === undefined) {
        note('shape', `${field.key} is numeric but is missing min or max`);
      } else if (typeof field.default === 'number' && (field.default < field.min || field.default > field.max)) {
        // A default the control cannot represent. This once wrote DinoResistanceMultiplier=0 and
        // made every creature invulnerable.
        note('range', `${field.key} default ${field.default} is outside its own range ${field.min}..${field.max}`);
      } else if (typeof field.default === 'number' && field.step) {
        // A number input accepts min, min+step, min+2*step and so on. A default off that grid makes
        // the form invalid the moment it renders, and a field inside a collapsed tab cannot be
        // focused to show why, so the whole form silently refuses to submit.
        const steps = (field.default - field.min) / field.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) {
          note('step', `${field.key} default ${field.default} is off-step: min ${field.min} with step ${field.step} cannot reach it`);
        }
      }
    }

    if (field.locked && !field.lockedReason) note('shape', `${field.key} is locked but does not say why`);
  }

  const rawMap = new Map();
  for (const entry of rawOnly) {
    const key = lower(entry.key);
    if (rawMap.has(key)) note('duplicate', `${entry.key} appears twice in RAW_ONLY_OPTIONS`);
    if (seen.has(key)) note('duplicate', `${entry.key} is both a field and a raw-only entry`);
    if (!entry.reason) note('shape', `${entry.key} is raw-only but gives no reason`);
    rawMap.set(key, entry);
  }

  const uncovered = [];
  const placements = [];
  for (const option of reference) {
    const key = lower(option.key);
    const field = seen.get(key);
    const raw = rawMap.get(key);

    if (!field && !raw) {
      if (HANDLED_ELSEWHERE.has(key)) {
        placements.push(`${option.key.padEnd(52)} handled elsewhere - ${HANDLED_ELSEWHERE.get(key)}`);
        continue;
      }
      uncovered.push(option);
      continue;
    }

    const where = field ? (field.locked ? `locked field (${field.category})` : `field (${field.category})`) : 'raw INI only';
    placements.push(`${option.key.padEnd(52)} ${where}`);

    // A field pointed at the wrong file or section writes a key the game never reads. The breeding
    // multipliers had this bug before they moved to Game.ini: present, spelled right, ignored.
    const declaredFile = (field ? field.iniFile : raw.iniFile) || 'gameusersettings';
    if (declaredFile !== option.file) {
      note('routing', `${option.key} is declared in ${declaredFile} but the reference puts it in ${option.file}`);
    }
    if (field) {
      const declaredSection = field.iniSection || SECTION_FOR_FILE[declaredFile];
      if (lower(declaredSection) !== lower(option.section)) {
        note('routing', `${option.key} is declared under ${declaredSection} but the reference puts it under ${option.section}`);
      }
    }
  }

  const referenceKeys = new Set(reference.map((option) => lower(option.key)));
  const unknownFields = [...seen.keys()].filter((key) => !referenceKeys.has(key) && !LAUNCH_FLAG_ONLY.has(key));

  return {
    counts: {
      reference: reference.length,
      curated: fields.filter((field) => !field.locked).length,
      locked: fields.filter((field) => field.locked).length,
      rawOnly: rawOnly.length,
      launchFlag: fields.filter((field) => field.launchFlag).length,
    },
    uncovered,
    unknownFields,
    problems,
    placements,
    ok: uncovered.length === 0 && unknownFields.length === 0 && problems.length === 0,
  };
}
