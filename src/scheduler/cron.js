const SPECS = [
  ['Minute', 0, 59],
  ['Hour', 0, 23],
  ['Day of month', 1, 31],
  ['Month', 1, 12],
  ['Day of week', 0, 7],
];
export const MESSAGES = {
  fields: 'Cron must have five fields.',
  range: (name, min, max) => `${name} must be from ${min} to ${max}.`,
};

function parseField(text, [name, min, max]) {
  const fail = () => {
    throw new Error(MESSAGES.range(name, min, max === 7 && name === 'Day of week' ? 6 : max));
  };
  const values = new Set();
  const any = text === '*';
  for (const part of text.split(',')) {
    const stepParts = part.split('/');
    if (stepParts.length > 2) fail();
    const step = stepParts.length === 2 ? Number(stepParts[1]) : 1;
    if (!Number.isInteger(step) || step < 1) fail();
    const base = stepParts[0];
    let start, end;
    if (base === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(base)) {
      // In standard cron "5/15" means from 5 to the end of the range, every 15.
      start = Number(base);
      end = stepParts.length === 2 ? max : start;
    } else {
      const range = base.match(/^(\d+)-(\d+)$/);
      if (!range) fail();
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (start < min || end > max || start > end) fail();
    for (let value = start; value <= end; value += step) values.add(name === 'Day of week' && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), any };
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error(MESSAGES.fields);
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(MESSAGES.fields);
  const parsed = fields.map((field, i) => parseField(field, SPECS[i]));
  return {
    minutes: parsed[0].values,
    hours: parsed[1].values,
    days: parsed[2].values,
    months: parsed[3].values,
    weekdays: parsed[4].values,
    dayOfMonthAny: parsed[2].any,
    dayOfWeekAny: parsed[4].any,
  };
}

function matchesDay(date, cron) {
  const dom = cron.days.includes(date.getDate()),
    dow = cron.weekdays.includes(date.getDay());
  if (!cron.dayOfMonthAny && !cron.dayOfWeekAny) return dom || dow;
  return (cron.dayOfMonthAny || dom) && (cron.dayOfWeekAny || dow);
}

export function nextRun(expr, afterMs) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;
  const after = new Date(afterMs);
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let day = 0; day <= 366; day++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    if (!cron.months.includes(date.getMonth() + 1) || !matchesDay(date, cron)) continue;
    for (const hour of cron.hours)
      for (const minute of cron.minutes) {
        const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
        if (
          candidate.getDate() !== date.getDate() ||
          candidate.getHours() !== hour ||
          candidate.getMinutes() !== minute
        )
          continue;
        if (candidate.getTime() > afterMs) return candidate.getTime();
      }
  }
  return null;
}

export function describeCron(expr) {
  try {
    const p = parseCron(expr),
      fields = expr.trim().split(/\s+/),
      minute = p.minutes.length === 1 ? p.minutes[0] : null;
    if (minute === null) return null;
    if (fields[2] === '*' && fields[3] === '*' && fields[4] === '*' && p.hours.length === 1)
      return { kind: 'daily', hour: p.hours[0], minute };
    const interval = fields[1].match(/^\*\/(\d+)$/);
    if (
      fields[2] === '*' &&
      fields[3] === '*' &&
      fields[4] === '*' &&
      interval &&
      Number(interval[1]) >= 1 &&
      Number(interval[1]) <= 23
    )
      return { kind: 'everyHours', hours: Number(interval[1]), minute };
    if (fields[2] === '*' && fields[3] === '*' && p.weekdays.length === 1 && p.hours.length === 1)
      return { kind: 'weekly', weekday: p.weekdays[0], hour: p.hours[0], minute };
  } catch {}
  return null;
}
