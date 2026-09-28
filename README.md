# ARK Overseer

ARK Overseer is a web app for running ARK: Survival Ascended dedicated servers on a Windows PC. It installs and updates servers through SteamCMD, runs several of them on one machine, and keeps their settings, ports, backups and schedules in one place. It is in early development and has no release yet.

## Requirements

- Windows 10 or 11
- Node.js 26 or later
- PowerShell 7 (`pwsh`)

## Running it

Run `npm install`, then `npm start`, and open http://localhost:3310 on the same computer. The first visit sets the password, and that visit has to come from the computer running ARK Overseer.

The database, backups and SteamCMD live in the `data` folder next to the code. Set `OVERSEER_DATA` to keep them somewhere else, or `OVERSEER_PORT` to use another port.

## Running as a Windows service

As a service, ARK Overseer starts with Windows and keeps running when nobody is signed in. It runs as the built-in Network Service account through [shawl](https://github.com/mtkennerly/shawl), from its own copy of the app and its own Node and PowerShell under `C:\ProgramData\ARK Overseer`. The installer copies the checkout's last commit, so uncommitted changes never reach the service.

1. Download `shawl-v1.9.0-win64.zip` from the shawl releases page and `PowerShell-7.6.6-win-x64.zip` from the PowerShell releases page on GitHub, and put both in the `vendor` folder. The installer refuses either one if its SHA-256 does not match the published release.
2. In an administrator PowerShell, run `pwsh -File tools\service.ps1 install -Start`. Add `-GrantFolder <path>` for each server install folder that Network Service cannot already change, such as a Steam library. Run the install again with `-Force` to update the service to a newer commit, or after adding a server in a new install folder so the service can reach it.
3. Open http://localhost:3310.

`install -DryRun` prints every step without changing anything. `status` shows the service, and `uninstall` removes it and its runtime but keeps the database. The service writes its logs to `C:\ProgramData\ARK Overseer\logs`.

A service can't show the Windows administrator prompt, so in service mode the Network page gives you the firewall script as a file to run as an administrator. Stopping the service tells each running ARK server to save the world and leaves it running, and the service picks those servers back up when it starts again.

## Development

Run the tests with `npm test`, check formatting with `npm run format:check`, and check the settings catalog with `npm run check`.

## License

GPL-3.0. The full text is in [LICENSE](LICENSE).
