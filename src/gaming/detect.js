export const LAUNCHERS = [
  'steam.exe',
  'EpicGamesLauncher.exe',
  'GalaxyClient.exe',
  'Battle.net.exe',
  'EADesktop.exe',
  'upc.exe',
  'UbisoftConnect.exe',
  'RiotClientServices.exe',
];
export const HELPERS = [
  'steamwebhelper.exe',
  'steamservice.exe',
  'steamerrorreporter.exe',
  'gameoverlayui.exe',
  'gameoverlayui64.exe',
  'streaming_client.exe',
  'EpicWebHelper.exe',
  'EpicOnlineServicesHost.exe',
  'UnrealCEFSubProcess.exe',
  'CrashReportClient.exe',
  'GalaxyClient Helper.exe',
  'GalaxyCommunication.exe',
  'GOG Galaxy Notifications Renderer.exe',
  'Agent.exe',
  'Battle.net Helper.exe',
  'EABackgroundService.exe',
  'EADesktop Helper.exe',
  'QtWebEngineProcess.exe',
  'UplayWebCore.exe',
  'UbisoftConnectWebCore.exe',
  'RiotClientUx.exe',
  'RiotClientUxRender.exe',
  'RiotClientCrashHandler.exe',
  'conhost.exe',
  'cmd.exe',
  'WerFault.exe',
  'BlizzardBrowser.exe',
  'crashpad_handler.exe',
  'UnityCrashHandler64.exe',
  'UnityCrashHandler32.exe',
  'Battle.net Update Agent.exe',
  'EpicGamesLauncher-Win64-Shipping.exe',
  'vcredist_x64.exe',
  'vcredist_x86.exe',
  'VC_redist.x64.exe',
  'VC_redist.x86.exe',
  'DXSETUP.exe',
  'dxwebsetup.exe',
  'UE4PrereqSetup_x64.exe',
  'UEPrereqSetup_x64.exe',
  ...LAUNCHERS,
];
// Helpers a game may be started through; the walk steps over these but not over other helpers.
const SHIMS = new Set(['cmd.exe']);
const key = (name) => String(name ?? '').toLowerCase();
export function detectGames(processes, { games = [], ignore = [] } = {}) {
  const rows = processes.map((p) => ({ ...p, name: String(p.name ?? ''), k: key(p.name) }));
  const byPid = new Map(rows.map((p) => [Number(p.pid), p]));
  const launchers = new Set(LAUNCHERS.map(key));
  const helpers = new Set(HELPERS.map(key));
  const own = new Set(games.map(key));
  const ignored = new Set(ignore.map(key));
  const found = new Map();
  const add = (name) => {
    if (!found.has(key(name))) found.set(key(name), name);
  };
  for (const process of rows) {
    if (ignored.has(process.k) || process.k === 'arkascendedserver.exe') continue;
    if (own.has(process.k)) {
      add(process.name);
      continue;
    }
    // A game is started by a launcher directly, or through up to two steps of its own small launcher
    // or a cmd.exe shim. A launcher's helpers, and anything a helper starts, are not games, and neither
    // is an overlay or console window a game opens.
    if (helpers.has(process.k)) continue;
    let current = byPid.get(Number(process.parentPid));
    for (let depth = 0; current && depth < 3; depth++) {
      if (launchers.has(current.k)) {
        add(process.name);
        break;
      }
      if (helpers.has(current.k) && !SHIMS.has(current.k)) break;
      current = byPid.get(Number(current.parentPid));
    }
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
