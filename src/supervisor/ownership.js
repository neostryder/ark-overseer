import path from 'node:path';

// Picks the one ArkAscendedServer.exe that belongs to a server: the same executable, started with that
// server's game port. Anything other than exactly one match adopts nothing, because guessing between
// two servers is how stopping one would take down the other.
export function pickOwnedProcess(processes, exePath, gamePort) {
  const wanted = path.resolve(exePath).toLowerCase();
  const port = `-port=${gamePort}`.toLowerCase();
  const matches = (processes ?? []).filter(
    (item) =>
      item &&
      typeof item.exePath === 'string' &&
      path.resolve(item.exePath).toLowerCase() === wanted &&
      typeof item.commandLine === 'string' &&
      item.commandLine.toLowerCase().split(/\s+/).includes(port),
  );
  if (matches.length !== 1) return null;
  return { pid: matches[0].pid, startedAt: matches[0].startedAt };
}

// A pid alone is not proof of ownership: Windows reuses pids, so after a crash the number can belong to
// an unrelated process. The executable path and the start time have to match too.
export function isSameProcess(record, info, toleranceMs = 2000) {
  if (
    !record ||
    !info ||
    record.pid !== info.pid ||
    typeof record.exePath !== 'string' ||
    typeof info.exePath !== 'string'
  )
    return false;
  if (path.resolve(record.exePath).toLowerCase() !== path.resolve(info.exePath).toLowerCase()) return false;
  if (record.startedAt && info.startedAt)
    return Math.abs(Date.parse(record.startedAt) - Date.parse(info.startedAt)) <= toleranceMs;
  return true;
}

// ConvertTo-Json renders a CIM datetime as "/Date(1727000000000)/".
export function normalizeCimDate(value) {
  const match = typeof value === 'string' && value.match(/\/Date\((\d+)\)\//);
  if (match) return new Date(Number(match[1])).toISOString();
  return typeof value === 'string' ? value : null;
}
