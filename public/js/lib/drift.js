import { STRINGS } from '../strings.js';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// What a difference is called when a choice is made about it. Case is ignored, as it is in the files.
export const choiceKey = (difference) =>
  [difference.file, difference.section, difference.key].map((part) => String(part).toLowerCase()).join('|');

export const isWholeFile = (difference) => difference.key === '';

// The differences grouped by file, then by section, in the order the server sent them. A whole file that is new,
// gone or different has no sections and carries the difference itself as `whole`.
export function groupDifferences(differences) {
  const files = [];
  const byFile = new Map();
  for (const difference of differences ?? []) {
    let file = byFile.get(difference.file.toLowerCase());
    if (!file) {
      file = { file: difference.file, whole: null, sections: [] };
      byFile.set(difference.file.toLowerCase(), file);
      files.push(file);
    }
    if (isWholeFile(difference)) {
      file.whole = difference;
      continue;
    }
    let section = file.sections.find((item) => item.name.toLowerCase() === difference.section.toLowerCase());
    if (!section) {
      section = { name: difference.section, items: [] };
      file.sections.push(section);
    }
    section.items.push(difference);
  }
  return files;
}

// How many settings and files differ, for the banner.
export function bannerText(count) {
  const d = STRINGS.drift;
  return count === 1 ? d.bannerOne : fill(d.bannerMany, { count });
}

const stamp = (iso) => new Date(iso).toLocaleString();
// "Found 2026-09-28 10:00." or, for a change found when the server stopped, "..., when the server last shut down."
export function foundText(detectedAt, afterStop) {
  const d = STRINGS.drift;
  return fill(afterStop ? d.foundAfterStop : d.found, { time: stamp(detectedAt) });
}

// What each side of one difference shows. A password says only that it changed.
export function describeDifference(difference) {
  const d = STRINGS.drift;
  const kind = d.kinds[difference.kind] ?? difference.kind;
  if (difference.secret) return { kind, secret: true, note: d.secretChanged, baseline: null, current: null };
  if (isWholeFile(difference)) return { kind, secret: false, note: null, baseline: null, current: null };
  return {
    kind,
    secret: false,
    note: null,
    baseline: difference.baseline ?? d.valueNone,
    current: difference.live ?? d.valueNone,
    baselineMissing: difference.baseline === null,
    currentMissing: difference.live === null,
  };
}

// ---- choices, kept as { [choiceKey]: 'baseline' | 'live' } ----

export function setChoice(choices, difference, value) {
  return { ...choices, [choiceKey(difference)]: value };
}
export function setAllChoices(differences, value) {
  return Object.fromEntries((differences ?? []).map((difference) => [choiceKey(difference), value]));
}
// Choices for settings that are still listed; one for a setting that no longer differs is dropped.
export function keepChoices(differences, choices) {
  const listed = new Set((differences ?? []).map(choiceKey));
  return Object.fromEntries(Object.entries(choices ?? {}).filter(([key]) => listed.has(key)));
}
export function choicesLeft(differences, choices) {
  return (differences ?? []).filter((difference) => !choices?.[choiceKey(difference)]).length;
}
export const allChosen = (differences, choices) =>
  (differences ?? []).length > 0 && choicesLeft(differences, choices) === 0;

// The choices as the server takes them.
export function choiceList(differences, choices) {
  return (differences ?? []).map((difference) => ({
    file: difference.file,
    section: difference.section,
    key: difference.key,
    choice: choices?.[choiceKey(difference)],
  }));
}

export function choiceSummary(differences, choices) {
  const left = choicesLeft(differences, choices);
  if (!left) return STRINGS.drift.choicesDone;
  return left === 1 ? STRINGS.drift.choicesLeftOne : fill(STRINGS.drift.choicesLeft, { count: left });
}

// Which of the three buttons can be pressed. Each one starts a job or changes the files, so none can while a job
// runs for the server or the page holds settings that are not saved yet.
export function actionStates({ differences, choices, busy, blocked }) {
  const off = Boolean(busy || blocked || !(differences ?? []).length);
  return { adopt: !off, revert: !off, merge: !off && allChosen(differences, choices) };
}

// The job kind that puts values back. Only this job is followed on the Settings page: a backup or a map switch that is
// running for the server is another job's news, and it makes the buttons here wait rather than report anything.
export const RESOLVE_JOB_KIND = 'server.settings_resolve';
const LIVE_STATES = ['queued', 'running'];
export const findResolveJob = (jobs) =>
  (jobs ?? []).find((job) => job.kind === RESOLVE_JOB_KIND && LIVE_STATES.includes(job.state)) ?? null;

// True while this page follows its own job, or the server says another job owns the files.
export const isBusy = ({ following, state }) => Boolean(following || state?.busy);

// The note a running server gets under the buttons that change files.
export const runningNote = (running) => (running ? STRINGS.drift.runningNote : '');
