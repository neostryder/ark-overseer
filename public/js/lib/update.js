// The update link opens a program on the computer the browser runs on. A page opened at another address,
// such as through Cloudflare, still offers the button, with a note about where it works.
export function isLocalPage(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}
export const shortCommit = (commit) => (typeof commit === 'string' ? commit.slice(0, 7) : null);
// A new start time means the service came back as a new process, which is the update finishing.
export function updateFinished(before, after) {
  return Boolean(before?.startedAt && after?.startedAt && after.startedAt !== before.startedAt);
}

export const UPDATE_SOURCES = ['checkout', 'github'];
export const UPDATE_CHANNELS = ['stable', 'beta', 'edge'];
export const UPDATE_PROGRESS_STAGES = [
  'requested',
  'checking',
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'done',
  'failed',
];
export function updateProgressStage(progress) {
  return progress && (UPDATE_PROGRESS_STAGES.includes(progress.stage) || progress.stage === 'failed')
    ? progress.stage
    : null;
}
export function updateChecklist(progress) {
  const active = updateProgressStage(progress);
  return UPDATE_PROGRESS_STAGES.map((stage) => ({ stage, current: stage === active }));
}

export function createUpdatePoller({
  fetchVersion,
  before,
  startedAt,
  onState,
  onNoStart,
  onFinish,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let seenProgress = false;
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    if (!seenProgress && now() - startedAt >= 60000) {
      stopped = true;
      clearIntervalFn(timer);
      onNoStart();
      return;
    }
    const after = await fetchVersion();
    if (stopped) return;
    if (!after) {
      onState({ kind: 'restart', after: null, progress: null });
      return;
    }
    const candidate = after.progress;
    const progress = candidate && Date.parse(candidate.startedAt) >= startedAt - 3000 ? candidate : null;
    if (progress) seenProgress = true;
    onState({ kind: progress ? 'progress' : 'waiting', after, progress });
    if (progress?.stage === 'done' || progress?.stage === 'failed' || updateFinished(before, after)) {
      stopped = true;
      clearIntervalFn(timer);
      onFinish(after, progress);
    }
  };
  const timer = setIntervalFn(() => void poll(), 2000);
  return {
    poll,
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
export function updateSources(info) {
  return info?.package === true ? ['github'] : UPDATE_SOURCES;
}

// The label shown for a release or a commit: the tag, or the short commit id for Edge.
export function releaseLabel(item) {
  if (!item) return null;
  return item.tag ?? (item.commit ? shortCommit(item.commit) : null);
}

// The newest release on the checked channel, or null when the check failed or has not run.
export function newestRelease(check) {
  return check?.ok ? (check.newest ?? null) : null;
}

// The earlier releases to go back to. Stable and Beta have them; Edge never does.
export function earlierReleases(check) {
  return check?.ok && Array.isArray(check.history) ? check.history : [];
}

// What the Updates card shows for the chosen source and channel. The notes are plain text from the
// release body, never markup.
export function updateCard({ source, channel, check, checkout }) {
  if (source === 'checkout') {
    const failed = checkout && checkout.ok === false;
    const commit = checkout?.ok ? checkout.commit : null;
    return {
      source: 'checkout',
      channel: null,
      message: failed ? checkout.message : null,
      newest: commit
        ? { label: shortCommit(commit), notes: null, commit, date: checkout.date ?? null, tag: null }
        : null,
      history: [],
    };
  }
  const newest = newestRelease(check);
  return {
    source: 'github',
    channel,
    message: check && check.ok === false ? check.message : null,
    newest: newest
      ? {
          label: newest.kind === 'edge' ? (newest.version ?? releaseLabel(newest)) : releaseLabel(newest),
          notes: newest.body ?? null,
          tag: newest.tag ?? null,
          commit: newest.commit ?? null,
          date: newest.publishedAt ?? null,
          size: newest.asset?.size ?? null,
        }
      : null,
    history: earlierReleases(check).map((item) => ({
      label: releaseLabel(item),
      tag: item.tag ?? null,
      commit: item.commit ?? null,
      date: item.publishedAt ?? null,
    })),
  };
}
