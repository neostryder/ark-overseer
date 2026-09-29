// The update link opens a program on the computer the browser runs on, so the Update button is offered
// only when the page is open on the server's own computer.
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
          label: releaseLabel(newest),
          notes: newest.body ?? null,
          tag: newest.tag ?? null,
          commit: newest.commit ?? null,
          date: newest.publishedAt ?? null,
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
