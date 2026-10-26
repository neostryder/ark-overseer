import { STRINGS } from '../strings.js';

export const IDLE_UNITS = ['minute', 'hour', 'day'];

// The unit word is plural exactly when the number is not 1: "1 hour", "2 hours".
export const unitWord = (value, unit) => (value === 1 ? unit : `${unit}s`);
export const describeDuration = (value, unit) => `${value} ${unitWord(value, unit)}`;

export const extendLabel = (value, unit) =>
  `${STRINGS.idle.extendLead} ${describeDuration(value, unit)} ${STRINGS.idle.extendTail}`;

// A whole number of at least 1 from a text box, or null.
export function readWhole(text) {
  const value = Number(String(text).trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// A number box and a unit list that stay in agreement: typing 1 makes the list read "hour", typing 2 makes it "hours".
export function durationInputs({ value, unit, onChange }) {
  const number = document.createElement('input');
  number.type = 'number';
  number.min = '1';
  number.step = '1';
  number.inputMode = 'numeric';
  number.value = String(value);
  const select = document.createElement('select');
  for (const name of IDLE_UNITS) {
    const option = document.createElement('option');
    option.value = name;
    select.append(option);
  }
  select.value = unit;
  const sync = () => {
    const amount = readWhole(number.value) ?? 2;
    for (const option of select.options) option.textContent = unitWord(amount, option.value);
  };
  const read = () => ({ value: readWhole(number.value), unit: select.value });
  for (const control of [number, select])
    control.addEventListener('input', () => {
      sync();
      onChange?.(read());
    });
  sync();
  return { number, select, read };
}
