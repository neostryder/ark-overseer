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
export function mapPicture({ map, name, serverId, showArt }) {
  const url = mapPictureUrl(map, serverId, showArt);
  if (!url) return null;
  const frame = document.createElement('div');
  frame.className = 'map-art';
  const image = document.createElement('img');
  image.alt = name;
  image.loading = 'lazy';
  image.width = 460;
  image.height = 215;
  image.addEventListener('error', () => {
    const panel = document.createElement('span');
    panel.className = 'map-art-fallback';
    panel.textContent = name;
    frame.replaceChildren(panel);
  });
  // The source is set after the listener, so even a failure reported at once reaches it.
  image.src = url;
  frame.append(image);
  return frame;
}
