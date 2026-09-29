// Shown for a map with no picture of its own, and in place of any picture that fails to load.
export const GENERIC_MAP_ART = '/icons/map-generic.svg';

// Pictures that failed to load on this page, so a list that is drawn again does not ask for them again.
const failedArt = new Set();

// Where a map's picture comes from, or null when none should be requested. Official maps use Steam's
// picture, which loads in the browser and only when the host setting allows it. A mod's own picture is
// read from the server's install, so it is local and needs no setting.
export function mapPictureUrl(map, serverId, showArt) {
  if (!map?.id) return null;
  if (map.kind === 'official') return showArt ? `/api/maps/${encodeURIComponent(map.id)}/art` : null;
  if (
    map.kind === 'mod' &&
    serverId != null &&
    serverId !== '' &&
    Number.isInteger(Number(serverId)) &&
    Number(serverId) > 0
  )
    return `/api/servers/${Number(serverId)}/maps/${encodeURIComponent(map.id)}/art`;
  return null;
}

// The picture at Steam's 460:215 shape, or null when there is nothing to request. A picture that is
// blocked or fails to load becomes a plain panel with the map's name, never a broken image.
// With `generic`, a map with no picture, or one that fails, shows the generic picture instead.
export function mapPicture({ map, name, serverId, showArt, generic = false, eager = false }) {
  const url = mapPictureUrl(map, serverId, showArt);
  if (!url && !generic) return null;
  const frame = document.createElement('div');
  frame.className = 'map-art';
  const image = document.createElement('img');
  image.alt = name;
  image.loading = eager ? 'eager' : 'lazy';
  image.width = 460;
  image.height = 215;
  image.addEventListener('error', () => {
    if (url) failedArt.add(url);
    if (generic) {
      if (!image.src.endsWith(GENERIC_MAP_ART)) image.src = GENERIC_MAP_ART;
      return;
    }
    const panel = document.createElement('span');
    panel.className = 'map-art-fallback';
    panel.textContent = name;
    frame.replaceChildren(panel);
  });
  // The source is set after the listener, so even a failure reported at once reaches it.
  image.src = url && !failedArt.has(url) ? url : GENERIC_MAP_ART;
  frame.append(image);
  return frame;
}

// The picture beside a server in the rail. Official maps use Steam's picture when the host allows it, and
// a map missing from the catalog is tried as a mod map, whose picture comes from its mod download.
export function railPictureUrl(server, maps) {
  if (!maps) return GENERIC_MAP_ART;
  const official = maps.maps?.some((map) => map.id === server.map && map.kind === 'official');
  const url = mapPictureUrl({ id: server.map, kind: official ? 'official' : 'mod' }, server.id, maps.showArt);
  return url && !failedArt.has(url) ? url : GENERIC_MAP_ART;
}

// Records a picture that failed, so railPictureUrl stops offering it.
export function markArtFailed(url) {
  if (url && url !== GENERIC_MAP_ART) failedArt.add(url);
}
