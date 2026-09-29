import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { stateName, relativeTime } from '../lib/format.js';
import { mapName } from '../lib/wizard.js';
export class AoServerOverview extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    await this.load();
  }
  async load() {
    this.replaceChildren();
    this.textContent = STRINGS.overview.loading;
    try {
      this.server = await api.get(`/api/servers/${this.serverId}`);
      this.render();
    } catch (error) {
      this.replaceChildren();
      const message = document.createElement('p');
      message.textContent = error.message || STRINGS.overview.failed;
      const retry = document.createElement('button');
      retry.className = 'button secondary';
      retry.textContent = STRINGS.app.retry;
      retry.addEventListener('click', () => this.load());
      this.append(message, retry);
    }
  }
  render() {
    const s = this.server,
      status = s.status || {},
      state = status.observedState || 'unknown';
    this.replaceChildren();
    this.className = 'screen';
    const title = document.createElement('h1');
    title.textContent = s.name;
    title.title = s.name;
    this.append(title);
    const pill = document.createElement('p');
    pill.className = `status ${state}`;
    const dot = document.createElement('i');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = `${stateName(state)}${status.crashLoop ? ` · ${STRINGS.overview.crashLoop}` : ''}`;
    pill.append(dot, label);
    this.append(pill);
    const controls = document.createElement('div');
    controls.className = 'button-row';
    for (const [action, text, allowed] of [
      ['start', STRINGS.overview.start, ['stopped', 'crashed', 'exited'].includes(state)],
      ['stop', STRINGS.overview.stop, ['running', 'starting'].includes(state)],
      ['restart', STRINGS.overview.restart, state === 'running'],
    ]) {
      const button = document.createElement('button');
      button.className = `button ${action === 'start' ? 'primary' : 'secondary'}`;
      button.append(icon({ start: 'play', stop: 'stop', restart: 'restart' }[action]), text);
      button.disabled = !allowed;
      button.addEventListener('click', () => this.action(action, button));
      controls.append(button);
    }
    this.append(controls);
    this.message = document.createElement('p');
    this.message.className = 'error-message';
    this.message.setAttribute('aria-live', 'polite');
    this.append(this.message);
    const cards = document.createElement('div');
    cards.className = 'detail-grid';
    const statusSince = status.startedAt ? relativeTime(status.startedAt) : STRINGS.overview.unknown;
    const install = s.install || {};
    const values = [
      [STRINGS.overview.session, s.session_name],
      [STRINGS.overview.map, mapName(s.map)],
      [STRINGS.overview.since, statusSince],
      [STRINGS.overview.game, s.game_port],
      [STRINGS.overview.peer, Number(s.game_port) + 1],
      [STRINGS.overview.query, s.query_port],
      [STRINGS.overview.rcon, s.rcon_port],
      [STRINGS.overview.players, s.max_players],
      [STRINGS.overview.install, install.path],
      [STRINGS.overview.build, install.build_id],
      [STRINGS.overview.source, STRINGS.overview.sources[install.source] ?? install.source],
      [STRINGS.overview.mods, (s.settings_json?.mods || []).join(', ') || STRINGS.overview.noMods],
      [STRINGS.overview.battleye, s.settings_json?.disableBattlEye ? STRINGS.overview.off : STRINGS.overview.on],
    ];
    for (const [key, value] of values) {
      const card = document.createElement('div');
      card.className = 'detail-card';
      const term = document.createElement('span');
      term.textContent = key;
      const data = document.createElement('strong');
      data.textContent =
        value === null || value === undefined || value === '' ? STRINGS.overview.notSet : String(value);
      data.title = data.textContent;
      card.append(term, data);
      cards.append(card);
    }
    this.append(cards);
    if (install.latest_build_id && install.build_id !== install.latest_build_id) {
      const notice = document.createElement('p');
      notice.className = 'card restart-banner';
      notice.setAttribute('role', 'status');
      notice.textContent = `${STRINGS.overview.updateAvailable} ${install.latest_build_id}.`;
      this.append(notice);
    }
    if (install.update_checked_at) {
      const checked = document.createElement('p');
      checked.className = 'muted';
      checked.textContent = `${STRINGS.overview.checkedAt} ${new Date(install.update_checked_at).toLocaleString()}.`;
      this.append(checked);
    }
    if (install.source !== 'steam-client') {
      const check = document.createElement('button');
      check.className = 'button secondary';
      check.textContent = STRINGS.overview.checkUpdates;
      check.disabled = Boolean(this.pollTimer);
      check.addEventListener('click', async () => {
        check.disabled = true;
        this.message.textContent = '';
        try {
          const job = await api.post(`/api/installs/${s.install_id}/check-update`, {});
          this.follow(job.id);
        } catch (error) {
          this.message.textContent = error.message;
          check.disabled = false;
        }
      });
      this.append(check);
    }
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  // Polls the update check until it ends, then reloads to show the result, or the reason it failed.
  follow(jobId) {
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get('/api/jobs')).find((item) => item.id === jobId);
        if (job && !['queued', 'running'].includes(job.state)) {
          await this.load();
          if (job.state !== 'succeeded') this.message.textContent = job.error || STRINGS.overview.checkFailed;
          return;
        }
      } catch (error) {
        this.message.textContent = error.message;
      }
      this.pollTimer = setTimeout(tick, 2000);
    };
    this.pollTimer = setTimeout(tick, 2000);
  }
  async action(action, button) {
    if (
      ['stop', 'restart'].includes(action) &&
      !(await document
        .querySelector('ao-dialog')
        .ask(
          STRINGS.overview[action],
          action === 'stop' ? STRINGS.overview.confirmStop : STRINGS.overview.confirmRestart,
        ))
    )
      return;
    button.disabled = true;
    this.message.textContent = '';
    try {
      await api.post(`/api/servers/${this.serverId}/${action}`, {});
      await this.load();
    } catch (error) {
      this.message.textContent = error.message;
      button.disabled = false;
    }
  }
}
customElements.define('ao-server-overview', AoServerOverview);
