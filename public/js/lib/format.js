import { STRINGS } from '../strings.js';
export function stateName(state) {
  return STRINGS.status[state] || STRINGS.status.unknown;
}
export function relativeTime(value, now = Date.now()) {
  const date = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(date)) return STRINGS.status.unknown;
  const seconds = Math.max(0, Math.round((now - date) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
export function byteSize(bytes) {
  if (!Number.isFinite(Number(bytes))) return STRINGS.status.unknown;
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024,
    i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
export function jobSummary(job) {
  const target = job?.serverId
    ? `${STRINGS.jobs.server} ${job.serverId}`
    : job?.installId
      ? `${STRINGS.jobs.install} ${job.installId}`
      : '';
  return [STRINGS.jobs.kinds[job?.kind] || job?.kind || STRINGS.jobs.title, target].filter(Boolean).join(' - ');
}
export function jobState(state) {
  return STRINGS.jobs.states[state] || state || STRINGS.status.unknown;
}
