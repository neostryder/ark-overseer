const WHOLE = /^\d{1,2}$/;
const inRange = (text, min, max) => WHOLE.test(text) && Number(text) >= min && Number(text) <= max;

// The three shapes the Automation page can show. Anything else returns null and is kept as raw cron.
export function cronToPicker(cron) {
  const f = String(cron ?? '')
    .trim()
    .split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || !inRange(f[0], 0, 59)) return null;
  const minute = Number(f[0]);
  const every = f[1].match(/^\*\/(\d{1,2})$/);
  if (every && f[4] === '*' && inRange(every[1], 1, 23)) return { type: 'hourly', minute, hours: Number(every[1]) };
  if (!inRange(f[1], 0, 23)) return null;
  const hour = Number(f[1]);
  if (f[4] === '*') return { type: 'daily', hour, minute };
  if (inRange(f[4], 0, 7)) return { type: 'weekly', hour, minute, weekday: Number(f[4]) % 7 };
  return null;
}

// Returns null for anything out of range, so a bad picker value never reaches the server as cron.
export function pickerToCron({ type, hour, minute, hours, weekday }) {
  const ok = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (!ok(minute, 0, 59)) return null;
  if (type === 'hourly') return ok(hours, 1, 23) ? `${minute} */${hours} * * *` : null;
  if (!ok(hour, 0, 23)) return null;
  if (type === 'daily') return `${minute} ${hour} * * *`;
  if (type === 'weekly') return ok(weekday, 0, 6) ? `${minute} ${hour} * * ${weekday}` : null;
  return null;
}

// "10, 5, 1" becomes [10, 5, 1]. The server wants 1 to 5 whole minutes from 1 to 60, each smaller
// than the one before, so anything else returns null here rather than a 400 later.
export function parseCountdown(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 5 || !parts.every((part) => WHOLE.test(part))) return null;
  const marks = parts.map(Number);
  return marks.every((mark, i) => mark >= 1 && mark <= 60 && (i === 0 || marks[i - 1] > mark)) ? marks : null;
}
