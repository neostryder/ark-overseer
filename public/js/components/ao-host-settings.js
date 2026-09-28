import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { parseGameNames, validGameNames } from '../lib/gaming.js';
import { relativeTime } from '../lib/format.js';
import { isLocalPage, shortCommit, updateFinished } from '../lib/update.js';

const POLL_MS = 15000;
const UPDATE_POLL_MS = 3000;
const UPDATE_WAIT_MINUTES = 10;

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function field(text, control, help) {
  const label = el('label', undefined, 'field-label');
  label.append(el('span', text), control);
  const error = el('p', '', 'error-message');
  error.setAttribute('aria-live', 'polite');
  const wrap = el('div');
  wrap.append(label);
  if (help) wrap.append(el('p', help, 'muted'));
  wrap.append(error);
  return { wrap, error };
}

export class AoHostSettings extends HTMLElement {
  connectedCallback() {
    this.className = 'screen';
    this.load();
    this.timer = setInterval(() => this.refreshStatus(), POLL_MS);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    clearInterval(this.updateTimer);
  }
  async load() {
    this.replaceChildren(el('p', STRINGS.app.loading));
    // A failed read leaves the picture setting on, which is what a new install has. These two are read
    // apart from gaming mode, so the update and picture cards still show when gaming mode can't load.
    this.showArt = (await api.get('/api/maps').catch(() => null))?.showArt ?? true;
    this.version = await api.get('/api/version').catch(() => null);
    try {
      this.data = await api.get('/api/gaming');
      this.render();
    } catch (error) {
      const retry = el('button', STRINGS.app.retry, 'button secondary');
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(
        el('h1', STRINGS.host.title),
        ...this.updateCards(),
        this.mapArtCard(),
        el('p', error.message, 'error-message'),
        retry,
      );
    }
  }
  // The timer only redraws the status block, so it never wipes what someone is typing in the form.
  async refreshStatus() {
    if (!this.statusBlock) return;
    try {
      this.data = await api.get('/api/gaming');
      this.renderStatus();
    } catch {
      // The next check tries again; the last known status stays on screen.
    }
  }
  render() {
    const s = STRINGS.host;
    const card = el('section', undefined, 'card host-card');
    card.append(el('h2', s.gaming), el('p', s.intro, 'muted'));
    const form = el('form', undefined, 'host-form');
    form.noValidate = true;

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = Boolean(this.data.enabled);
    const toggle = el('label', undefined, 'check-row');
    toggle.append(enabled, el('span', s.enabled));

    const priority = document.createElement('select');
    priority.append(new Option(s.below, 'BelowNormal'), new Option(s.lowest, 'Idle'));
    priority.value = this.data.priority || 'BelowNormal';

    const cores = document.createElement('input');
    cores.type = 'number';
    cores.min = 1;
    cores.max = Math.max(1, this.data.cpuCount - 1);
    cores.inputMode = 'numeric';
    cores.placeholder = String(Math.floor(this.data.cpuCount / 2));
    // gameCores is always filled in by the server; a value equal to half was most likely left empty.
    const saved = this.data.gameCores;
    cores.value = saved === Math.floor(this.data.cpuCount / 2) ? '' : String(saved);
    const gameList = el('textarea');
    gameList.rows = 4;
    gameList.value = this.data.gamesList.join('\n');
    const ignoreList = el('textarea');
    ignoreList.rows = 3;
    ignoreList.value = this.data.ignoreList.join('\n');

    const priorityField = field(s.priority, priority);
    const coresField = field(s.cores, cores, s.coresHelp.replace('{count}', this.data.cpuCount));
    const gamesField = field(s.games, gameList, s.gamesHelp);
    const ignoreField = field(s.ignore, ignoreList, s.ignoreHelp);
    const save = el('button', s.save, 'button primary');
    save.type = 'submit';
    const message = el('p', '', 'error-message');
    message.setAttribute('aria-live', 'polite');
    form.append(toggle, priorityField.wrap, coresField.wrap, gamesField.wrap, ignoreField.wrap, save, message);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      for (const f of [coresField, gamesField, ignoreField]) f.error.textContent = '';
      message.textContent = '';
      const games = parseGameNames(gameList.value),
        ignore = parseGameNames(ignoreList.value);
      const count = Number(cores.value);
      let bad = false;
      if (cores.value.trim() && (!Number.isInteger(count) || count < 1 || count >= this.data.cpuCount)) {
        coresField.error.textContent = s.invalidCores.replace('{max}', this.data.cpuCount - 1);
        bad = true;
      }
      if (!validGameNames(games)) {
        gamesField.error.textContent = s.invalidNames;
        bad = true;
      }
      if (!validGameNames(ignore)) {
        ignoreField.error.textContent = s.invalidNames;
        bad = true;
      }
      if (bad) return;
      save.disabled = true;
      try {
        this.data = await api.put('/api/gaming', {
          enabled: enabled.checked,
          priority: priority.value,
          gameCores: cores.value.trim() ? count : null,
          games,
          ignore,
        });
        document.querySelector('ao-toast')?.show(s.saved);
        this.renderStatus();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    card.append(form);

    this.statusBlock = el('section', undefined, 'card host-status');
    this.statusBlock.setAttribute('aria-live', 'polite');
    this.replaceChildren(el('h1', s.title), ...this.updateCards(), card, this.mapArtCard(), this.statusBlock);
    this.renderStatus();
  }
  // Saved the moment it is toggled, since it is one switch with nothing to review.
  mapArtCard() {
    const s = STRINGS.host;
    const card = el('section', undefined, 'card host-card');
    const art = document.createElement('input');
    art.type = 'checkbox';
    art.checked = this.showArt;
    const row = el('label', undefined, 'check-row');
    row.append(art, el('span', s.mapArt));
    const message = el('p', '', 'error-message');
    message.setAttribute('aria-live', 'polite');
    art.addEventListener('change', async () => {
      message.textContent = '';
      art.disabled = true;
      try {
        await api.put('/api/host/map-art', { enabled: art.checked });
        this.showArt = art.checked;
        document.querySelector('ao-toast')?.show(s.mapArtSaved);
      } catch (error) {
        art.checked = !art.checked;
        message.textContent = error.message;
      } finally {
        art.disabled = false;
      }
    });
    card.append(el('h2', s.mapArtTitle), row, el('p', s.mapArtHelp, 'muted'), message);
    return card;
  }
  updateCards() {
    const s = STRINGS.host,
      v = this.version;
    if (!v) return [];
    const card = el('section', undefined, 'card host-card');
    card.append(el('h2', s.updateTitle));
    const time = v.startedAt ? relativeTime(v.startedAt) : '';
    card.append(
      el(
        'p',
        v.commit
          ? s.version.replace('{commit}', shortCommit(v.commit)).replace('{time}', time)
          : s.versionUnknown.replace('{time}', time),
      ),
    );
    const last = v.lastUpdate;
    if (last?.endedAt)
      card.append(
        el(
          'p',
          last.ok
            ? s.lastUpdateOk.replace('{time}', relativeTime(last.endedAt))
            : s.lastUpdateFailed.replace('{time}', relativeTime(last.endedAt)).replace('{message}', last.message ?? ''),
          last.ok ? 'muted' : 'error-message',
        ),
      );
    if (v.available && !isLocalPage(location.hostname)) card.append(el('p', s.updateRemote, 'muted'));
    else if (v.available) {
      const button = el('button', s.updateButton.replace('{folder}', v.appDir), 'button primary');
      button.type = 'button';
      const note = el('p', '', 'muted');
      note.setAttribute('aria-live', 'polite');
      button.addEventListener('click', () => this.startUpdate(button, note));
      card.append(button, el('p', s.updateHelp, 'muted'), note);
    }
    return [card];
  }
  // The link starts tools/update.ps1 on this computer. The page then waits for the service to come back
  // as a new process and reloads; while it restarts, a failed check is expected and just tried again.
  startUpdate(button, note) {
    const s = STRINGS.host,
      before = this.version;
    button.disabled = true;
    note.className = 'muted';
    note.textContent = s.updateWaiting;
    location.href = `${before.link}:`;
    const deadline = Date.now() + UPDATE_WAIT_MINUTES * 60000;
    clearInterval(this.updateTimer);
    this.updateTimer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(this.updateTimer);
        button.disabled = false;
        note.className = 'error-message';
        note.textContent = s.updateTimeout
          .replace('{minutes}', String(UPDATE_WAIT_MINUTES))
          .replace('{folder}', before.logsDir ?? '');
        return;
      }
      const after = await api.get('/api/version').catch(() => null);
      if (updateFinished(before, after)) {
        clearInterval(this.updateTimer);
        location.reload();
      }
    }, UPDATE_POLL_MS);
  }
  renderStatus() {
    const s = STRINGS.host,
      d = this.data;
    const lines = [el('h2', s.statusTitle)];
    lines.push(
      el(
        'p',
        !d.enabled ? s.off : d.state === 'gaming' ? `${s.running} ${d.games.join(', ')}` : s.watching,
        'host-state',
      ),
    );
    if (d.enabled && d.checkedAt)
      lines.push(el('p', `${s.checked} ${new Date(d.checkedAt).toLocaleString()}.`, 'muted'));
    if (d.enabled) {
      if (!d.servers.length) lines.push(el('p', s.noServers, 'muted'));
      for (const server of d.servers) {
        const how = server.error
          ? s.failed.replace('{error}', server.error)
          : server.policy === 'gaming'
            ? s.gamingPolicy
            : server.policy === 'normal'
              ? s.normal
              : s.notApplied;
        lines.push(el('p', `${server.name}: ${how}`));
      }
    }
    this.statusBlock.replaceChildren(...lines);
  }
}
customElements.define('ao-host-settings', AoHostSettings);
