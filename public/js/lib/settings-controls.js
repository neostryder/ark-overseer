import { controlValue } from './settings.js';

export function createSettingInput(field, current, id) {
  const input = document.createElement('input');
  input.id = id;
  input.name = field.key;
  const display = controlValue(field, current);
  if (field.type === 'bool') {
    input.type = 'checkbox';
    input.checked = Boolean(display.value);
    input.className = 'toggle';
  } else {
    input.type =
      field.type === 'password' ? 'password' : field.type === 'int' || field.type === 'float' ? 'number' : 'text';
    if (field.type === 'int' || field.type === 'float') input.inputMode = field.type === 'int' ? 'numeric' : 'decimal';
    input.enterKeyHint = 'done';
    input.value = display.value === '(none)' || display.value === '(game default)' ? '' : String(display.value ?? '');
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    if (field.maxLength) input.maxLength = field.maxLength;
  }
  input.disabled = Boolean(field.locked || field.launchFlag);
  return { input, display };
}

export function readSettingInput(field, input) {
  const raw = field.type === 'bool' ? input.checked : input.value;
  if (field.type === 'int' || field.type === 'float') return raw === '' ? null : Number(raw);
  return raw === '' ? null : raw;
}
