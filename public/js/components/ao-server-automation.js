import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { byteSize, jobState } from '../lib/format.js';
import { icon } from '../lib/icon.js';
import { cronToPicker, pickerToCron, parseCountdown } from '../lib/cron-picker.js';

const KINDS = ['restart', 'backup', 'update_check', 'auto_update'];
const DEFAULTS = {
  restart: {
    picker: { type: 'daily', hour: 5, minute: 0 },
    options: { countdownMinutes: [10, 5, 1], announce: 'chat' },
  },
  backup: { picker: { type: 'hourly', hours: 6, minute: 0 }, options: { keep: 10 } },
  update_check: { picker: { type: 'hourly', hours: 6, minute: 30 }, options: {} },
  auto_update: {
    picker: { type: 'daily', hour: 4, minute: 0 },
    options: { countdownMinutes: [15, 5, 1], announce: 'chat', keep: 10 },
  },
};
const POLL_MS = 2000;

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function labelled(text, control) {
  const label = el('label', undefined, 'field-label');
  label.append(el('span', text), control);
  return label;
}
function when(iso) {
  return iso ? new Date(iso).toLocaleString() : STRINGS.automation.never;
}

export class AoServerAutomation extends HTMLElement {
  async connectedCallback() {
    this.id = this.getAttribute('server-id');
    await this.load();
  }
  disconnectedCallback() {
    clearTimeout(this.pollTimer);
  }
  async load() {
    this.replaceChildren(el('p', STRINGS.app.loading));
    try {
      [this.server, this.schedules, this.backups] = await Promise.all([
        api.get(`/api/servers/${this.id}`),
        api.get(`/api/servers/${this.id}/schedules`),
        api.get(`/api/servers/${this.id}/backups`),
      ]);
      this.render();
    } catch (error) {
      const retry = el('button', STRINGS.app.retry, 'button secondary');
      retry.addEventListener('click', () => this.load());
      this.replaceChildren(el('p', error.message, 'error-message'), retry);
    }
  }
  render() {
    const a = STRINGS.automation;
    this.replaceChildren();
    this.className = 'screen automation-screen';
    this.append(el('h1', a.title), el('p', a.intro, 'muted'));
    const steamOnly = this.server.install?.source === 'steam-client';
    for (const kind of KINDS) this.append(this.card(kind, steamOnly));
    this.append(this.backupSection());
  }
  card(kind, steamOnly) {
    const a = STRINGS.automation;
    const schedule = this.schedules.find((item) => item.kind === kind);
    const card = el('section', undefined, 'card automation-card');
    card.append(el('h2', a.kinds[kind].title), el('p', a.kinds[kind].help, 'muted'));
    if (steamOnly && (kind === 'update_check' || kind === 'auto_update')) {
      card.append(el('p', a.steam));
      return card;
    }
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.className = 'toggle';
    enabled.checked = schedule?.enabled ?? false;
    const switchLabel = el('label', undefined, 'check-row');
    switchLabel.append(enabled, el('span', a.enabled));
    card.append(switchLabel);

    // A cron set some other way is kept exactly as it is, since the picker cannot show it.
    const parsed = schedule ? cronToPicker(schedule.cron) : null;
    const custom = Boolean(schedule && !parsed);
    const picker = parsed ?? DEFAULTS[kind].picker;
    let readPicker = () => schedule.cron;
    if (custom) card.append(el('p', `${a.custom} ${schedule.cron}`, 'muted'));
    else readPicker = this.pickerControls(card, picker);

    const options = { ...DEFAULTS[kind].options, ...(schedule?.options ?? {}) };
    const read = {};
    if ('countdownMinutes' in DEFAULTS[kind].options) {
      const countdown = document.createElement('input');
      countdown.value = options.countdownMinutes.join(', ');
      countdown.inputMode = 'numeric';
      card.append(labelled(a.countdown, countdown), el('p', a.countdownHelp, 'muted'));
      read.countdownMinutes = () => parseCountdown(countdown.value);
      const announce = document.createElement('select');
      for (const value of ['chat', 'broadcast']) announce.append(new Option(a.announce[value], value));
      announce.value = options.announce;
      card.append(labelled(a.announceLabel, announce));
      read.announce = () => announce.value;
    }
    if ('keep' in DEFAULTS[kind].options) {
      const keep = document.createElement('input');
      keep.type = 'number';
      keep.min = 1;
      keep.max = 100;
      keep.value = options.keep;
      card.append(labelled(a.keep, keep));
      read.keep = () => Number(keep.value);
    }
    const status = el('dl', undefined, 'automation-status');
    status.append(
      el('dt', a.next),
      el('dd', schedule?.enabled ? when(schedule.nextRunAt) : a.off),
      el('dt', a.last),
      el('dd', when(schedule?.lastRunAt)),
      el('dt', a.lastJob),
      el('dd', schedule?.lastJobState ? jobState(schedule.lastJobState) : a.none),
    );
    card.append(status);
    const error = el('p', '', 'error-message');
    error.setAttribute('aria-live', 'polite');
    const save = el('button', undefined, 'button primary');
    save.append(icon('check'), a.save);
    save.addEventListener('click', async () => {
      error.textContent = '';
      const cron = readPicker();
      const body = { cron, enabled: enabled.checked, options: {} };
      for (const [key, get] of Object.entries(read)) body.options[key] = get();
      if (!cron || (read.countdownMinutes && !body.options.countdownMinutes)) {
        error.textContent = !cron ? a.badTime : a.badCountdown;
        return;
      }
      save.disabled = true;
      try {
        await api.put(`/api/servers/${this.id}/schedules/${kind}`, body);
        document.querySelector('ao-toast')?.show(a.saved);
        await this.load();
      } catch (e) {
        error.textContent = e.message;
        save.disabled = false;
      }
    });
    card.append(save, error);
    return card;
  }
  // Shows only the fields the chosen repeat needs, and returns a function that reads them as cron.
  pickerControls(card, picker) {
    const a = STRINGS.automation;
    const type = document.createElement('select');
    for (const value of ['daily', 'hourly', 'weekly']) type.append(new Option(a.repeat[value], value));
    type.value = picker.type;
    const time = document.createElement('input');
    time.type = 'time';
    time.value = `${String(picker.hour ?? 0).padStart(2, '0')}:${String(picker.minute ?? 0).padStart(2, '0')}`;
    const hours = document.createElement('input');
    hours.type = 'number';
    hours.min = 1;
    hours.max = 23;
    hours.value = picker.hours ?? 6;
    const minute = document.createElement('input');
    minute.type = 'number';
    minute.min = 0;
    minute.max = 59;
    minute.value = picker.minute ?? 0;
    const weekday = document.createElement('select');
    a.weekdays.forEach((name, index) => weekday.append(new Option(name, index)));
    weekday.value = picker.weekday ?? 0;
    const rows = {
      time: labelled(a.time, time),
      hours: labelled(a.everyHours, hours),
      minute: labelled(a.minutePast, minute),
      weekday: labelled(a.weekday, weekday),
    };
    const show = () => {
      rows.time.hidden = type.value === 'hourly';
      rows.hours.hidden = rows.minute.hidden = type.value !== 'hourly';
      rows.weekday.hidden = type.value !== 'weekly';
    };
    type.addEventListener('change', show);
    show();
    card.append(labelled(a.repeatLabel, type), rows.weekday, rows.time, rows.hours, rows.minute);
    return () => {
      const [h, m] = time.value.split(':').map(Number);
      return pickerToCron({
        type: type.value,
        hour: h,
        minute: type.value === 'hourly' ? Number(minute.value) : m,
        hours: Number(hours.value),
        weekday: Number(weekday.value),
      });
    };
  }
  backupSection() {
    const a = STRINGS.automation;
    const section = el('section', undefined, 'card');
    section.append(el('h2', a.backups), el('p', a.backupsHelp, 'muted'));
    const status = el('p', '', 'wizard-progress');
    status.setAttribute('aria-live', 'polite');
    const now = el('button', undefined, 'button primary');
    now.append(icon('add'), a.backUpNow);
    now.disabled = Boolean(this.pollTimer);
    now.addEventListener('click', async () => {
      now.disabled = true;
      status.textContent = '';
      try {
        const job = await api.post(`/api/servers/${this.id}/backups`, {});
        status.textContent = a.backingUp;
        this.follow(job.id, status);
      } catch (error) {
        status.textContent = error.message;
        now.disabled = false;
      }
    });
    section.append(now, status);
    if (!this.backups.length) {
      section.append(el('p', a.noBackups));
      return section;
    }
    const list = el('ul', undefined, 'backup-list');
    for (const item of this.backups)
      list.append(
        el(
          'li',
          `${when(item.created_at)}. ${a.reasons[item.reason] ?? item.reason}. ${byteSize(item.size_bytes)}, ${item.files} ${a.files}.`,
        ),
      );
    section.append(list);
    return section;
  }
  // Polls the one job until it ends, then reloads once; the page is left alone while it runs.
  follow(jobId, status) {
    const tick = async () => {
      this.pollTimer = null;
      if (!this.isConnected) return;
      try {
        const job = (await api.get('/api/jobs')).find((item) => item.id === jobId);
        if (job && !['queued', 'running'].includes(job.state)) {
          if (job.state === 'succeeded') document.querySelector('ao-toast')?.show(STRINGS.automation.backedUp);
          await this.load();
          if (job.state !== 'succeeded') {
            const again = this.querySelector('.wizard-progress');
            if (again) again.textContent = job.error || jobState(job.state);
          }
          return;
        }
      } catch (error) {
        status.textContent = error.message;
      }
      this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }
}
customElements.define('ao-server-automation', AoServerAutomation);
