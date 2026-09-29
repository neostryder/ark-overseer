import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { byteSize, jobState } from '../lib/format.js';
import { icon } from '../lib/icon.js';
import { createInstallFolderPicker } from '../lib/install-folder.js';
import {
  MAPS,
  PRESETS,
  MIN_FREE_BYTES,
  PLAYER_LIMIT,
  isAbsolutePath,
  validateServerStep,
  validatePorts,
  generatePassword,
  settingsBody,
  createPlan,
  mapName,
} from '../lib/wizard.js';

const NEW_FLOW = ['welcome', 'host', 'steamcmd', 'server', 'preset', 'network', 'passwords', 'review'];
const IMPORT_FLOW = ['welcome', 'import'];
const POLL_MS = 2000;
const newPassword = () =>
  generatePassword(crypto.getRandomValues(new Uint8Array(40)), (n) => crypto.getRandomValues(new Uint8Array(n)));

function node(tag, text, className = '') {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  if (text !== undefined && tag === 'dd') el.title = text;
  return el;
}
function button(text, className, onClick, iconName) {
  const b = node('button', undefined, `button ${className}`);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  b.append(text);
  b.addEventListener('click', onClick);
  return b;
}
// A labelled control with an error line under it that showErrors() can find by key.
function field(label, control, key) {
  const wrap = node('label', undefined, 'field-label wizard-field');
  wrap.append(node('span', label), control);
  const error = node('small', '', 'error-message');
  error.dataset.wizardError = key;
  wrap.append(error);
  return wrap;
}

export class AoSetupWizard extends HTMLElement {
  constructor() {
    super();
    this.reset();
  }
  reset() {
    this.flow = NEW_FLOW;
    this.index = 0;
    this.dirty = false;
    this.finished = null;
    this.s = {
      installId: null,
      installPath: '',
      name: '',
      sessionName: '',
      map: MAPS[0].id,
      customMap: false,
      maxPlayers: null,
      presetId: 'default',
      gamePort: null,
      queryPort: null,
      rconPort: null,
      adminPassword: '',
      joinPassword: '',
      dashboardDir: '',
    };
    // What the Review step has already created, so a retry never repeats a request that succeeded.
    this.created = { install: false, server: false, settings: false, serverId: null, installJobId: null };
    this.lines = {};
  }
  connectedCallback() {
    this.render();
  }
  disconnectedCallback() {
    this.stopPoll();
  }
  hasChanges() {
    return this.dirty;
  }
  get step() {
    return this.flow[this.index];
  }
  changed() {
    this.dirty = true;
  }
  go(stepName) {
    const at = this.flow.indexOf(stepName);
    if (at >= 0) this.index = at;
    this.render();
  }

  // One poller at a time. A job that ends in any state but succeeded is a failure.
  poll(jobId, onUpdate, onDone) {
    this.stopPoll();
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get('/api/jobs')).find((item) => item.id === jobId);
        if (job) onUpdate(job);
        if (job && !['queued', 'running'].includes(job.state)) {
          onDone(job);
          return;
        }
      } catch (error) {
        onUpdate({ error: error.message });
      }
      if (this.isConnected) this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }
  stopPoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  render() {
    const w = STRINGS.wizard;
    this.replaceChildren();
    this.className = 'screen setup-wizard';
    this.append(node('h1', w.title));
    if (this.finished) {
      this.renderFinish();
      return;
    }
    const steps = node('ol', undefined, 'wizard-steps');
    steps.setAttribute('aria-label', w.stepsLabel);
    this.flow.forEach((name, i) => {
      const li = node('li', w.steps[name]);
      if (i === this.index) li.setAttribute('aria-current', 'step');
      steps.append(li);
    });
    this.append(steps);
    const panel = node('section', undefined, 'card wizard-panel');
    panel.append(node('h2', w.steps[this.step]));
    this.message = node('p', '', 'error-message');
    this.message.setAttribute('aria-live', 'polite');
    this[`render_${this.step}`](panel);
    const controls = node('div', undefined, 'wizard-controls');
    if (this.index > 0 && !this.created.settings)
      controls.append(
        button(w.back, 'quiet', () => {
          this.index -= 1;
          if (this.index === 0) this.flow = NEW_FLOW;
          this.render();
        }),
      );
    if (this.index > 0 && this.index < this.flow.length - 1) {
      const next = button(w.next, 'primary', () => this.next(next), 'chevron');
      controls.append(next);
    }
    panel.append(this.message, controls);
    this.append(panel);
  }
  showErrors(errors) {
    const w = STRINGS.wizard;
    for (const n of this.querySelectorAll('[data-wizard-error]')) n.textContent = '';
    for (const [key, code] of Object.entries(errors)) {
      const n = this.querySelector(`[data-wizard-error="${key}"]`);
      if (n) n.textContent = w.errors[code] || w.errors.required;
    }
    this.message.textContent = Object.keys(errors).length ? w.fixFirst : '';
    return Object.keys(errors).length === 0;
  }
  async next(nextButton) {
    const w = STRINGS.wizard,
      s = this.s;
    if (this.step === 'host' && !this.host) {
      this.message.textContent = w.loadingHost;
      return;
    }
    if (this.step === 'steamcmd') {
      nextButton.disabled = true;
      try {
        this.host = await api.get('/api/host');
      } catch (error) {
        this.message.textContent = error.message;
        return;
      } finally {
        nextButton.disabled = false;
      }
      if (!this.host.steamcmd.installed) {
        this.message.textContent = w.steamFirst;
        return;
      }
    }
    if (this.step === 'server') {
      if (!this.showErrors(validateServerStep({ ...s, installs: this.installs }))) return;
    }
    if (this.step === 'network' && !this.showErrors(validatePorts(s))) return;
    if (this.step === 'passwords') {
      const errors = {};
      const bad = (value) => value.length > 64 || value.includes('?');
      if (!s.adminPassword || bad(s.adminPassword)) errors.adminPassword = 'password';
      if (bad(s.joinPassword)) errors.joinPassword = 'password';
      if (!this.showErrors(errors)) return;
    }
    this.index += 1;
    this.render();
  }

  render_welcome(panel) {
    const w = STRINGS.wizard;
    panel.append(node('p', w.welcome));
    const choices = node('div', undefined, 'wizard-choices');
    for (const [flow, label, help, iconName] of [
      [NEW_FLOW, w.newServer, w.newServerHelp, 'add'],
      [IMPORT_FLOW, w.import, w.importHelp, 'server'],
    ]) {
      const b = button(
        label,
        'secondary wizard-choice',
        () => {
          this.flow = flow;
          this.index = 1;
          this.changed();
          this.render();
        },
        iconName,
      );
      b.append(node('small', help, 'muted'));
      choices.append(b);
    }
    panel.append(choices);
  }
  render_host(panel) {
    const w = STRINGS.wizard;
    const info = node('dl', undefined, 'wizard-summary');
    const show = () => {
      info.replaceChildren();
      const h = this.host;
      for (const [label, value] of [
        [w.computer, h.hostname],
        [w.cpu, h.cpuCount],
        [w.memory, byteSize(h.memoryBytes)],
        [w.free, byteSize(h.freeDiskBytes)],
        [w.steam, h.steamcmd.installed ? w.yes : w.no],
        [w.elevated, h.elevated ? w.yes : w.no],
      ])
        info.append(node('dt', label), node('dd', String(value)));
      if (h.freeDiskBytes < MIN_FREE_BYTES) panel.insertBefore(node('p', w.lowSpace, 'wizard-warning'), retry);
      if (!h.elevated) panel.insertBefore(node('p', w.notElevated, 'wizard-warning'), retry);
    };
    const load = async () => {
      retry.disabled = true;
      this.message.textContent = '';
      info.replaceChildren(node('p', w.loadingHost));
      try {
        this.host = await api.get('/api/host');
        for (const warning of panel.querySelectorAll('.wizard-warning')) warning.remove();
        show();
      } catch (error) {
        info.replaceChildren();
        this.message.textContent = error.message;
      } finally {
        retry.disabled = false;
      }
    };
    const retry = button(w.retry, 'quiet', load);
    panel.append(info, retry);
    load();
  }
  render_steamcmd(panel) {
    const w = STRINGS.wizard;
    if (this.host?.steamcmd.installed) {
      panel.append(node('p', w.steamInstalled));
      return;
    }
    panel.append(node('p', w.steamNeeded));
    const status = node('p', '', 'wizard-progress');
    status.setAttribute('aria-live', 'polite');
    const setup = button(w.steamSetup, 'primary', async () => {
      setup.disabled = true;
      this.message.textContent = '';
      let job;
      try {
        job = await api.post('/api/steamcmd/setup', {});
      } catch (error) {
        this.message.textContent = error.message;
        setup.disabled = false;
        return;
      }
      // The button stays disabled while the job runs, so a second click cannot start a second setup.
      this.poll(
        job.id,
        (current) => {
          status.textContent =
            current.error ?? `${jobState(current.state)} ${Math.round((current.progress || 0) * 100)}%`;
        },
        async (done) => {
          if (done.state !== 'succeeded') {
            status.textContent = '';
            this.message.textContent = done.error || jobState(done.state);
            setup.disabled = false;
            return;
          }
          try {
            this.host = await api.get('/api/host');
            this.render();
          } catch (error) {
            this.message.textContent = error.message;
            setup.disabled = false;
          }
        },
      );
    });
    panel.append(setup, status);
  }
  render_server(panel) {
    const w = STRINGS.wizard,
      s = this.s;
    s.maxPlayers ??= PLAYER_LIMIT.default;
    if (!this.installs) {
      panel.append(node('p', STRINGS.app.loading));
      this.loadInstalls().then(
        () => {
          if (this.step === 'server') this.render();
        },
        (error) => {
          this.message.textContent = error.message;
        },
      );
      return;
    }
    const input = (key, type = 'text') => {
      const el = document.createElement('input');
      el.type = type;
      if (type === 'number') el.inputMode = 'numeric';
      else el.inputMode = 'text';
      el.enterKeyHint = 'next';
      el.value = s[key] ?? '';
      el.addEventListener('input', () => {
        s[key] = type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
        this.changed();
      });
      return el;
    };
    const install = document.createElement('select');
    install.append(new Option(w.newInstall, ''));
    for (const item of this.installs)
      install.append(
        new Option(`${item.path} (${item.state}, ${STRINGS.overview.sources[item.source] ?? item.source})`, item.id),
      );
    install.value = s.installId ?? '';
    install.addEventListener('change', () => {
      s.installId = install.value ? Number(install.value) : null;
      this.changed();
      this.render();
    });
    panel.append(field(w.install, install, 'installId'));
    if (!s.installId) {
      const folder = input('installPath');
      folder.placeholder = w.folderExample;
      panel.append(
        field(w.folder, folder, 'installPath'),
        createInstallFolderPicker(folder, this.host?.path || 'C:\\'),
        node('p', w.folderHelp, 'muted'),
      );
    }
    panel.append(field(w.name, input('name'), 'name'));
    panel.append(field(w.sessionName, input('sessionName'), 'sessionName'));
    const map = document.createElement('select');
    for (const item of MAPS) map.append(new Option(item.name, item.id));
    map.append(new Option(w.otherMap, ''));
    map.value = s.customMap ? '' : s.map;
    map.addEventListener('change', () => {
      s.customMap = map.value === '';
      s.map = map.value;
      this.changed();
      this.render();
    });
    panel.append(field(w.map, map, s.customMap ? 'mapChoice' : 'map'));
    if (s.customMap) panel.append(field(w.mapId, input('map'), 'map'));
    const note = MAPS.find((item) => item.id === s.map)?.note;
    if (note) panel.append(node('p', w.clubArkNote, 'wizard-warning'));
    const players = input('maxPlayers', 'number');
    players.min = PLAYER_LIMIT.min;
    players.max = PLAYER_LIMIT.max;
    panel.append(field(w.maxPlayers, players, 'maxPlayers'));
  }
  async loadInstalls() {
    this.installs = await api.get('/api/installs');
  }
  render_preset(panel) {
    const w = STRINGS.wizard;
    const group = node('fieldset', undefined, 'wizard-fieldset');
    group.append(node('legend', w.presetLegend));
    for (const preset of PRESETS) {
      const label = node('label', undefined, 'wizard-radio');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'preset';
      radio.checked = this.s.presetId === preset.id;
      radio.addEventListener('change', () => {
        this.s.presetId = preset.id;
        this.changed();
      });
      const text = node('span');
      text.append(node('strong', w.presets[preset.id].name), node('span', ` ${w.presets[preset.id].description}`));
      label.append(radio, text);
      group.append(label);
    }
    panel.append(group, node('p', w.later, 'muted'));
  }
  render_network(panel) {
    const w = STRINGS.wizard,
      s = this.s;
    const peer = node('p');
    const showPeer = () => {
      peer.textContent = `${w.peerPort}: ${Number.isInteger(s.gamePort) ? s.gamePort + 1 : w.peerUnknown}`;
    };
    for (const key of ['gamePort', 'queryPort', 'rconPort']) {
      const el = document.createElement('input');
      el.type = 'number';
      el.inputMode = 'numeric';
      el.enterKeyHint = 'next';
      el.min = 1;
      el.max = 65535;
      el.value = s[key] ?? '';
      el.addEventListener('input', () => {
        s[key] = el.value === '' ? null : Number(el.value);
        this.changed();
        showPeer();
      });
      panel.append(field(w[key], el, key));
    }
    showPeer();
    panel.append(peer, node('p', w.portCheck, 'muted'), node('p', w.firewallLater, 'muted'));
    if (!this.portsSuggested) {
      this.portsSuggested = true;
      api.get('/api/ports/suggest').then(
        (ports) => {
          for (const key of ['gamePort', 'queryPort', 'rconPort']) s[key] ??= ports[key] ?? null;
          if (this.step === 'network') this.render();
        },
        (error) => {
          this.message.textContent = error.message;
        },
      );
    }
  }
  render_passwords(panel) {
    const w = STRINGS.wizard,
      s = this.s;
    s.adminPassword ||= newPassword();
    const password = (key, label, note, withNew) => {
      const el = document.createElement('input');
      el.type = 'password';
      el.autocomplete = 'new-password';
      el.maxLength = 64;
      el.value = s[key];
      el.addEventListener('input', () => {
        s[key] = el.value;
        this.changed();
      });
      const row = node('div', undefined, 'wizard-password');
      row.append(field(label, el, key));
      const toggle = button(w.show, 'quiet', () => {
        el.type = el.type === 'password' ? 'text' : 'password';
        toggle.textContent = el.type === 'password' ? w.show : w.hide;
      });
      row.append(toggle);
      if (withNew)
        row.append(
          button(w.newPassword, 'secondary', () => {
            s[key] = newPassword();
            el.value = s[key];
            this.changed();
          }),
        );
      panel.append(row, node('p', note, 'muted'));
    };
    password('adminPassword', w.adminPassword, w.adminNote, true);
    password('joinPassword', w.joinPassword, w.joinNote, false);
  }
  render_review(panel) {
    const w = STRINGS.wizard,
      s = this.s;
    const summary = node('dl', undefined, 'wizard-summary');
    const installPath = s.installId ? this.installs?.find((item) => item.id === s.installId)?.path : s.installPath;
    const hidden = (value) => (this.showPasswords ? value : '*'.repeat(8));
    for (const [label, value] of [
      [w.install, installPath],
      [w.name, s.name],
      [w.sessionName, s.sessionName],
      [w.map, mapName(s.map)],
      [w.maxPlayers, s.maxPlayers],
      [w.steps.preset, w.presets[s.presetId].name],
      [w.gamePort, s.gamePort],
      [w.peerPort, s.gamePort + 1],
      [w.queryPort, s.queryPort ?? w.none],
      [w.rconPort, s.rconPort ?? w.none],
      [w.adminPassword, hidden(s.adminPassword)],
      [w.joinPassword, s.joinPassword ? hidden(s.joinPassword) : w.noJoinPassword],
    ])
      summary.append(node('dt', label), node('dd', String(value ?? '')));
    const reveal = button(this.showPasswords ? w.hide : w.show, 'quiet', () => {
      this.showPasswords = !this.showPasswords;
      this.render();
    });
    panel.append(summary, reveal);
    const lines = node('ol', undefined, 'wizard-request-lines');
    lines.setAttribute('aria-live', 'polite');
    for (const item of createPlan(s)) {
      const line = node('li', undefined, 'wizard-request-line');
      this.lines[item.step] = line;
      this.drawLine(item.step);
      lines.append(line);
    }
    this.progress = node('p', this.progressText || '', 'wizard-progress');
    this.fixes = node('div', undefined, 'button-row');
    this.createButton = button(this.anyFailed ? w.retry : w.create, 'primary', () => this.create(), 'check');
    this.createButton.disabled = this.creating || this.installing;
    panel.append(lines, this.progress, this.fixes, this.createButton);
  }
  drawLine(stepName) {
    const w = STRINGS.wizard;
    const line = this.lines[stepName];
    if (!line) return;
    const label = { install: w.requestInstall, server: w.requestServer, settings: w.requestSettings }[stepName];
    const state = this.created[stepName] ? 'done' : (this.lineState?.[stepName] ?? 'waiting');
    line.replaceChildren(node('span', `${label}: ${w[state]}`));
    line.dataset.state = state;
    if (state === 'failed' && this.lineError?.[stepName])
      line.append(node('span', ` ${this.lineError[stepName]}`, 'error-message'));
  }
  async create() {
    const w = STRINGS.wizard,
      s = this.s;
    if (this.creating) return;
    this.creating = true;
    this.createButton.disabled = true;
    this.fixes.replaceChildren();
    this.lineState = {};
    this.lineError = {};
    this.anyFailed = false;
    const installId = () => s.installId ?? this.created.installId;
    try {
      for (const item of createPlan({ ...s, installId: installId() })) {
        if (this.created[item.step]) continue;
        this.lineState[item.step] = 'working';
        this.drawLine(item.step);
        try {
          if (item.step === 'install') {
            const result = await api.post('/api/installs', { path: s.installPath });
            this.created.installId = result.id;
            this.created.installJobId = result.jobId;
          } else if (item.step === 'server') {
            const server = await api.post('/api/servers', { ...item.body, installId: installId() });
            this.created.serverId = server.id;
          } else await api.put(`/api/servers/${this.created.serverId}/settings`, settingsBody(s));
        } catch (error) {
          this.lineState[item.step] = 'failed';
          this.lineError[item.step] = error.message;
          this.anyFailed = true;
          this.drawLine(item.step);
          this.offerFix(item.step, error);
          return;
        }
        this.created[item.step] = true;
        this.drawLine(item.step);
      }
      // Everything the user typed is now saved on the server, so leaving loses nothing.
      this.dirty = false;
      if (this.created.installJobId) this.watchInstall(this.created.installJobId);
      else this.finish(false);
    } finally {
      this.creating = false;
      if (this.createButton) this.createButton.disabled = this.installing;
      if (this.anyFailed) this.createButton.replaceChildren(icon('check'), w.retry);
    }
  }
  // A clash can be fixed on an earlier step; the retry then skips what succeeded.
  offerFix(stepName, error) {
    const w = STRINGS.wizard;
    if (error.status !== 409) return;
    if (stepName === 'install') {
      // The folder is already an install, perhaps from an attempt whose answer never arrived. Offer it.
      this.fixes.append(
        button(w.useExisting, 'secondary', async () => {
          try {
            await this.loadInstalls();
          } catch (loadError) {
            this.message.textContent = loadError.message;
            return;
          }
          const key = (p) =>
            p
              .replace(/[\\/]+$/, '')
              .replace(/\//g, '\\')
              .toLowerCase();
          const match = this.installs.find((item) => key(item.path) === key(this.s.installPath));
          if (match) this.s.installId = match.id;
          this.go('server');
        }),
      );
      return;
    }
    if (stepName !== 'server') return;
    for (const conflict of error.conflicts || [])
      this.fixes.append(node('p', `${conflict.port}: ${conflict.reason}`, 'error-message'));
    const target = error.conflicts?.length ? 'network' : 'server';
    this.fixes.append(button(target === 'network' ? w.goFix : w.fixName, 'secondary', () => this.go(target)));
  }
  watchInstall(jobId) {
    const w = STRINGS.wizard;
    this.installing = true;
    this.createButton.disabled = true;
    this.progressText = w.installRunning;
    this.progress.textContent = this.progressText;
    this.poll(
      jobId,
      (job) => {
        if (job.error && !job.state) return;
        this.progressText = `${w.installRunning} ${Math.round((job.progress || 0) * 100)}%`;
        if (this.progress) this.progress.textContent = this.progressText;
      },
      (job) => {
        this.installing = false;
        this.finish(false, job.state === 'succeeded' ? null : job.error || jobState(job.state));
      },
    );
  }
  finish(imported, installError = null) {
    this.stopPoll();
    this.dirty = false;
    this.finished = {
      serverId: imported ? imported.serverId : this.created.serverId,
      installId: this.created.installId,
      imported: Boolean(imported),
      installError,
    };
    document.querySelector('ao-app')?.loadServers?.();
    this.render();
  }
  renderFinish() {
    const w = STRINGS.wizard,
      f = this.finished;
    const card = node('section', undefined, 'card wizard-panel');
    card.append(node('h2', f.installError ? w.finishInstallFailed : w.finish));
    if (f.imported) card.append(node('p', w.importedStopped));
    if (f.installError) {
      card.append(node('p', f.installError, 'error-message'));
      const status = node('p', '', 'wizard-progress');
      status.setAttribute('aria-live', 'polite');
      // A failed first install leaves a folder SteamCMD can finish; validate fetches whatever is missing.
      const again = button(w.retryInstall, 'secondary', async () => {
        again.disabled = true;
        status.textContent = '';
        try {
          const job = await api.post(`/api/installs/${f.installId}/validate`, {});
          this.poll(
            job.id,
            (current) => {
              status.textContent = `${w.installRunning} ${Math.round((current.progress || 0) * 100)}%`;
            },
            (done) => {
              f.installError = done.state === 'succeeded' ? null : done.error || jobState(done.state);
              this.render();
            },
          );
        } catch (error) {
          status.textContent = error.message;
          again.disabled = false;
        }
      });
      card.append(again, status);
    } else card.append(node('p', f.imported ? w.finishImported : w.finishCreated));
    const links = node('div', undefined, 'button-row');
    for (const [text, page, iconName] of [
      [w.overview, 'overview', 'server'],
      [w.network, 'network', 'network'],
    ]) {
      const a = node('a', undefined, 'button primary');
      a.href = `#/servers/${Number(f.serverId)}/${page}`;
      a.append(icon(iconName), text);
      links.append(a);
    }
    card.append(links);
    this.append(card);
  }
  render_import(panel) {
    const w = STRINGS.wizard,
      s = this.s;
    const folder = document.createElement('input');
    folder.value = s.dashboardDir;
    folder.enterKeyHint = 'done';
    folder.placeholder = w.dashboardExample;
    folder.addEventListener('input', () => {
      s.dashboardDir = folder.value;
      this.changed();
    });
    panel.append(field(w.dashboardFolder, folder, 'dashboardDir'));
    const look = button(this.preview ? w.lookAgain : w.look, 'secondary', async () => {
      if (!this.showErrors(isAbsolutePath(s.dashboardDir) ? {} : { dashboardDir: 'badFolder' })) return;
      look.disabled = true;
      try {
        this.preview = await api.post('/api/import/preview', { dashboardDir: s.dashboardDir });
        this.profileId = null;
        this.render();
      } catch (error) {
        this.message.textContent = error.message;
      } finally {
        look.disabled = false;
      }
    });
    panel.append(look);
    if (this.importNotice) panel.append(node('p', this.importNotice, 'error-message'));
    if (!this.preview) return;
    if (!this.preview.servers.length) {
      panel.append(node('p', w.noServersFound));
      return;
    }
    const group = node('fieldset', undefined, 'wizard-fieldset');
    group.append(node('legend', w.choose));
    for (const found of this.preview.servers) {
      const row = node('label', undefined, 'wizard-radio wizard-import-row');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'profile';
      radio.disabled = !found.ok;
      radio.checked = this.profileId === found.profileId;
      radio.addEventListener('change', () => {
        this.profileId = found.profileId;
        importButton.disabled = false;
      });
      const text = node('span');
      const sv = found.server;
      text.append(
        node('strong', sv.name),
        node(
          'span',
          ` ${mapName(sv.map)}. ${w.gamePort} ${sv.game_port}, ${w.queryPort} ${sv.query_port ?? w.none}, ${w.rconPort} ${sv.rcon_port ?? w.none}.`,
        ),
        node('span', ` ${w.install}: ${found.install.path}.`),
        node('span', ` ${found.files.length} ${w.files}.`),
      );
      for (const [group2, className] of [
        ['problems', 'error-message'],
        ['conflicts', 'error-message'],
        ['warnings', 'wizard-warning'],
      ])
        for (const issue of found[group2] || [])
          text.append(node('span', `${w[group2]}: ${issue.message}`, `wizard-issue ${className}`));
      row.append(radio, text);
      group.append(row);
    }
    panel.append(group);
    const importButton = button(w.importNow, 'primary', () => this.applyImport(importButton), 'check');
    importButton.disabled = !this.profileId;
    panel.append(importButton);
  }
  async applyImport(importButton) {
    const w = STRINGS.wizard;
    if (!(await document.querySelector('ao-dialog').ask(w.confirmImportTitle, w.confirmImport, w.importNow))) return;
    importButton.disabled = true;
    try {
      const result = await api.post('/api/import/apply', { token: this.preview.token, profileId: this.profileId });
      this.importNotice = '';
      this.finish({ serverId: result.serverId });
    } catch (error) {
      // The server spends the preview token on every attempt, so any failure needs a fresh preview.
      this.preview = null;
      this.profileId = null;
      this.importNotice = error.status === 410 ? w.previewExpired : `${error.message} ${w.lookAgainHelp}`;
      this.render();
    }
  }
}
customElements.define('ao-setup-wizard', AoSetupWizard);
