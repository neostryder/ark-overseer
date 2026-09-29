import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { mapName } from '../lib/wizard.js';
import { stateName } from '../lib/format.js';
import { GENERIC_MAP_ART, markArtFailed, railPictureUrl } from '../lib/map-art.js';
import { searchFields, validateField } from '../lib/settings.js';
import { createSettingInput, readSettingInput } from '../lib/settings-controls.js';
import { parseCountdown } from '../lib/cron-picker.js';

const s = STRINGS.clusters;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, run, className = 'button secondary') {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', run);
  return node;
}
function label(text, control) {
  const node = el('label', undefined, 'field-label');
  node.append(el('span', text), control);
  return node;
}
export class AoClusters extends HTMLElement {
  async connectedCallback() {
    this.clusterId = Number(this.getAttribute('cluster-id')) || null;
    await this.load();
  }
  disconnectedCallback() {
    clearTimeout(this.jobTimer);
  }
  async load() {
    this.replaceChildren(el('p', STRINGS.app.loading));
    try {
      if (this.clusterId) {
        [this.cluster, this.servers, this.fields, this.maps, this.schedules] = await Promise.all([
          api.get(`/api/clusters/${this.clusterId}`),
          api.get('/api/servers'),
          api.get('/api/settings/fields'),
          api.get('/api/maps').catch(() => null),
          api.get(`/api/clusters/${this.clusterId}/schedules`),
        ]);
        this.draft = { ...this.cluster.settings };
      } else this.clusters = await api.get('/api/clusters');
      this.render();
    } catch (cause) {
      this.replaceChildren(
        el('p', cause.message, 'error-message'),
        button(STRINGS.app.retry, () => this.load()),
      );
    }
  }
  report(cause) {
    this.message.textContent = cause.message || String(cause);
  }
  async change(task) {
    try {
      this.notice = null;
      await task();
      await this.load();
    } catch (cause) {
      this.report(cause);
    }
  }
  render() {
    this.replaceChildren();
    this.className = 'screen cluster-screen';
    const back = el('a', s.title, 'button quiet');
    back.href = '#/clusters';
    if (this.clusterId) this.append(back);
    this.append(el('h1', this.cluster?.name ?? s.title));
    this.message = el('p', '', 'error-message');
    this.message.setAttribute('aria-live', 'polite');
    this.append(this.message);
    if (this.clusterId) this.renderDetail();
    else this.renderList();
  }
  renderList() {
    const list = el('div', undefined, 'cluster-list');
    for (const cluster of this.clusters) {
      const link = el('a', cluster.name, 'card cluster-list-link');
      link.href = `#/clusters/${cluster.id}`;
      const count = el('small', `${cluster.members.length} ${s.members.toLowerCase()}`, 'muted');
      link.append(count);
      list.append(link);
    }
    if (!this.clusters.length) list.append(el('p', s.empty, 'muted'));
    this.append(list);
    const form = el('section', undefined, 'card cluster-form');
    form.append(el('h2', s.create));
    const name = document.createElement('input');
    name.maxLength = 64;
    const folder = document.createElement('input');
    const notes = document.createElement('textarea');
    notes.maxLength = 2000;
    form.append(label(s.name, name), label(s.folder, folder), el('p', s.folderHelp, 'muted'), label(s.notes, notes));
    form.append(
      button(
        s.create,
        () =>
          this.change(async () => {
            const cluster = await api.post('/api/clusters', {
              name: name.value,
              shared_dir: folder.value || null,
              notes: notes.value,
            });
            window.location.hash = `#/clusters/${cluster.id}`;
          }),
        'button primary',
      ),
    );
    this.append(form);
  }
  renderDetail() {
    const cluster = this.cluster;
    const details = el('section', undefined, 'card cluster-form');
    const name = document.createElement('input');
    name.value = cluster.name;
    name.maxLength = 64;
    const notes = document.createElement('textarea');
    notes.value = cluster.notes ?? '';
    notes.maxLength = 2000;
    const folder = document.createElement('input');
    folder.value = cluster.shared_dir;
    details.append(
      label(s.name, name),
      label(s.notes, notes),
      label(s.folder, folder),
      button(
        s.copyFolder,
        async () => {
          try {
            await navigator.clipboard.writeText(folder.value);
            this.message.textContent = s.copied;
          } catch (cause) {
            this.report(cause);
          }
        },
        'button quiet',
      ),
      el('p', s.folderHelp, 'muted'),
    );
    const idRow = el('div', undefined, 'cluster-id-row');
    idRow.append(
      el('strong', s.id),
      el('code', cluster.cluster_key),
      button(s.copy, async () => {
        try {
          await navigator.clipboard.writeText(cluster.cluster_key);
          this.message.textContent = s.copied;
        } catch (cause) {
          this.report(cause);
        }
      }),
    );
    details.append(idRow);
    details.append(
      button(
        s.save,
        () =>
          this.change(async () => {
            const result = await api.patch(`/api/clusters/${cluster.id}`, {
              name: name.value,
              notes: notes.value,
              ...(folder.value !== cluster.shared_dir ? { shared_dir: folder.value } : {}),
            });
            if (result.appliesAtNextStart) this.notice = s.nextStart;
          }),
        'button primary',
      ),
    );
    if (!cluster.members.length)
      details.append(
        button(
          s.delete,
          async () => {
            if (!(await document.querySelector('ao-dialog').ask(s.delete, s.deleteConfirm, s.delete))) return;
            await this.change(async () => {
              await api.del(`/api/clusters/${cluster.id}`);
              window.location.hash = '#/clusters';
            });
          },
          'button quiet',
        ),
      );
    this.append(details);
    if (this.notice) this.append(el('p', this.notice, 'card restart-banner'));
    this.renderMembers();
    this.renderSettings();
    this.renderActions();
    this.renderSchedule();
  }
  renderMembers() {
    const section = el('section', undefined, 'card');
    section.append(el('h2', s.members));
    if (!this.cluster.members.length) section.append(el('p', s.noMembers, 'muted'));
    for (const member of this.cluster.members) {
      const row = el('div', undefined, 'cluster-member');
      const image = document.createElement('img');
      image.alt = '';
      image.width = 460;
      image.height = 215;
      image.loading = 'lazy';
      image.src = railPictureUrl(member, this.maps);
      image.addEventListener(
        'error',
        () => {
          markArtFailed(image.src);
          image.src = GENERIC_MAP_ART;
        },
        { once: true },
      );
      const info = el('div', undefined, 'cluster-member-info');
      const link = el('a', member.name);
      link.href = `#/servers/${member.id}/overview`;
      info.append(link, el('span', `${mapName(member.map)}, ${stateName(member.status?.observedState)}`, 'muted'));
      const remove = button(
        s.remove,
        async () => {
          if (
            !(await document
              .querySelector('ao-dialog')
              .ask(s.remove, s.removeConfirm.replace('{name}', member.name), s.remove))
          )
            return;
          await this.change(async () => {
            const result = await api.del(`/api/clusters/${this.clusterId}/members/${member.id}`);
            if (result.appliesAtNextStart) this.notice = s.nextStart;
          });
        },
        'button quiet',
      );
      row.append(image, info, remove);
      section.append(row);
    }
    const available = this.servers.filter((server) => !server.cluster_id);
    if (available.length) {
      const picker = document.createElement('select');
      picker.setAttribute('aria-label', s.addMember);
      for (const server of available) picker.append(new Option(`${server.name} (${mapName(server.map)})`, server.id));
      section.append(
        el('h3', s.addMember),
        picker,
        button(s.addMember, () =>
          this.change(async () => {
            const result = await api.post(`/api/clusters/${this.clusterId}/members`, {
              serverId: Number(picker.value),
            });
            if (result.appliesAtNextStart) this.notice = s.nextStart;
          }),
        ),
      );
    } else section.append(el('p', s.noAvailable, 'muted'));
    this.append(section);
  }
  renderSettings() {
    const section = el('section', undefined, 'card cluster-settings');
    section.append(el('h2', s.sharedSettings));
    const fields = this.fields.filter((field) => !field.locked && !field.launchFlag && field.type !== 'password');
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const selected = el('div', undefined, 'cluster-setting-list');
    const drawSelected = () => {
      selected.replaceChildren();
      for (const [key, value] of Object.entries(this.draft)) {
        const field = byKey.get(key);
        if (!field) continue;
        const row = el('div', undefined, 'setting-field card');
        const { input } = createSettingInput(field, value, `cluster-setting-${key}`);
        const validation = el('small', '', 'error-message');
        input.addEventListener('input', () => {
          this.draft[key] = readSettingInput(field, input);
          validation.textContent = validateField(field, this.draft[key]);
        });
        row.append(
          label(field.label, input),
          el('p', field.description, 'muted'),
          validation,
          button(
            s.removeSetting,
            () => {
              delete this.draft[key];
              drawSelected();
            },
            'button quiet',
          ),
        );
        selected.append(row);
      }
      if (!selected.childElementCount) selected.append(el('p', s.noSettings, 'muted'));
    };
    drawSelected();
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = s.search;
    search.setAttribute('aria-label', s.search);
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', s.addSetting);
    const drawPicker = () => {
      picker.replaceChildren();
      const pool = fields.filter((field) => !Object.hasOwn(this.draft, field.key));
      const found = search.value
        ? searchFields(pool, search.value)
        : [
            ...pool.filter((field) => field.category === 'Transfers'),
            ...pool.filter((field) => field.category !== 'Transfers'),
          ];
      for (const field of found) picker.append(new Option(`${field.label} (${field.category})`, field.key));
    };
    search.addEventListener('input', drawPicker);
    drawPicker();
    section.append(
      selected,
      search,
      picker,
      button(s.addSetting, () => {
        if (!picker.value) return;
        const field = byKey.get(picker.value);
        this.draft[field.key] = field.type === 'bool' ? false : null;
        drawSelected();
        drawPicker();
      }),
      button(
        s.saveSettings,
        () =>
          this.change(async () => {
            for (const [key, value] of Object.entries(this.draft)) {
              const field = byKey.get(key);
              if (!field) {
                delete this.draft[key];
                continue;
              }
              const invalid = validateField(field, value);
              if (invalid) throw new Error(`${field.label}: ${invalid}`);
            }
            const result = await api.put(`/api/clusters/${this.clusterId}/settings`, this.draft);
            if (result.appliesAtNextRestart) this.notice = s.nextRestart;
            if (result.jobs?.length) this.follow(result.jobs.at(-1).id);
          }),
        'button primary',
      ),
    );
    this.append(section);
  }
  renderActions() {
    const actions = el('section', undefined, 'card');
    const row = el('div', undefined, 'button-row');
    for (const action of ['restart', 'start', 'stop'])
      row.append(
        button(s[action], async () => {
          const okay = await document
            .querySelector('ao-dialog')
            .ask(
              s[action],
              s.confirmAction.replace('{action}', s[action]).replace('{name}', this.cluster.name),
              s[action],
            );
          if (!okay) return;
          try {
            const job = await api.post(`/api/clusters/${this.clusterId}/${action}`, {});
            this.follow(job.jobId);
          } catch (cause) {
            this.report(cause);
          }
        }),
      );
    this.jobStatus = el('p', '', 'muted');
    this.jobStatus.setAttribute('aria-live', 'polite');
    this.jobCancel = button(
      s.cancel,
      async () => {
        if (!this.jobId) return;
        try {
          await api.post(`/api/jobs/${this.jobId}/cancel`, {});
        } catch (cause) {
          this.report(cause);
        }
      },
      'button quiet',
    );
    this.jobCancel.hidden = true;
    actions.append(row, this.jobStatus, this.jobCancel);
    this.append(actions);
  }
  follow(id) {
    clearTimeout(this.jobTimer);
    this.jobId = id;
    const tick = async () => {
      if (!this.isConnected) return;
      try {
        const job = (await api.get('/api/jobs')).find((item) => item.id === id);
        if (job) {
          this.jobStatus.textContent = `${s.progress}: ${job.message || job.state}${job.progress == null ? '' : ` (${Math.round(job.progress * 100)}%)`}${job.error ? ` ${job.error}` : ''}`;
          this.jobCancel.hidden = !['queued', 'running'].includes(job.state);
          if (this.jobCancel.hidden) return;
        }
      } catch (cause) {
        this.report(cause);
      }
      this.jobTimer = setTimeout(tick, 1500);
    };
    this.jobTimer = setTimeout(tick, 100);
  }
  renderSchedule() {
    const schedule = this.schedules.find((item) => item.kind === 'cluster_restart');
    const section = el('section', undefined, 'card cluster-form');
    section.append(el('h2', s.schedule), el('p', s.scheduleHelp, 'muted'));
    const cron = document.createElement('input');
    cron.value = schedule?.cron ?? '0 5 * * *';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = schedule?.enabled ?? true;
    const countdown = document.createElement('input');
    countdown.value = (schedule?.options?.countdownMinutes ?? [10, 5, 1]).join(', ');
    countdown.inputMode = 'numeric';
    const announce = document.createElement('select');
    for (const kind of ['chat', 'broadcast']) announce.append(new Option(STRINGS.automation.announce[kind], kind));
    announce.value = schedule?.options?.announce ?? 'chat';
    section.append(
      label(s.cron, cron),
      label(STRINGS.automation.enabled, enabled),
      label(STRINGS.automation.countdown, countdown),
      el('p', STRINGS.automation.countdownHelp, 'muted'),
      label(STRINGS.automation.announceLabel, announce),
    );
    section.append(
      button(s.scheduleSave, () =>
        this.change(() => {
          const marks = parseCountdown(countdown.value);
          if (!marks) throw new Error(STRINGS.automation.countdownHelp);
          return api.put(`/api/clusters/${this.clusterId}/schedules/restart`, {
            cron: cron.value,
            enabled: enabled.checked,
            options: { countdownMinutes: marks, announce: announce.value },
          });
        }),
      ),
    );
    if (schedule)
      section.append(
        button(
          s.scheduleRemove,
          () => this.change(() => api.del(`/api/clusters/${this.clusterId}/schedules/restart`)),
          'button quiet',
        ),
      );
    this.append(section);
  }
}
customElements.define('ao-clusters', AoClusters);
