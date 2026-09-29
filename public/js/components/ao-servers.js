import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { mapName } from '../lib/wizard.js';
import { stateName } from '../lib/format.js';
import { parseCountdown } from '../lib/cron-picker.js';
import { GENERIC_MAP_ART, markArtFailed, railPictureUrl } from '../lib/map-art.js';

const s = STRINGS.servers;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export class AoServers extends HTMLElement {
  async connectedCallback() {
    this.selected = new Set();
    this.onServers = ({ detail }) => {
      if (!detail.servers) return;
      this.servers = detail.servers;
      this.render();
    };
    this.closest('ao-app')?.addEventListener('servers-loaded', this.onServers);
    try {
      [this.servers, this.maps] = await Promise.all([api.get('/api/servers'), api.get('/api/maps').catch(() => null)]);
      this.render();
    } catch (cause) {
      this.replaceChildren(el('p', cause.message, 'error-message'));
    }
  }
  disconnectedCallback() {
    this.closest('ao-app')?.removeEventListener('servers-loaded', this.onServers);
    clearTimeout(this.jobTimer);
  }
  render() {
    const actionValue = this.querySelector('.fleet-action-form select')?.value ?? 'start';
    const countdownValue = this.querySelector('.fleet-action-form input')?.value ?? '10, 5, 1';
    this.replaceChildren();
    this.className = 'screen servers-screen';
    this.append(el('h1', s.title));
    this.message = el('p', '', 'error-message');
    this.message.setAttribute('aria-live', 'polite');
    this.append(this.message);
    if (!this.servers?.length) {
      this.append(el('p', s.empty, 'muted'));
      return;
    }
    const all = el('label', undefined, 'fleet-select-all');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.checked = this.servers.every((server) => this.selected.has(server.id));
    selectAll.addEventListener('change', () => {
      this.selected = selectAll.checked ? new Set(this.servers.map((server) => server.id)) : new Set();
      for (const choice of this.querySelectorAll('.servers-row input[type="checkbox"]'))
        choice.checked = selectAll.checked;
    });
    all.append(selectAll, el('span', s.selectAll));
    this.append(all);
    const list = el('div', undefined, 'servers-list');
    for (const server of this.servers) {
      const row = el('div', undefined, 'card servers-row');
      const choice = document.createElement('input');
      choice.type = 'checkbox';
      choice.checked = this.selected.has(server.id);
      choice.setAttribute('aria-label', s.select.replace('{name}', server.name));
      choice.addEventListener('change', () => {
        if (choice.checked) this.selected.add(server.id);
        else this.selected.delete(server.id);
        selectAll.checked = this.servers.every((item) => this.selected.has(item.id));
      });
      const image = document.createElement('img');
      const want = railPictureUrl(server, this.maps);
      image.src = want;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        markArtFailed(want);
        if (!image.src.endsWith(GENERIC_MAP_ART)) image.src = GENERIC_MAP_ART;
      });
      const details = el('div', undefined, 'servers-info');
      const link = el('a', server.name);
      link.href = `#/servers/${server.id}/overview`;
      details.append(link, el('span', `${mapName(server.map)} · ${stateName(server.status?.observedState)}`, 'muted'));
      if (server.cluster_name) {
        const clusterLabel = STRINGS.fleet.clusterLabel;
        details.append(el('span', clusterLabel.replace('{name}', server.cluster_name), 'muted'));
      }
      row.append(choice, image, details);
      list.append(row);
    }
    this.append(list);
    const form = el('div', undefined, 'card fleet-action-form');
    const action = document.createElement('select');
    for (const key of ['start', 'stop', 'restart', 'update']) action.append(new Option(s[key], key));
    action.value = actionValue;
    const countdown = document.createElement('input');
    countdown.value = countdownValue;
    countdown.inputMode = 'numeric';
    const countdownLabel = el('label', undefined, 'field-label');
    // The help sits inside the label, so it hides with the field for Start and Stop.
    countdownLabel.append(el('span', s.countdown), countdown, el('small', s.countdownHelp, 'muted'));
    action.addEventListener('change', () => {
      countdownLabel.hidden = !['restart', 'update'].includes(action.value);
    });
    countdownLabel.hidden = !['restart', 'update'].includes(action.value);
    const run = el('button', s.run, 'button primary');
    run.type = 'button';
    run.addEventListener('click', async () => {
      if (!this.selected.size) return;
      const marks = parseCountdown(countdown.value);
      if (['restart', 'update'].includes(action.value) && !marks) {
        this.message.textContent = s.countdownHelp;
        return;
      }
      const okay = await document
        .querySelector('ao-dialog')
        .ask(s[action.value], s.confirm.replace('{action}', s[action.value]).replace('{count}', this.selected.size));
      if (!okay) return;
      try {
        this.message.textContent = '';
        const job = await api.post('/api/fleet/actions', {
          action: action.value,
          serverIds: this.servers.filter((server) => this.selected.has(server.id)).map((server) => server.id),
          options: ['restart', 'update'].includes(action.value) ? { countdownMinutes: marks } : {},
        });
        this.follow(job.jobId);
      } catch (cause) {
        this.message.textContent = cause.message;
      }
    });
    form.append(action, countdownLabel, run);
    this.jobStatus = el('p', '', 'muted');
    this.jobStatus.setAttribute('aria-live', 'polite');
    this.cancel = el('button', s.cancel, 'button quiet');
    this.cancel.hidden = true;
    this.cancel.addEventListener('click', () =>
      api.post(`/api/jobs/${this.jobId}/cancel`, {}).catch((cause) => {
        this.message.textContent = cause.message;
      }),
    );
    form.append(this.jobStatus, this.cancel);
    this.append(form);
    if (this.jobId) this.follow(this.jobId);
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
          this.cancel.hidden = !['queued', 'running'].includes(job.state);
          if (job.result) {
            const names = (ids) =>
              ids.map((value) => this.servers.find((server) => server.id === value)?.name ?? value).join(', ');
            this.jobStatus.textContent += ` ${s.completed.replace('{names}', names(job.result.completed))} ${s.skipped.replace('{names}', names(job.result.skipped))}`;
          }
          if (this.cancel.hidden) return;
        }
      } catch (cause) {
        this.message.textContent = cause.message;
      }
      this.jobTimer = setTimeout(tick, 1500);
    };
    this.jobTimer = setTimeout(tick, 100);
  }
}
customElements.define('ao-servers', AoServers);
