# ARK Overseer

ARK Overseer is a Windows server manager for ARK: Survival Ascended dedicated servers, in early development. When it is finished, it will install and update servers through SteamCMD, run several of them on one machine, and keep their settings, backups and schedules in one place. So far it has its database layer and nothing that runs a server.

## Requirements

Node.js 26 or later. The database uses Node's built-in `node:sqlite` module, so there are no npm dependencies yet.

## Development

Run the tests with `npm test`.

## License

GPL-3.0. The full text is in [LICENSE](LICENSE).
