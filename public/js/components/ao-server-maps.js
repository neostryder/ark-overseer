import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { relativeTime, byteSize } from '../lib/format.js';
import { MAPS, setCatalogMaps } from '../lib/wizard.js';
import { mapPicture } from '../lib/map-art.js';

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const count = (n, one, many) => (n === 1 ? one : many).replace('{count}', n);

export class AoServerMaps extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    await this.load();
  }
  async load() {
    this.replaceChildren(el('p', STRINGS.maps.loading));
    try {
      this.data = await api.get(`/api/servers/${this.serverId}/maps`);
      // The maps page has the catalog to hand, so the names elsewhere follow it too.
      setCatalogMaps(this.data.catalog?.maps);
      this.render();
    } catch (error) {
      const retry = el('button', STRINGS.app.retry, 'button secondary');
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(el('p', error.message || STRINGS.maps.failed, 'error-message'), retry);
    }
  }
  picture(map, name) {
    return mapPicture({ map, name, serverId: this.serverId, showArt: this.data.showArt });
  }
  // What is known about a save, as short lines: when it was written and how big the world file is.
  saveLines(save) {
    const m = STRINGS.maps;
    if (!save || save.lastSavedAt === null) return [m.noSave];
    return [
      m.lastSaved.replace('{time}', relativeTime(save.lastSavedAt)),
      m.worldSize.replace('{size}', byteSize(save.worldBytes)),
    ];
  }
  render() {
    const m = STRINGS.maps,
      data = this.data;
    // Only if the catalog did not arrive does the built-in list stand in for it.
    const saved = new Set(data.saves.map((save) => save.mapId.toLowerCase()));
    const catalogMaps = (data.catalog?.maps ?? MAPS).map((map) => ({
      kind: 'official',
      hasSave: saved.has(map.id.toLowerCase()),
      ...map,
    }));
    const find = (id) => catalogMaps.find((map) => map.id.toLowerCase() === String(id).toLowerCase());
    this.className = 'screen maps-screen';
    this.replaceChildren(el('h1', m.title));

    const currentSave = data.saves.find((save) => save.current);
    const currentMap = find(data.current);
    const currentName = currentMap?.name ?? currentSave?.name ?? data.current;
    const current = el('section', undefined, 'card map-current');
    current.append(el('h2', m.current));
    const picture = currentMap ? this.picture(currentMap, currentName) : null;
    if (picture) current.append(picture);
    const text = el('div', undefined, 'map-text');
    text.append(el('strong', currentName, 'map-name'));
    for (const line of this.saveLines(currentSave)) text.append(el('span', line, 'muted'));
    current.append(text);
    this.append(current);

    const saves = el('section', undefined, 'card map-saves');
    saves.append(el('h2', m.saves));
    if (!data.saves.length) saves.append(el('p', m.noSaves, 'muted'));
    const list = el('ul', undefined, 'map-list');
    for (const save of data.saves) {
      const row = el('li', undefined, 'map-row');
      const map = find(save.mapId);
      const thumb = map ? this.picture(map, save.name) : null;
      if (thumb) {
        thumb.classList.add('map-thumb');
        row.append(thumb);
      }
      const body = el('div', undefined, 'map-text');
      body.append(el('strong', save.name, 'map-name'));
      for (const line of this.saveLines(save)) body.append(el('span', line, 'muted'));
      body.append(
        el(
          'span',
          `${count(save.profiles, m.playersOne, m.players)}, ${count(save.tribes, m.tribesOne, m.tribes)}`,
          'muted',
        ),
      );
      if (!map) body.append(el('span', m.notInCatalog, 'muted'));
      row.append(body);
      // Milestone 12 adds a "Switch to this map" button to each row here and on the cards below.
      list.append(row);
    }
    saves.append(list);
    this.append(saves);

    const others = catalogMaps.filter((map) => !map.hasSave);
    const other = el('section', undefined, 'card map-others');
    other.append(el('h2', m.other));
    if (!others.length) other.append(el('p', m.noOther, 'muted'));
    const grid = el('div', undefined, 'map-grid');
    for (const map of others) {
      const card = el('div', undefined, 'map-card');
      const thumb = this.picture(map, map.name);
      if (thumb) card.append(thumb);
      card.append(el('strong', map.name, 'map-name'));
      grid.append(card);
    }
    other.append(grid);
    this.append(other);
  }
}
customElements.define('ao-server-maps', AoServerMaps);
