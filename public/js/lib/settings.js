import { STRINGS } from '../strings.js';
export function groupFields(fields) {
  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.category)) groups.set(field.category, []);
    groups.get(field.category).push(field);
  }
  return Object.fromEntries(groups);
}
export function filterFields(fields, query) {
  const q = String(query || '')
    .trim()
    .toLocaleLowerCase();
  return q
    ? fields.filter((field) =>
        [field.key, field.label, field.description].some((text) =>
          String(text || '')
            .toLocaleLowerCase()
            .includes(q),
        ),
      )
    : [...fields];
}
// Every word of the query must appear in the setting's key, label, description or category, so
// "baby grow" finds Baby Mature Speed Multiplier under Breeding. The search covers every category.
export function searchFields(fields, query) {
  const terms = String(query || '')
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  return fields.filter((field) => {
    const haystack = [field.key, field.label, field.description, field.category]
      .map((text) => String(text || '').toLocaleLowerCase())
      .join(' ');
    return terms.every((term) => haystack.includes(term));
  });
}
// The fields a semantic search ranked, in its order, skipping keys the page doesn't know.
export function rankedFields(fields, ranked) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return (ranked || []).map((entry) => byKey.get(entry.key)).filter(Boolean);
}
export function controlValue(field, current) {
  const isDefault = current === null || current === undefined;
  return { value: isDefault ? field.default : current, isDefault, mark: isDefault ? 'default' : '' };
}
export function pendingChanges(fields, loaded, edited) {
  return fields
    .filter(
      (field) => !field.locked && !field.launchFlag && !Object.is(loaded[field.key] ?? null, edited[field.key] ?? null),
    )
    .map((field) => ({
      key: field.key,
      label: field.label,
      from: loaded[field.key] ?? null,
      to: edited[field.key] ?? null,
    }));
}
export function buildPutBody(changes, fields = []) {
  const blocked = new Set(fields.filter((f) => f.locked || f.launchFlag).map((f) => f.key));
  return Object.fromEntries(changes.filter((change) => !blocked.has(change.key)).map(({ key, to }) => [key, to]));
}
export function validateField(field, value) {
  if (field.locked || field.launchFlag || value === null || value === undefined || value === '') return '';
  const errors = STRINGS.settings.errors;
  if (field.type === 'int' || field.type === 'float') {
    const number = Number(value);
    if (!Number.isFinite(number)) return errors.number;
    if (field.type === 'int' && !Number.isInteger(number)) return errors.whole;
    if (field.min !== undefined && number < field.min) return `${errors.min} ${field.min}.`;
    if (field.max !== undefined && number > field.max) return `${errors.max} ${field.max}.`;
  }
  if (field.maxLength !== undefined && String(value).length > field.maxLength)
    return `${errors.lengthStart} ${field.maxLength} ${errors.lengthEnd}`;
  if (field.pattern && !new RegExp(field.pattern).test(String(value))) return field.patternHelp || errors.invalid;
  return '';
}
