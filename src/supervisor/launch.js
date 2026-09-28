import path from 'node:path';

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
  return { exePath: paths.exePath, cwd: paths.exeDir, args };
}
