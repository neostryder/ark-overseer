import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { skeleton } from '../lib/skeleton.js';
import { icon } from '../lib/icon.js';
import { stateName, relativeTime } from '../lib/format.js';
import { mapName } from '../lib/wizard.js';
import { branchName, isTestBranch, switchWarning } from '../lib/builds.js';
import { createInstallFolderPicker, validInstallFolder } from '../lib/install-folder.js';
export class AoServerOverview extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    await this.load();
  }
  async load() {
    this.replaceChildren();
    this.replaceChildren(skeleton(STRINGS.overview.loading));
    try {
      this.server = await api.get(`/api/servers/${this.serverId}`);
      // The branch list only adds choices, so a failed read leaves the page working without them.
      this.builds = await api.get('/api/builds').catch(() => ({ branches: [] }));
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
    if (isTestBranch(s.install?.branch)) {
      const test = document.createElement('span');
      test.className = 'badge ptr-badge';
      test.textContent = STRINGS.builds.ptrBadge;
      test.title = STRINGS.builds.ptrBadgeHelp;
      pill.append(test);
    }
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
    // A test copy is a clone that starts on the Public Test Realm, offered once Steam is known to list it.
    const testBranch = (this.builds?.branches ?? []).find((row) => row.branch === 'public_test_realm');
    const transferButtons = [
      ['clone', STRINGS.overview.clone, null],
      ['move', STRINGS.overview.move, null],
    ];
    if (testBranch && s.install?.source !== 'steam-client' && !isTestBranch(s.install?.branch))
      transferButtons.splice(1, 0, ['ptr', STRINGS.builds.ptrCopy, testBranch.branch]);
    for (const [kind, text, branch] of transferButtons) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.textContent = text;
      button.addEventListener('click', () => {
        this.transferKind = this.transferKind === kind ? null : kind;
        this.transferPanel?.remove();
        if (this.transferKind) {
          this.transferPanel = this.renderTransfer(kind === 'ptr' ? 'clone' : kind, branch);
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
      [STRINGS.builds.branchLabel, branchName(install.branch)],
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
    if (s.settings_json?.suspendedMods?.length) {
      const held = document.createElement('p');
      held.className = 'card restart-banner';
      const text = STRINGS.builds.suspended;
      held.textContent = text.replace('{count}', s.settings_json.suspendedMods.length);
      this.append(held);
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
      this.append(this.branchCard());
    }
  }
  // Which Steam branch this install follows, how to move it, and the builds it has received.
  branchCard() {
    const b = STRINGS.builds,
      s = this.server,
      install = s.install;
    const card = document.createElement('section');
    card.className = 'card branch-card';
    const heading = document.createElement('h2');
    heading.textContent = b.sectionTitle;
    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent = b.intro;
    card.append(heading, intro);
    const branches = [...new Set(['public', ...(this.builds?.branches ?? []).map((row) => row.branch)])].filter(
      (branch) => branch !== install.branch,
    );
    const stopped = ['stopped', 'crashed', 'exited'].includes(s.status?.observedState ?? 'unknown');
    if (branches.length) {
      const form = document.createElement('form');
      form.className = 'transfer-form';
      const pick = document.createElement('select');
      for (const branch of branches) pick.append(new Option(branchName(branch), branch));
      const pickLabel = document.createElement('label');
      pickLabel.className = 'field-label';
      const pickText = document.createElement('span');
      pickText.textContent = b.switchTo;
      pickLabel.append(pickText, pick);
      const warning = document.createElement('p');
      warning.className = 'muted';
      const option = (text) => {
        const row = document.createElement('label');
        row.className = 'check-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        const span = document.createElement('span');
        span.textContent = text;
        row.append(box, span);
        return { row, box };
      };
      const ack = option(b.ack),
        keep = option(b.keepMods),
        cluster = option(b.allowCluster);
      const submit = document.createElement('button');
      submit.className = 'button secondary';
      submit.type = 'submit';
      submit.textContent = b.switchButton;
      const sync = () => {
        const toTest = isTestBranch(pick.value);
        warning.textContent = switchWarning(install.branch, pick.value);
        ack.row.hidden = !toTest || isTestBranch(install.branch);
        keep.row.hidden = !toTest;
        cluster.row.hidden = !toTest || !s.cluster_id;
        submit.disabled = !stopped || (!ack.row.hidden && !ack.box.checked);
        submit.title = stopped ? '' : b.needsStop;
      };
      pick.addEventListener('change', sync);
      ack.box.addEventListener('change', sync);
      sync();
      form.append(pickLabel, warning, ack.row, keep.row, cluster.row, submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        this.message.textContent = '';
        try {
          const job = await api.post(`/api/installs/${s.install_id}/branch`, {
            branch: pick.value,
            acknowledged: ack.box.checked,
            keepMods: keep.box.checked,
            allowCluster: cluster.box.checked,
          });
          this.message.textContent = b.switching;
          this.follow(job.id, 'switch');
        } catch (cause) {
          this.message.textContent = cause.message;
          sync();
        }
      });
      card.append(form);
    }
    const history = document.createElement('ul');
    history.className = 'build-history';
    const historyHeading = document.createElement('h3');
    historyHeading.textContent = b.history;
    card.append(historyHeading, history);
    const rollback = document.createElement('p');
    rollback.className = 'muted';
    const link = document.createElement('a');
    link.href = `#/servers/${s.id}/backups`;
    link.textContent = b.rollbackLink;
    rollback.append(`${b.rollback} `, link, '.');
    card.append(rollback);
    api
      .get(`/api/installs/${s.install_id}/builds`)
      .then((rows) => {
        if (!rows.length) history.append(Object.assign(document.createElement('li'), { textContent: b.historyEmpty }));
        for (const row of rows) {
          const item = document.createElement('li');
          item.textContent = b.historyRow
            .replace('{build}', row.build_id ?? b.unknownBuild)
            .replace('{branch}', branchName(row.branch))
            .replace('{reason}', b.reasons[row.reason] ?? row.reason)
            .replace('{when}', relativeTime(row.recorded_at));
          if (row.manifest_id) item.title = b.manifest.replace('{id}', row.manifest_id);
          history.append(item);
        }
      })
      .catch(() => {});
    return card;
  }
  renderTransfer(kind, branch = null) {
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
    // The branch choice is for a clone only. A test copy opens with the test branch picked.
    let pick = null;
    let keep = null;
    if (kind === 'clone' && (this.builds?.branches ?? []).length && this.server.install.source !== 'steam-client') {
      pick = document.createElement('select');
      pick.append(new Option(STRINGS.builds.cloneSameBranch, ''));
      const listed = ['public', ...this.builds.branches.map((entry) => entry.branch)];
      for (const value of new Set(listed)) pick.append(new Option(branchName(value), value));
      pick.value = branch ?? '';
      const label = document.createElement('label');
      label.className = 'field-label';
      const text = document.createElement('span');
      text.textContent = STRINGS.builds.cloneBranch;
      label.append(text, pick);
      panel.append(label);
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = STRINGS.builds.ptrCopyHelp;
      panel.append(hint);
      keep = field(STRINGS.builds.cloneKeepMods, false, 'checkbox');
      const showKeep = () => {
        keep.parentElement.hidden = !isTestBranch(pick.value || this.server.install.branch);
      };
      pick.addEventListener('change', showKeep);
      showKeep();
    }
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
                ...(pick?.value ? { branch: pick.value } : {}),
                ...(keep?.checked && !keep.parentElement.hidden ? { keepMods: true } : {}),
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
          else if (kind === 'move' || kind === 'switch') this.message.textContent = job.result.message;
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
