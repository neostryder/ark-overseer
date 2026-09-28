# ARK Overseer

ARK Overseer is a web app for running ARK: Survival Ascended dedicated servers on a Windows PC. It installs and updates servers through SteamCMD, runs several of them on one machine, and keeps their settings, ports, backups and schedules in one place. It is in early development and has no release yet.

## Requirements

- Windows 10 or 11
- Node.js 26 or later
- PowerShell 7 (`pwsh`)

## Running it

Run `npm install`, then `npm start`, and open http://localhost:3310 on the same computer. The first visit sets the password, and that visit has to come from the computer running ARK Overseer.

The database, backups and SteamCMD live in the `data` folder next to the code. Set `OVERSEER_DATA` to keep them somewhere else, or `OVERSEER_PORT` to use another port.

## Gaming mode

If you play games on the same PC, turn on gaming mode on the This computer page. While a game runs, the servers drop to a lower priority and stay off the CPU cores set aside for the game, then go back to normal once it closes. Games started from Steam, Epic, GOG and similar launchers are found on their own, and you can list any others by program name.

## Running as a Windows service

As a service, ARK Overseer starts with Windows and keeps running when nobody is signed in. It runs as the built-in Network Service account through [shawl](https://github.com/mtkennerly/shawl), from its own copy of the app and its own Node and PowerShell under `C:\ProgramData\ARK Overseer`. The installer copies the checkout's last commit, so uncommitted changes never reach the service.

1. Download `shawl-v1.9.0-win64.zip` from the shawl releases page and `PowerShell-7.6.6-win-x64.zip` from the PowerShell releases page on GitHub, and put both in the `vendor` folder. The installer refuses either one if its SHA-256 does not match the published release.
2. In an administrator PowerShell, run `pwsh -File tools\service.ps1 install -Start`. Add `-GrantFolder <path>` for each server install folder that Network Service cannot already change, such as a Steam library. Run the install again with `-Force` to update the service to a newer commit, or after adding a server in a new install folder so the service can reach it.
3. Open http://localhost:3310.

`install -DryRun` prints every step without changing anything. `status` shows the service, and `uninstall` removes it and its runtime but keeps the database. The service writes its logs to `C:\ProgramData\ARK Overseer\logs`.

To update the service later, open ARK Overseer in a browser on the computer it runs on, go to This computer, and choose Update. Windows asks for administrator approval, the service installs the checkout's last commit again, and the page reloads once it's back. If the update fails, the page says why, and the full log is in the service's logs folder. A service installed before this button existed needs one more install from an administrator PowerShell before the button appears.

A service can't show the Windows administrator prompt, so in service mode the Network page gives you the firewall script as a file to run as an administrator. Stopping the service tells each running ARK server to save the world and leaves it running, and the service picks those servers back up when it starts again.

## Development

Run the tests with `npm test`, check formatting with `npm run format:check`, and check the settings catalog with `npm run check`.

## License

ARK Overseer is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). The full text is in [LICENSE](LICENSE). You can use it, change it and share it at no cost, for your own servers or anyone else's. If you change it and let other people use your changed version over a network, such as a hosting panel your customers sign in to, the AGPL requires you to offer those people your changed source code.

Commercial licenses are also available for anyone who wants to run a changed version without publishing the changes, such as a game hosting company building ARK Overseer into its own panel. To ask about one, contact neostryder on GitHub.
