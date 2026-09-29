import { STRINGS } from '../strings.js';

export const SCOPES = ['everything', 'world', 'settings', 'players'];
// The countdown a restore gives when the server has no restart schedule of its own.
export const DEFAULT_MARKS = [5, 1];
const SAFETY = new Set(['pre_restore', 'pre_switch']);
const DELETABLE = new Set(['manual', 'scheduled']);
const WORLD_SCOPES = new Set(['everything', 'world', 'players']);

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// A backup ARK Overseer took itself, before it replaced files, is marked as a safety backup.
export const isSafety = (reason) => SAFETY.has(reason);
// The same two kinds the server lets be deleted.
export const canDelete = (reason) => DELETABLE.has(reason);

const pad = (n) => String(n).padStart(2, '0');
// The day a time falls on in the viewer's own time zone, as YYYY-MM-DD.
export function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Backups grouped by the day they were taken, newest day first and newest backup first within a day.
export function groupByDay(backups) {
  const ordered = [...backups].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const groups = [];
  for (const item of ordered) {
    const key = dayKey(item.created_at);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, date: new Date(item.created_at), items: [item] });
  }
  return groups;
}

// Which restore scopes a backup can serve, from what the details route reports it holds.
export function availableScopes(details) {
  const world = (details?.worldFiles ?? 0) > 0,
    settings = (details?.settingsFiles ?? 0) > 0,
    players = (details?.profiles?.length ?? 0) + (details?.tribes?.length ?? 0) > 0;
  return { everything: world || settings, world, settings, players: world && players };
}

// The scope to tick first: Everything when the backup has it, else the first that is possible.
export function firstScope(available) {
  return SCOPES.find((scope) => available[scope]) ?? 'everything';
}

// The player and tribe files whose id holds the text typed into the filter, ignoring letter case.
export function filterPlayers(list, query) {
  const wanted = String(query ?? '')
    .trim()
    .toLowerCase();
  return wanted ? list.filter((item) => item.id.toLowerCase().includes(wanted)) : list;
}

// A backup can hold thousands of player files, so a column draws this many at most.
export const PICKER_LIMIT = 200;

// The rows a column draws: the first PICKER_LIMIT of the ones that match. `total` is how many match.
export function limitRows(list, limit = PICKER_LIMIT) {
  return { rows: list.slice(0, limit), total: list.length };
}

export const confirmLabel = (scope) => STRINGS.backups.confirm[scope] ?? STRINGS.backups.confirm.everything;
export const includesWorld = (scope) => WORLD_SCOPES.has(scope);

// "5 and 1 minutes", "10, 5 and 1 minutes", "1 minute".
export function describeMarks(marks) {
  const list = marks?.length ? marks : DEFAULT_MARKS;
  const text =
    list.length === 1 ? String(list[0]) : `${list.slice(0, -1).join(', ')}${STRINGS.backups.marksJoin}${list.at(-1)}`;
  return fill(list.length === 1 && list[0] === 1 ? STRINGS.backups.minuteMark : STRINGS.backups.minuteMarks, {
    list: text,
  });
}

// The countdown a restore of a running server gives: the server's restart schedule if it has one.
export function countdownMarks(schedules) {
  const marks = schedules?.find((item) => item.kind === 'restart')?.options?.countdownMinutes;
  return Array.isArray(marks) && marks.length ? marks : DEFAULT_MARKS;
}

// What the restore dialog tells the user before they confirm, one sentence each.
export function restoreNotes({ scope, running, marks, backupMap, currentMap, mapLabel, currentLabel }) {
  const b = STRINGS.backups;
  const notes = [fill(b.replaces[scope], { map: mapLabel })];
  notes.push(b.safetyNote);
  notes.push(running ? fill(b.willStop, { marks: describeMarks(marks) }) : b.stopped);
  if (running) notes.push(b.rollbackNote);
  if (
    includesWorld(scope) &&
    backupMap &&
    currentMap &&
    String(backupMap).toLowerCase() !== String(currentMap).toLowerCase()
  )
    notes.push(fill(b.differentMap, { map: mapLabel, current: currentLabel }));
  return notes;
}

// The number of differences in a comparison, for the line above it.
export function countDifferences(diff) {
  let count = 0;
  for (const file of diff?.files ?? []) {
    if (!file.sections.length) count++;
    for (const section of file.sections)
      count += section.added.length + section.removed.length + section.changed.length;
  }
  return count;
}
