import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { relativeTime, byteSize } from '../lib/format.js';
import { MAPS, setCatalogMaps } from '../lib/wizard.js';
import { mapPicture } from '../lib/map-art.js';

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  if (text !== undefined && className.includes('map-name')) node.title = text;
  return node;
}
const count = (n, one, many) => (n === 1 ? one : many).replace('{count}', n);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
// The job is followed until it ends, as the overview follows the update check.
const POLL_MS = 2000;
const LIVE = ['queued', 'running'];
const SWITCH_JOB = 'server.switch_map';

export class AoServerMaps extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    await this.load();
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  async load() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.replaceChildren(el('p', STRINGS.maps.loading));
    try {
      this.data = await api.get(`/api/servers/${this.serverId}/maps`);
      // The maps page has the catalog to hand, so the names elsewhere follow it too.
      setCatalogMaps(this.data.catalog?.maps);
      this.render();
      await this.resume();
    } catch (error) {
      const retry = el('button', STRINGS.app.retry, 'button secondary');
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(el('p', error.message || STRINGS.maps.failed, 'error-message'), retry);
    }
  }
  picture(map, name, generic = false) {
    return mapPicture({ map, name, serverId: this.serverId, showArt: this.data.showArt, generic, eager: generic });
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
    // The current map always gets a picture: its own, or the generic one when it has none.
    const picture = this.picture(currentMap ?? { id: data.current, kind: 'mod' }, currentName, true);
    if (picture) current.append(picture);
    const text = el('div', undefined, 'map-text');
    text.append(el('strong', currentName, 'map-name'));
    for (const line of this.saveLines(currentSave)) text.append(el('span', line, 'muted'));
    current.append(text);
    // The job's latest step, and the result of the last one, sit under the current map.
    this.jobNode = el('p', undefined, 'map-job muted');
    this.jobNode.setAttribute('role', 'status');
    this.noticeNode = el('p', undefined, 'map-notice');
    this.noticeNode.setAttribute('aria-live', 'polite');
    current.append(this.jobNode, this.noticeNode);
    this.append(current);
    this.switchButtons = [];
    const isCurrent = (id) => String(id).toLowerCase() === String(data.current).toLowerCase();
    const switcher = (id, name, hasSave) => {
      const button = el('button', m.switchTo, 'button secondary map-switch');
      button.setAttribute('aria-label', fill(m.switchLabel, { map: name }));
      button.addEventListener('click', () => this.switchTo({ id, name, hasSave, currentName }));
      this.switchButtons.push(button);
      return button;
    };

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
      if (!isCurrent(save.mapId)) body.append(switcher(save.mapId, save.name, save.lastSavedAt !== null));
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
      if (!isCurrent(map.id)) card.append(switcher(map.id, map.name, false));
      grid.append(card);
    }
    other.append(grid);
    this.append(other);
    this.showNotice(this.notice);
    this.setBusy(Boolean(this.busy), this.busyText);
  }
  showNotice(notice) {
    this.notice = notice ?? null;
    if (!this.noticeNode) return;
    this.noticeNode.textContent = notice?.text ?? '';
    this.noticeNode.className = notice?.error ? 'map-notice error-message' : 'map-notice muted';
    this.noticeNode.hidden = !notice;
  }
  // While a switch is queued or running, the buttons are off and the current map card shows the step.
  setBusy(busy, text = '') {
    this.busy = busy;
    this.busyText = text;
    for (const button of this.switchButtons ?? []) button.disabled = busy;
    if (!this.jobNode) return;
    this.jobNode.textContent = busy ? text : '';
    this.jobNode.hidden = !busy;
  }
  // A page opened in the middle of a switch picks the job up.
  async resume() {
    try {
      const jobs = await api.get(`/api/jobs?serverId=${this.serverId}`);
      const live = jobs.find((job) => job.kind === SWITCH_JOB && LIVE.includes(job.state));
      if (live) this.follow(live.id);
    } catch {
      /* the buttons stay usable; the server refuses a second switch anyway */
    }
  }
  follow(jobId) {
    this.setBusy(true, STRINGS.maps.switchQueued);
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get(`/api/jobs?serverId=${this.serverId}`)).find((item) => item.id === jobId);
        if (job && !LIVE.includes(job.state)) {
          await this.finished(job);
          return;
        }
        if (job) this.setBusy(true, job.message || STRINGS.maps.switchQueued);
      } catch {
        /* a failed poll is tried again */
      }
      this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }
  async finished(job) {
    const m = STRINGS.maps;
    const failure = { cancelled: m.switchCancelled, interrupted: m.switchInterrupted };
    const notice =
      job.state === 'succeeded'
        ? { text: job.message ?? '', error: false }
        : { text: job.error || failure[job.state] || m.switchFailed, error: true };
    this.busy = false;
    this.notice = notice;
    await this.load();
  }
  async switchTo({ id, name, hasSave, currentName }) {
    const m = STRINGS.maps;
    let running;
    try {
      const server = await api.get(`/api/servers/${this.serverId}`);
      running = ['running', 'starting', 'unknown'].includes(server.status?.observedState);
    } catch (error) {
      this.showNotice({ text: error.message, error: true });
      return;
    }
    const values = { map: name, current: currentName };
    const message = [
      fill(running ? m.confirmRunning : m.confirmStopped, values),
      hasSave ? '' : fill(m.noSaveNote, values),
    ]
      .filter(Boolean)
      .join(' ');
    if (!(await document.querySelector('ao-dialog').ask(fill(m.switchTitle, values), message, m.switchNow))) return;
    await this.request(id, false);
  }
  async request(mapId, addMod) {
    const m = STRINGS.maps;
    this.showNotice(null);
    this.setBusy(true, m.switchQueued);
    try {
      const { jobId } = await api.post(`/api/servers/${this.serverId}/map`, { mapId, addMod });
      this.follow(jobId);
    } catch (error) {
      if (error.code === 'needs_mod') {
        this.setBusy(false);
        const yes = await document
          .querySelector('ao-dialog')
          .ask(m.needsModTitle, fill(m.needsMod, { map: error.map, modId: error.modId }), m.addAndSwitch);
        if (yes) await this.request(mapId, true);
        return;
      }
      this.setBusy(false);
      this.showNotice({ text: error.message, error: true });
    }
  }
}
customElements.define('ao-server-maps', AoServerMaps);
