# ARK Overseer

ARK Overseer is a web app for running ARK: Survival Ascended dedicated servers on a Windows PC. It installs and updates servers through SteamCMD, runs several side by side, and keeps their settings, ports, backups and schedules in one place. You open it in a browser on the same PC, or from a phone or another computer on your network.

Each server has its own overview with Start, Stop and Restart, a settings page for every documented option (searchable by meaning, so "make dinos grow up faster" finds Baby Mature Speed Multiplier), and a network page that lists the ports and the Windows Firewall rules they need. You can switch a server to another map, keep named settings snapshots, take and restore backups, and clone, move, remove or bulk-manage servers. Clusters let players carry survivors and creatures between servers. Restarts, backups and updates run on a schedule and warn players in game first.

## Install

You need Windows 10 or 11, 64-bit. Nothing else has to be installed first.

1. Download the newest `ark-overseer-<version>-win-x64.zip` from the [releases page](https://github.com/neostryder/ark-overseer/releases).
2. Unpack it anywhere and double-click **Install ARK Overseer**. Windows may warn that the file comes from an unknown publisher, because the installer isn't code-signed. Choose More info, then Run anyway. Windows then asks for administrator approval once.
3. On the same PC, open http://localhost:3310 and set a password. The first password can only be set from the PC that runs ARK Overseer.
4. The setup wizard walks you through creating your first server, or importing one you already run.

ARK Overseer runs as a Windows service, so it starts with Windows and keeps running when nobody is signed in. It brings its own copy of Node and PowerShell 7. Its database, backups and logs live in `C:\ProgramData\ARK Overseer`, and you can delete the unpacked folder after the install finishes.

To remove it, double-click **Uninstall ARK Overseer**. It asks before it touches your data.

## Updating

Open ARK Overseer on the PC that runs it, go to **This computer** and choose Update. Windows asks for administrator approval, the service installs the new version and restarts, and the page reloads when it's back. Pick the Stable, Beta or Edge channel, read the release notes before you update, and go back to an earlier release if a new one causes trouble. If an update fails, the previous version is put back.

## Reaching it from other devices

Other devices on your network can open `http://<the PC's name>:3310`, but Windows Firewall blocks them until you allow the port. In an administrator PowerShell:

```powershell
netsh advfirewall firewall add rule name="ARK Overseer" dir=in action=allow protocol=TCP localport=3310 profile=private
```

Sign in with the same password. Passkeys work on the PC itself, and on other devices only over HTTPS.

## Behind Cloudflare Access

If you publish ARK Overseer on a domain protected by Cloudflare Access, enter your Access team domain, the application's AUD tag and the public address on the This computer page. A request that carries a valid Access token then signs in without the password prompt. Every token is checked again on every request, and the site and address checks still apply. The first password is still set on the PC itself.

## Running from source

You need Node.js 26 or later, PowerShell 7 and Git. Run `npm install`, then `npm start`, and open http://localhost:3310 on the same computer. The database, backups and SteamCMD live in the `data` folder next to the code. Set `OVERSEER_DATA` to keep them somewhere else, or `OVERSEER_PORT` to use another port.

Run the tests with `npm test`, check formatting with `npm run format:check`, and check the settings catalog with `npm run check`. `node tools/build-release.js` builds the release zip, and `tools\service.ps1 install` installs a checkout as the service.

## Contributing

Bug reports and feature requests are welcome as issues. Pull requests need a signed contributor agreement first; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

ARK Overseer is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). The full text is in [LICENSE](LICENSE). You can use it, change it and share it at no cost, for your own servers or anyone else's. If you change it and let other people use your changed version over a network, such as a hosting panel your customers sign in to, the AGPL requires you to offer those people your changed source code.

Commercial licenses are also available for anyone who wants to run a changed version without publishing the changes, such as a game hosting company building ARK Overseer into its own panel. To ask about one, contact neostryder on GitHub. Every release zip includes a `THIRD_PARTY_NOTICES.md` file with the licenses of the software bundled in it.
