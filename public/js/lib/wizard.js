import { validInstallFolder } from './install-folder.js';

const SESSION_NAME_MAX_LENGTH = 60;

export const MAPS = [
  { id: 'TheIsland_WP', name: 'The Island' },
  { id: 'TheCenter_WP', name: 'The Center' },
  { id: 'ScorchedEarth_WP', name: 'Scorched Earth' },
  { id: 'Ragnarok_WP', name: 'Ragnarok' },
  { id: 'Aberration_WP', name: 'Aberration' },
  { id: 'Extinction_WP', name: 'Extinction' },
  { id: 'Valguero_WP', name: 'Valguero' },
  { id: 'Genesis_WP', name: 'Genesis: Part 1' },
  { id: 'Astraeos_WP', name: 'Astraeos' },
  { id: 'LostColony_WP', name: 'Lost Colony' },
  { id: 'BobsMissions_WP', name: 'Club ARK', note: 'wizard.clubArkNote' },
];
// The catalog the server sends (GET /api/maps) replaces this built-in list once it has loaded, so a map
// added to the catalog shows its name everywhere. Until then the list above is used.
let loadedMaps = null;
export function setCatalogMaps(maps) {
  loadedMaps = Array.isArray(maps) ? maps : null;
}
// A custom map keeps its own id as its name.
export const mapName = (id) => (loadedMaps ?? MAPS).find((item) => item.id === id)?.name ?? id;
export const PRESETS = [
  { id: 'default', settings: {} },
  { id: 'relaxed', settings: { XPMultiplier: 2, TamingSpeedMultiplier: 3, HarvestAmountMultiplier: 2 } },
  { id: 'pve', settings: { ServerPVE: true } },
];
// The player limit is the -WinLiveMaxPlayers launch flag, checked by the server as 1 to 1000. It is not
// the INI MaxPlayers field, whose catalog range is narrower.
export const PLAYER_LIMIT = { min: 1, max: 1000, default: 70 };
// The same ranges findConflicts() in src/network/ports.js enforces; the game port leaves room for the peer port.
export const PORT_RANGE = { min: 1024, max: 65535, gameMax: 65534 };
export const MIN_FREE_BYTES = 30 * 1024 ** 3;
const errors = {
  name: 'badName',
  sessionName: 'badSessionName',
  map: 'badMap',
  maxPlayers: 'badPlayers',
  installPath: 'badPath',
};
export function validateMapId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_]+$/.test(id);
}
// The same folders the server's absolute() accepts: a drive root with either slash, or a UNC share.
export const isAbsolutePath = (p) =>
  typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p));
const isAbsolute = isAbsolutePath;
export function validateServerStep(values) {
  const result = {};
  if (
    typeof values.name !== 'string' ||
    !values.name.trim() ||
    values.name.trim().length > 64 ||
    /[\x00-\x1f]/.test(values.name)
  )
    result.name = errors.name;
  if (
    typeof values.sessionName !== 'string' ||
    !values.sessionName.trim() ||
    values.sessionName.length > SESSION_NAME_MAX_LENGTH ||
    /[?"\r\n]/.test(values.sessionName)
  )
    result.sessionName = errors.sessionName;
  if (!validateMapId(values.map)) result.map = errors.map;
  if (
    !Number.isInteger(values.maxPlayers) ||
    values.maxPlayers < PLAYER_LIMIT.min ||
    values.maxPlayers > PLAYER_LIMIT.max
  )
    result.maxPlayers = errors.maxPlayers;
  if (!values.installId && !validInstallFolder(values.installPath, values.installs, { allowUnc: true }))
    result.installPath = errors.installPath;
  return result;
}
export function validatePorts({ gamePort, queryPort, rconPort }) {
  const result = {};
  const valid = (port, max = PORT_RANGE.max) => Number.isInteger(port) && port >= PORT_RANGE.min && port <= max;
  if (!valid(gamePort, PORT_RANGE.gameMax)) result.gamePort = 'badGamePort';
  for (const [key, port] of [
    ['queryPort', queryPort],
    ['rconPort', rconPort],
  ])
    if (port !== null && port !== undefined && !valid(port)) result[key] = 'badPort';
  const values = [
    ['gamePort', gamePort],
    ['peerPort', valid(gamePort, PORT_RANGE.gameMax) ? gamePort + 1 : null],
    ['queryPort', queryPort],
    ['rconPort', rconPort],
  ];
  const seen = new Set();
  for (const [key, value] of values)
    if (value !== null && value !== undefined) {
      if (seen.has(value)) result[key === 'peerPort' ? 'gamePort' : key] = 'duplicatePort';
      seen.add(value);
    }
  return result;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function generatePassword(randomBytes, drawMore = (length) => crypto.getRandomValues(new Uint8Array(length))) {
  let out = '';
  let bytes = randomBytes;
  let index = 0;
  while (out.length < 20) {
    if (index >= bytes.length) {
      bytes = drawMore(40);
      index = 0;
    }
    const byte = bytes[index++];
    if (byte < 248) out += alphabet[byte % 62];
  }
  return out;
}
export function settingsBody({ adminPassword, joinPassword, presetId }) {
  const preset = PRESETS.find((item) => item.id === presetId) || PRESETS[0];
  return {
    ...preset.settings,
    ServerAdminPassword: adminPassword,
    ...(joinPassword ? { ServerPassword: joinPassword } : {}),
  };
}
export function createPlan(state) {
  const plan = [];
  if (!state.installId)
    plan.push({ step: 'install', method: 'POST', path: '/api/installs', body: { path: state.installPath } });
  plan.push({
    step: 'server',
    method: 'POST',
    path: '/api/servers',
    body: {
      installId: state.installId,
      name: state.name,
      sessionName: state.sessionName,
      map: state.map,
      maxPlayers: state.maxPlayers,
      gamePort: state.gamePort,
      queryPort: state.queryPort,
      rconPort: state.rconPort,
    },
  });
  plan.push({
    step: 'settings',
    method: 'PUT',
    path: `/api/servers/${state.serverId || ':id'}/settings`,
    body: settingsBody(state),
  });
  return plan;
}
