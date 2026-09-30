import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import './ao-access-settings.js';
import { parseGameNames, validGameNames } from '../lib/gaming.js';
import { relativeTime } from '../lib/format.js';
import {
  isLocalPage,
  shortCommit,
  updateFinished,
  updateCard,
  updateSources,
  UPDATE_PROGRESS_STAGES,
  updateProgressStage,
  createUpdatePoller,
  updateChecklist,
} from '../lib/update.js';
import { createInstallFolderPicker } from '../lib/install-folder.js';

const POLL_MS = 15000;

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
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export class AoHostSettings extends HTMLElement {
  connectedCallback() {
    this.className = 'screen';
    this.load();
    this.timer = setInterval(() => this.refreshStatus(), POLL_MS);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    this.updatePoller?.stop();
  }
  async load() {
    this.replaceChildren(el('p', STRINGS.app.loading));
    // A failed read leaves the picture setting on, which is what a new install has. These two are read
    // apart from gaming mode, so the update and picture cards still show when gaming mode can't load.
    this.showArt = (await api.get('/api/maps').catch(() => null))?.showArt ?? true;
    this.version = await api.get('/api/version').catch(() => null);
    // A check when the page opens, cached on the server for ten minutes. It is never repeated on a timer.
    if (this.version?.available) this.check = await api.get('/api/update/releases?channel=stable').catch(() => null);
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
    this.replaceChildren(
      el('h1', s.title),
      ...this.updateCards(),
      card,
      this.mapArtCard(),
      document.createElement('ao-access-settings'),
      this.statusBlock,
    );
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
    const card = el('section', undefined, 'card host-card update-card');
    card.append(el('h2', s.updateTitle));
    const time = v.startedAt ? relativeTime(v.startedAt) : '';
    card.append(
      el(
        'p',
        v.commit
          ? s.runningVersion
              .replace('{version}', v.version ?? '?')
              .replace('{commit}', shortCommit(v.commit))
              .replace('{time}', time)
          : s.runningVersionNoCommit.replace('{version}', v.version ?? '?').replace('{time}', time),
        'muted',
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
    if (!v.available) return [card];
    // The update link starts a program on the computer the browser runs on. Nothing here can tell whether
    // that is the server's computer, so the button stays and the note says where to use it.
    if (!isLocalPage(location.hostname)) card.append(el('p', s.updateElsewhere, 'muted'));

    const source = document.createElement('select');
    for (const value of updateSources(v))
      source.append(new Option(value === 'github' ? s.sourceGithub : s.sourceCheckout, value));
    source.value = v.package ? 'github' : (this.updateSource ?? 'checkout');
    this.updateSource = source.value;
    if (!v.package) card.append(field(s.sourceLegend, source).wrap);

    const body = el('div', undefined, 'update-body');
    const note = el('p', '', 'muted');
    note.setAttribute('aria-live', 'polite');
    const message = el('p', '', 'error-message');
    message.setAttribute('aria-live', 'polite');
    card.append(body, note, message);
    this.updateProgressHost = card;
    source.addEventListener('change', () => {
      this.updateSource = source.value;
      this.renderUpdateBody(body, note, message);
    });
    this.renderUpdateBody(body, note, message);
    // A page opened while an update is running joins it, so a reload never hides what it is doing.
    const running = this.version?.progress;
    if (running && running.stage !== 'done' && running.stage !== 'failed') {
      const run = { startedAt: Date.parse(running.startedAt) || Date.now(), before: this.version, request: null };
      this.updateRun = run;
      this.renderUpdateProgress(run, running);
      this.watchUpdate(run);
    }
    return [card];
  }
  renderUpdateBody(container, note, message) {
    note.textContent = '';
    message.textContent = '';
    container.replaceChildren();
    if (this.updateSource === 'github') this.renderGithub(container, note, message);
    else this.renderCheckout(container, note, message);
  }
  // The recorded checkout is the default. Browse picks another folder with the shared folder browser,
  // and the folder is read without running git, so an unreadable one only shows a plain message.
  renderCheckout(container, note, message) {
    const s = STRINGS.host,
      v = this.version;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = this.checkoutPath ?? v.appDir ?? '';
    const folder = field(s.checkoutFolder, input);
    const info = el('p', '', 'muted');
    info.setAttribute('aria-live', 'polite');
    const button = el('button', s.updateFromCheckout, 'button primary');
    button.type = 'button';
    button.disabled = true;
    const read = async (folderPath) => {
      this.checkoutPath = folderPath;
      info.className = 'muted';
      info.textContent = s.checkoutReading;
      button.disabled = true;
      this.checkout = await api
        .get(`/api/update/checkout?path=${encodeURIComponent(folderPath)}`)
        .catch((error) => ({ ok: false, message: error.message }));
      const view = updateCard({ source: 'checkout', checkout: this.checkout });
      if (this.checkout.ok) {
        info.className = 'muted';
        info.textContent = s.checkoutRead
          .replace('{commit}', view.newest.label)
          .replace('{date}', this.checkout.date ? new Date(this.checkout.date).toLocaleString() : '');
        button.disabled = false;
      } else if (this.checkout.noAccess) {
        // The elevated update checks the folder itself, so this page does not block the button.
        info.className = 'muted';
        info.textContent = this.checkout.message;
        button.disabled = false;
      } else {
        info.className = 'error-message';
        info.textContent = s.checkoutUnknown.replace('{message}', this.checkout.message);
      }
    };
    input.addEventListener('input', () => void read(input.value.trim()));
    button.addEventListener('click', () =>
      this.beginUpdate(button, note, message, { source: 'checkout', checkout: input.value.trim() }),
    );
    container.append(folder.wrap, createInstallFolderPicker(input, v.appDir ?? 'C:\\'), info, button);
    container.append(el('p', s.checkoutHelp, 'muted'));
    void read(input.value.trim());
  }
  // GitHub releases: a channel picker, the newest release and its notes as plain text, and for Stable
  // and Beta the earlier releases to go back to. The server caches the answer for ten minutes.
  renderGithub(container, note, message) {
    const s = STRINGS.host;
    const channel = document.createElement('select');
    for (const [value, label] of [
      ['stable', s.channelStable],
      ['beta', s.channelBeta],
      ['edge', s.channelEdge],
    ])
      channel.append(new Option(label, value));
    channel.value = this.updateChannel ?? 'stable';
    const newest = el('div', undefined, 'update-newest');
    const history = el('div', undefined, 'update-history');
    const check = el('button', s.checkNow, 'button secondary');
    check.type = 'button';
    const button = el('button', s.updateFromGithub, 'button primary');
    button.type = 'button';
    button.disabled = true;
    const show = async (value) => {
      this.updateChannel = value;
      this.selectedRef = null;
      message.textContent = '';
      newest.replaceChildren(el('p', s.checking, 'muted'));
      history.replaceChildren();
      button.disabled = true;
      check.disabled = true;
      const result = await api
        .get(`/api/update/releases?channel=${encodeURIComponent(value)}`)
        .catch((error) => ({ ok: false, message: error.message }));
      this.check = result;
      check.disabled = false;
      this.renderReleaseResult(newest, history, button);
    };
    channel.addEventListener('change', () => void show(channel.value));
    check.addEventListener('click', () => void show(channel.value));
    button.addEventListener('click', () =>
      this.beginUpdate(button, note, message, {
        source: 'github',
        channel: this.updateChannel,
        ...(this.selectedRef ? { ref: this.selectedRef } : {}),
      }),
    );
    const actions = el('div', undefined, 'button-row');
    actions.append(check, button);
    container.append(field(s.channel, channel).wrap, newest, history, actions, el('p', s.githubHelp, 'muted'));
    void show(channel.value);
  }
  renderReleaseResult(newest, history, button) {
    const s = STRINGS.host,
      view = updateCard({ source: 'github', channel: this.updateChannel, check: this.check });
    newest.replaceChildren();
    if (view.message) newest.append(el('p', view.message, 'error-message'));
    else if (!view.newest) newest.append(el('p', s.noReleases, 'muted'));
    else {
      const label = view.newest.commit && !view.newest.tag ? s.newestCommit : s.newest;
      newest.append(
        el('p', label.replace('{version}', view.newest.label).replace('{commit}', view.newest.label), 'host-state'),
      );
      if (view.newest.notes) {
        newest.append(el('h3', s.notes));
        newest.append(el('p', view.newest.notes));
      }
      if (view.newest.size !== null)
        newest.append(el('p', s.downloadSize.replace('{size}', formatBytes(view.newest.size)), 'muted'));
      button.disabled = false;
    }
    history.replaceChildren();
    if (view.history.length) {
      history.append(el('h3', s.earlier));
      for (const item of view.history) {
        const row = el('div', undefined, 'update-history-row');
        row.append(el('span', item.label));
        const pick = el('button', s.useRelease, 'button quiet');
        pick.type = 'button';
        pick.addEventListener('click', () => {
          this.selectedRef = item.tag ?? item.commit;
          row.classList.add('chosen');
          document.querySelector('ao-toast')?.show(s.selected.replace('{version}', item.label));
        });
        row.append(pick);
        history.append(row);
      }
    }
  }
  // The link starts tools/update.ps1 on this computer after the page has written the request file. The
  // page then waits for the service to come back as a new process and reloads.
  async beginUpdate(button, note, message, request) {
    const s = STRINGS.host,
      before = this.version;
    button.disabled = true;
    note.className = 'muted';
    note.textContent = '';
    message.textContent = '';
    const run = { startedAt: Date.now(), request, button, note, message, before };
    this.updateRun = run;
    this.renderUpdateProgress(run, { stage: 'requested' }, s.updateApprovalWaiting);
    try {
      await api.post('/api/host/update', request);
    } catch (error) {
      run.panel?.remove();
      if (this.updateRun === run) this.updateRun = null;
      button.disabled = false;
      note.textContent = '';
      message.textContent = error.message;
      return;
    }
    location.href = `${before.link}:`;
    this.watchUpdate(run);
  }
  // Watches the progress file and the service until the run ends. A page opened while an update is
  // already running joins it the same way, so a reload never hides what the update is doing.
  watchUpdate(run) {
    const s = STRINGS.host;
    this.updatePoller?.stop();
    this.updatePoller = createUpdatePoller({
      before: run.before,
      startedAt: run.startedAt,
      fetchVersion: () => api.get('/api/version').catch(() => null),
      onState: ({ kind, progress }) => {
        if (this.updateRun !== run) return;
        if (kind === 'restart') this.renderUpdateProgress(run, { stage: 'restarting' }, s.updateRestartWaiting);
        else if (kind === 'progress') this.renderUpdateProgress(run, progress);
      },
      onNoStart: () => {
        if (this.updateRun !== run) return;
        if (run.button) run.button.disabled = false;
        this.renderUpdateProgress(run, null, s.updateNoStart, true);
      },
      onFinish: (after, progress) => {
        if (this.updateRun !== run) return;
        const failed = progress?.stage === 'failed' || after.lastUpdate?.ok === false;
        const finalText = failed
          ? after.lastUpdate?.message || progress?.message || s.updateFailed
          : s.updateSucceeded
              .replace('{version}', after.version ?? '?')
              .replace('{commit}', shortCommit(after.commit) ?? '?');
        this.renderUpdateProgress(run, progress, finalText, false, failed);
        if (run.button) run.button.disabled = false;
        if (!failed) setTimeout(() => location.reload(), 2000);
      },
    });
  }
  renderUpdateProgress(run, progress, overrideMessage = null, allowRetry = false, failed = false) {
    const s = STRINGS.host;
    let panel = run.panel;
    if (!panel) {
      panel = el('section', undefined, 'update-progress');
      panel.setAttribute('aria-live', 'polite');
      panel.append(el('h3', s.updateProgressTitle));
      run.status = el('p', '', 'update-progress-message');
      run.steps = el('ol', undefined, 'update-progress-steps');
      panel.append(run.status, run.steps);
      run.step = el('p', '', 'muted update-progress-step');
      panel.append(run.step);
      run.panel = panel;
      this.updateProgressHost?.append(panel);
    }
    const stage = updateProgressStage(progress);
    const labels = [
      s.updateStageRequested,
      s.updateStageChecking,
      s.updateStageDownloading,
      s.updateStageVerifying,
      s.updateStageInstalling,
      s.updateStageRestarting,
      s.updateStageDone,
      s.updateStageFailed,
    ];
    run.steps.replaceChildren(
      // Failed is a step only when the run ended that way.
      ...updateChecklist(progress)
        .map(({ stage: key, current }, index) => ({ key, current, label: labels[index] }))
        .filter(({ key, current }) => key !== 'failed' || current)
        .map(({ current, label }) => {
          const item = el('li', label);
          if (current) item.setAttribute('aria-current', 'step');
          return item;
        }),
    );
    const text = overrideMessage ?? progress?.message ?? s.updateWaiting;
    run.status.className = failed || allowRetry ? 'error-message update-progress-message' : 'update-progress-message';
    run.status.textContent = text;
    run.step.textContent = stage === 'installing' && progress?.step ? progress.step : '';
    run.step.hidden = !(stage === 'installing' && progress?.step);
    if (allowRetry && run.request) {
      const retry = el('button', s.tryAgain, 'button secondary');
      retry.type = 'button';
      retry.addEventListener('click', () => void this.beginUpdate(run.button, run.note, run.message, run.request));
      panel.append(retry);
    }
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
