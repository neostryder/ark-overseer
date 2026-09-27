import { SETTINGS_FIELDS, SESSION_NAME_MAX_LENGTH } from './fields.js';

// A plain decimal number, as the game writes it. Number() alone would accept '', ' ', '0x10' and
// '1e3': an empty string becomes 0, which is the absent-is-not-zero bug by another route.
const DECIMAL = /^-?\d+(\.\d+)?$/;
// A line break inside a value would start a new line in the INI, so a string field could smuggle in
// any key, ServerAdminPassword included.
const LINE_BREAK = /[\r\n\0]/;

// Server-side validation. The UI enforces the same rules, but this is the layer that matters, since
// it stands between a request body and a corrupted launch command or INI file.
export function validateSettings(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return ['Settings must be sent as an object.'];
  const errors = [];
  if (Object.hasOwn(body, 'sessionName')) {
    const name = body.sessionName;
    if (typeof name !== 'string') errors.push('Session Name must be text.');
    else {
      if (name.includes('?')) errors.push('Session Name cannot contain "?".');
      if (LINE_BREAK.test(name)) errors.push('Session Name cannot contain a line break.');
      if (name.trim().length > SESSION_NAME_MAX_LENGTH) errors.push(`Session Name must be ${SESSION_NAME_MAX_LENGTH} characters or fewer.`);
    }
  }
  for (const field of SETTINGS_FIELDS) {
    if (!Object.hasOwn(body, field.key)) continue;
    // A locked field is disabled in the UI, but a hand-built request could still carry one. Refuse it
    // here rather than write a value that cuts the manager off from the server it controls.
    if (field.locked) {
      errors.push(`${field.label} cannot be changed here: ${field.lockedReason}`);
      continue;
    }
    const value = body[field.key];
    if (value === null) continue;
    if (field.type === 'bool') {
      if (typeof value !== 'boolean') errors.push(`${field.label} must be on or off.`);
    } else if (field.type === 'password' || field.type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${field.label} must be text.`);
        continue;
      }
      if (LINE_BREAK.test(value)) errors.push(`${field.label} cannot contain a line break.`);
      if (field.pattern && !new RegExp(field.pattern).test(value)) errors.push(`${field.label}: ${field.patternHelp || 'invalid value'}`);
      if (field.maxLength && value.length > field.maxLength) errors.push(`${field.label} must be ${field.maxLength} characters or fewer.`);
    } else if (field.type === 'int' || field.type === 'float') {
      const valid = typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && DECIMAL.test(value);
      const num = Number(value);
      if (!valid) errors.push(`${field.label} must be a number.`);
      else if (field.type === 'int' && !Number.isInteger(num)) errors.push(`${field.label} must be a whole number.`);
      else if (field.min !== undefined && num < field.min) errors.push(`${field.label} must be at least ${field.min}.`);
      else if (field.max !== undefined && num > field.max) errors.push(`${field.label} must be at most ${field.max}.`);
    }
  }
  return errors;
}
