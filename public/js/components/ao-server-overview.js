import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { stateName, relativeTime } from '../lib/format.js';
import { mapName } from '../lib/wizard.js';
import { createInstallFolderPicker, validInstallFolder } from '../lib/install-folder.js';
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
    this.transferKind = null;
    this.transferPanel = null;
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
    if (s.cluster_id) {
      const cluster = document.createElement('a');
      cluster.href = `#/clusters/${s.cluster_id}`;
      cluster.className = 'button quiet overview-cluster';
      cluster.textContent = `${STRINGS.overview.cluster}: ${s.cluster_name}`;
      this.append(cluster);
    }
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
    const transfers = document.createElement('div');
    transfers.className = 'button-row';
    for (const kind of ['clone', 'move']) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.textContent = STRINGS.overview[kind];
      button.addEventListener('click', () => {
        this.transferKind = this.transferKind === kind ? null : kind;
        this.transferPanel?.remove();
        if (this.transferKind) {
          this.transferPanel = this.renderTransfer(kind);
          transfers.after(this.transferPanel);
        }
      });
      transfers.append(button);
    }
    const remove = document.createElement('button');
    remove.className = 'button secondary';
    remove.textContent = STRINGS.overview.remove;
    const removable = ['stopped', 'crashed', 'exited'].includes(state);
    remove.disabled = !removable;
    if (!removable) remove.title = STRINGS.overview.removeNeedsStop;
    remove.addEventListener('click', () => this.remove(remove));
    transfers.append(remove);
    this.append(transfers);
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
    if (s.lastMove?.message) {
      const move = document.createElement('p');
      move.className = 'card restart-banner';
      move.textContent = s.lastMove.message;
      this.append(move);
    }
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
  renderTransfer(kind) {
    const w = STRINGS.overview;
    const panel = document.createElement('form');
    panel.className = 'card transfer-form';
    const heading = document.createElement('h2');
    heading.textContent = w[kind];
    panel.append(heading);
    const field = (label, value = '', type = 'text') => {
      const wrap = document.createElement('label');
      wrap.className = 'field-label';
      const title = document.createElement('span');
      title.textContent = label;
      const input = document.createElement('input');
      input.type = type;
      if (type === 'checkbox') input.checked = Boolean(value);
      else input.value = value;
      wrap.append(title, input);
      panel.append(wrap);
      return input;
    };
    const name = kind === 'clone' ? field(w.cloneName, `${this.server.name} copy`) : null;
    const session = kind === 'clone' ? field(w.cloneSession, `${this.server.session_name} copy`) : null;
    const folder = field(w.folder);
    folder.placeholder = w.folderExample;
    panel.append(
      createInstallFolderPicker(
        folder,
        this.server.install.source === 'steam-client' ? 'C:\\' : this.server.install.path,
      ),
    );
    const help = document.createElement('p');
    help.className = 'muted';
    help.textContent = kind === 'move' ? `${w.folderHelp} ${w.moveHelp}` : w.folderHelp;
    panel.append(help);
    const world = kind === 'clone' ? field(w.copyWorld, false, 'checkbox') : null;
    const admin = kind === 'clone' ? field(w.adminPassword, '', 'password') : null;
    const join = kind === 'clone' ? field(w.joinPassword, '', 'password') : null;
    const space = document.createElement('p');
    space.className = 'muted';
    space.setAttribute('aria-live', 'polite');
    panel.append(space);
    const submit = document.createElement('button');
    submit.className = 'button primary';
    submit.type = 'submit';
    submit.textContent = kind === 'clone' ? w.submitClone : w.submitMove;
    panel.append(submit);
    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      this.message.textContent = '';
      space.textContent = w.spaceChecking;
      try {
        const installs = await api.get('/api/installs');
        if (!validInstallFolder(folder.value, installs)) throw new Error(w.folderHelp);
        const checked = await api.get(
          `/api/host/free-space?path=${encodeURIComponent(folder.value)}&serverId=${this.serverId}`,
        );
        space.textContent = w.space
          .replace('{free}', (checked.freeBytes / 1e9).toFixed(1))
          .replace('{needed}', (checked.requiredBytes / 1e9).toFixed(1));
        const body =
          kind === 'clone'
            ? {
                path: folder.value,
                name: name.value,
                sessionName: session.value,
                copyWorld: world.checked,
                ...(admin.value ? { adminPassword: admin.value } : {}),
                ...(join.value ? { joinPassword: join.value } : {}),
              }
            : { path: folder.value };
        const job = await api.post(`/api/servers/${this.serverId}/${kind}`, body);
        this.follow(job.jobId, kind);
      } catch (cause) {
        this.message.textContent = cause.message;
        submit.disabled = false;
      }
    });
    return panel;
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  // Polls the update check until it ends, then reloads to show the result, or the reason it failed.
  follow(jobId, kind = 'update') {
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get('/api/jobs')).find((item) => item.id === jobId);
        if (job && !['queued', 'running'].includes(job.state)) {
          if (kind === 'remove' && job.state === 'succeeded') {
            await this.closest('ao-app')?.loadServers();
            document.querySelector('ao-toast')?.show(job.result.message);
            window.location.hash = '#/servers';
            return;
          }
          if (kind === 'clone' && job.state === 'succeeded') {
            await this.closest('ao-app')?.loadServers();
            window.location.hash = `#/servers/${job.result.serverId}/overview`;
            return;
          }
          await this.load();
          if (job.state !== 'succeeded') this.message.textContent = job.error || STRINGS.overview.checkFailed;
          else if (kind === 'move') this.message.textContent = job.result.message;
          return;
        }
      } catch (error) {
        this.message.textContent = error.message;
      }
      this.pollTimer = setTimeout(tick, 2000);
    };
    this.pollTimer = setTimeout(tick, 2000);
  }
  async remove(button) {
    const w = STRINGS.overview,
      s = this.server,
      dialog = document.querySelector('ao-dialog'),
      steam = s.install?.source === 'steam-client';
    const choice = await dialog.choose(
      w.removeTitle.replace('{name}', s.name),
      (steam ? w.removeMessageSteam : w.removeMessage).replaceAll('{name}', s.name),
      steam
        ? [{ value: 'keep', label: w.removeOnly }]
        : [
            { value: 'keep', label: w.removeKeep },
            { value: 'delete', label: w.removeDelete },
          ],
    );
    if (!choice) return;
    if (
      choice === 'delete' &&
      !(await dialog.ask(
        w.removeDeleteTitle,
        w.removeDeleteMessage.replace('{path}', s.install.path).replace('{name}', s.name),
        w.removeDeleteNow,
      ))
    )
      return;
    button.disabled = true;
    this.message.textContent = '';
    try {
      const job = await api.del(`/api/servers/${this.serverId}`, { deleteFiles: choice === 'delete' });
      this.message.textContent = w.removing.replace('{name}', s.name);
      this.follow(job.jobId, 'remove');
    } catch (cause) {
      this.message.textContent = cause.message;
      button.disabled = false;
    }
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
