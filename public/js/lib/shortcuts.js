import { stateTone } from './fleet-summary.js';

// Warnings sent to players before a restart that comes from the Restart all shortcut.
export const SHORTCUT_COUNTDOWN = [10, 5, 1];

// The action a home-screen shortcut asks for, from a link such as #/servers?action=restart-all.
export function shortcutAction(hash) {
  const match = String(hash ?? '').match(/^#\/servers\?(.*)$/);
  const action = match ? new URLSearchParams(match[1]).get('action') : null;
  return action === 'restart-all' || action === 'backup-all' ? action : null;
}

export function runningServers(servers = []) {
  return servers.filter((server) => stateTone(server) === 'running');
}

// Minutes read aloud: "10", "10 and 5", "10, 5, and 1".
export function listMarks(marks) {
  if (marks.length < 3) return marks.join(' and ');
  return `${marks.slice(0, -1).join(', ')}, and ${marks.at(-1)}`;
}
