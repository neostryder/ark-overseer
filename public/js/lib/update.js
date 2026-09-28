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
