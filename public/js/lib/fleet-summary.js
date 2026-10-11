// How a server's observed state reads at a glance: running, busy (starting or stopping), bad (crashed or held
// back by the crash guard), or idle (stopped, exited, or not known yet).
export function stateTone(server) {
  const state = server?.status?.observedState;
  if (server?.status?.crashLoop || state === 'crashed') return 'bad';
  if (state === 'running') return 'running';
  if (state === 'starting' || state === 'stopping') return 'busy';
  return 'idle';
}

export function fleetSummary(servers = []) {
  const counts = { total: servers.length, running: 0, busy: 0, bad: 0, idle: 0 };
  for (const server of servers) counts[stateTone(server)] += 1;
  return counts;
}

// The share of the ring that is filled, as a whole number from 0 to 100.
export function ringFill({ running, total }) {
  return total > 0 ? Math.round((running / total) * 100) : 0;
}
