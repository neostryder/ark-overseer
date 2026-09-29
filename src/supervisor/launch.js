import path from 'node:path';

export const MESSAGES = { badCluster: 'Cluster launch settings are invalid.' };

// Node joins verbatim Windows arguments with spaces. Quote ordinary arguments using Windows
// backslash rules, but preserve the quotes after ClusterDirOverride= for Unreal's parser.
export function buildWindowsCommandLine(args) {
  const quote = (arg) => {
    if (!/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/, '$1$1')}"`;
  };
  return args.map((arg) => (arg.startsWith('-ClusterDirOverride="') ? arg : quote(arg))).join(' ');
}

export function serverPaths(installPath) {
  const exePath = path.win32.join(installPath, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe');
  const exeDir = path.win32.dirname(exePath);
  const configDir = path.win32.join(installPath, 'ShooterGame', 'Saved', 'Config', 'WindowsServer');
  return {
    exePath,
    exeDir,
    configDir,
    gameUserSettingsPath: path.win32.join(configDir, 'GameUserSettings.ini'),
    gameIniPath: path.win32.join(configDir, 'Game.ini'),
    logPath: path.win32.join(installPath, 'ShooterGame', 'Saved', 'Logs', 'ShooterGame.log'),
  };
}

export function buildLaunch(server, install) {
  // A "?" starts a new key=value pair in the connect string, and a double quote would break the
  // quoting Windows applies to the argument, so either one would corrupt the launch.
  if (/[?"]/.test(String(server.session_name)) || /[?"]/.test(String(server.map)))
    throw new TypeError('Map and session name cannot contain ? or ".');
  const settings =
    typeof server.settings_json === 'string' ? JSON.parse(server.settings_json) : (server.settings_json ?? {});
  const mods = settings.mods ?? [];
  if (!Array.isArray(mods) || mods.some((id) => !/^\d+$/.test(String(id))))
    throw new TypeError('Mod ids must contain digits only');
  const paths = serverPaths(install.path);
  const args = [`${server.map}?listen?SessionName=${server.session_name}`, `-port=${server.game_port}`];
  if (server.query_port !== null && server.query_port !== undefined) args.push(`-QueryPort=${server.query_port}`);
  args.push(`-WinLiveMaxPlayers=${server.max_players}`, '-log');
  if (mods.length) args.push(`-mods=${mods.join(',')}`);
  if (settings.disableBattlEye) args.push('-NoBattlEye');
  if (server.cluster_key && server.shared_dir) {
    if (!/^[A-Za-z0-9]{16}$/.test(server.cluster_key) || /["\r\n]/.test(server.shared_dir))
      throw new TypeError(MESSAGES.badCluster);
    args.push(`-clusterid=${server.cluster_key}`, `-ClusterDirOverride="${server.shared_dir}"`);
  }
  return { exePath: paths.exePath, cwd: paths.exeDir, args };
}
