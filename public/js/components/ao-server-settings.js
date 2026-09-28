import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import {
  groupFields,
  filterFields,
  pendingChanges,
  buildPutBody,
  validateField,
  controlValue,
} from '../lib/settings.js';
function changeCount(count) {
  return `${count} ${count === 1 ? STRINGS.settings.change : STRINGS.settings.changes}`;
}
export class AoServerSettings extends HTMLElement {
  async connectedCallback() {
    this.id = this.getAttribute('server-id');
    this.query = '';
    this.active = '';
    this.edited = {};
    await this.load();
  }
  async load() {
    this.replaceChildren();
    this.textContent = STRINGS.app.loading;
    try {
      [this.fields, this.loaded] = await Promise.all([
        api.get('/api/settings/fields'),
        api.get(`/api/servers/${this.id}/settings`),
      ]);
      this.loaded ||= {};
      this.edited = { ...this.loaded };
      this.groups = groupFields(this.fields);
      this.active ||= Object.keys(this.groups)[0];
      this.render();
    } catch (error) {
      this.replaceChildren();
      const p = document.createElement('p');
      p.textContent = error.message;
      const b = document.createElement('button');
      b.className = 'button secondary';
      b.textContent = STRINGS.app.retry;
      b.addEventListener('click', () => this.load());
      this.append(p, b);
    }
  }
  changes() {
    return pendingChanges(this.fields, this.loaded, this.edited);
  }
  render() {
    this.replaceChildren();
    this.className = 'screen settings-screen';
    const h = document.createElement('h1');
    h.textContent = STRINGS.settings.title;
    this.append(h);
    if (this.needsRestart) this.append(this.restartBanner());
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = STRINGS.settings.search;
    search.setAttribute('aria-label', STRINGS.settings.search);
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderFields();
      this.searchRelated();
    });
    this.append(search);
    const layout = document.createElement('div');
    layout.className = 'settings-layout';
    const select = document.createElement('select');
    select.setAttribute('aria-label', STRINGS.settings.categories);
    for (const category of Object.keys(this.groups)) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      option.selected = category === this.active;
      select.append(option);
    }
    select.addEventListener('change', () => {
      this.active = select.value;
      this.render();
    });
    layout.append(select);
    const categories = document.createElement('nav');
    categories.className = 'category-list';
    for (const category of Object.keys(this.groups)) {
      const button = document.createElement('button');
      button.textContent = category;
      button.className = category === this.active ? 'selected' : '';
      button.addEventListener('click', () => {
        this.active = category;
        this.render();
      });
      categories.append(button);
    }
    layout.append(categories);
    this.panel = document.createElement('div');
    this.panel.className = 'field-list';
    layout.append(this.panel);
    this.renderFields();
    this.append(layout);
    const related = document.createElement('div');
    related.className = 'related-fields';
    related.id = 'related-fields';
    this.append(related);
    this.renderRelated();
    const bar = document.createElement('div');
    bar.className = 'pending-bar';
    const count = this.changes().length;
    const text = document.createElement('span');
    text.textContent = changeCount(count);
    const review = document.createElement('button');
    review.className = 'button secondary';
    review.textContent = STRINGS.settings.review;
    review.disabled = !count;
    review.addEventListener('click', () => this.review());
    const discard = document.createElement('button');
    discard.className = 'button quiet';
    discard.textContent = STRINGS.settings.discard;
    discard.disabled = !count;
    discard.addEventListener('click', () => {
      this.edited = { ...this.loaded };
      this.render();
    });
    this.saveError = document.createElement('span');
    this.saveError.className = 'error-message';
    this.saveError.setAttribute('aria-live', 'polite');
    bar.append(text, review, discard, this.saveError);
    this.append(bar);
  }
  restartBanner() {
    const banner = document.createElement('div');
    banner.className = 'card restart-banner';
    banner.setAttribute('role', 'status');
    const text = document.createElement('p');
    text.textContent = STRINGS.settings.running;
    const restart = document.createElement('button');
    restart.className = 'button primary';
    restart.textContent = STRINGS.settings.restartNow;
    const failed = document.createElement('p');
    failed.className = 'error-message';
    restart.addEventListener('click', async () => {
      if (!(await document.querySelector('ao-dialog').ask(STRINGS.settings.restart, STRINGS.settings.confirmRestart)))
        return;
      restart.disabled = true;
      try {
        await api.post(`/api/servers/${this.id}/restart`, {});
        this.needsRestart = false;
        banner.remove();
      } catch (error) {
        failed.textContent = error.message;
        restart.disabled = false;
      }
    });
    banner.append(text, restart, failed);
    return banner;
  }
  renderFields() {
    const fields = filterFields(this.groups[this.active] || [], this.query);
    this.panel.replaceChildren(...fields.map((field) => this.fieldNode(field)));
  }
  searchRelated() {
    clearTimeout(this.searchTimer);
    if (!this.query.trim()) {
      this.related = [];
      this.renderRelated();
      return;
    }
    this.searchTimer = setTimeout(async () => {
      try {
        this.related = await api.get(`/api/settings/search?q=${encodeURIComponent(this.query)}`);
      } catch {
        this.related = [];
      }
      this.renderRelated();
    }, 350);
  }
  disconnectedCallback() {
    clearTimeout(this.searchTimer);
  }
  fieldNode(field) {
    const row = document.createElement('article');
    row.className = 'setting-field';
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = field.label;
    const input = document.createElement('input');
    input.id = `setting-${field.key}`;
    input.name = field.key;
    const current = this.edited[field.key] ?? null;
    const display = controlValue(field, current);
    const def = display.isDefault;
    if (field.type === 'bool') {
      input.type = 'checkbox';
      input.checked = Boolean(display.value);
      input.className = 'toggle';
    } else {
      input.type =
        field.type === 'password' ? 'password' : field.type === 'int' || field.type === 'float' ? 'number' : 'text';
      input.value = display.value === '(none)' || display.value === '(game default)' ? '' : String(display.value ?? '');
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.step !== undefined) input.step = field.step;
      if (field.maxLength) input.maxLength = field.maxLength;
    }
    input.disabled = Boolean(field.locked || field.launchFlag);
    label.htmlFor = input.id;
    input.addEventListener('input', () => this.updateField(field, input));
    input.addEventListener('change', () => this.updateField(field, input));
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = field.description || '';
    row.append(label, input, description);
    if ((field.type === 'int' || field.type === 'float') && field.min !== undefined && field.max !== undefined) {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = field.min;
      slider.max = field.max;
      slider.step = field.step || 1;
      slider.value = Number(display.value);
      slider.setAttribute('aria-label', `${field.label} slider`);
      slider.disabled = input.disabled;
      slider.addEventListener('input', () => {
        input.value = slider.value;
        this.updateField(field, input);
      });
      input.addEventListener('input', () => {
        slider.value = input.value || Number(field.default) || field.min;
      });
      row.append(slider);
    }
    if (field.type === 'password') {
      const show = document.createElement('button');
      show.className = 'button quiet';
      show.type = 'button';
      show.textContent = STRINGS.settings.show;
      show.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        show.textContent = input.type === 'password' ? STRINGS.settings.show : STRINGS.settings.hide;
      });
      row.append(show);
    }
    const info = document.createElement('small');
    info.className = 'muted';
    info.textContent = `${def ? `${STRINGS.settings.default}: ${String(field.default)}` : ''}${field.help ? `${def ? ' · ' : ''}${field.help}` : ''}${field.lockedReason ? ` · ${field.lockedReason}` : ''}`;
    row.append(info);
    const error = document.createElement('small');
    error.className = 'error-message';
    error.dataset.errorFor = field.key;
    row.append(error);
    if (!field.locked && !field.launchFlag) {
      const unset = document.createElement('button');
      unset.className = 'button quiet';
      unset.type = 'button';
      unset.textContent = STRINGS.settings.unset;
      unset.addEventListener('click', () => {
        this.edited[field.key] = null;
        this.render();
      });
      row.append(unset);
    }
    return row;
  }
  updateField(field, input) {
    const raw = field.type === 'bool' ? input.checked : input.value;
    const value =
      field.type === 'int' && raw !== ''
        ? Number(raw)
        : field.type === 'float' && raw !== ''
          ? Number(raw)
          : raw === ''
            ? null
            : raw;
    this.edited[field.key] = value;
    const error = validateField(field, value);
    const node = this.querySelector(`[data-error-for="${CSS.escape(field.key)}"]`);
    if (node) node.textContent = error;
    this.renderBar();
  }
  renderBar() {
    const old = this.querySelector('.pending-bar');
    if (!old) {
      this.render();
      return;
    }
    const count = this.changes().length;
    old.firstChild.textContent = changeCount(count);
    old.querySelectorAll('button').forEach((button) => {
      button.disabled = !count;
    });
  }
  renderRelated() {
    const host = this.querySelector('#related-fields');
    if (!host) return;
    host.replaceChildren();
    if (!this.related?.length) return;
    const h = document.createElement('h2');
    h.textContent = STRINGS.settings.related;
    host.append(h);
    for (const field of this.related) {
      const p = document.createElement('p');
      p.textContent = `${field.label || field.key}: ${field.description || ''}`;
      host.append(p);
    }
  }
  async review() {
    const changes = this.changes();
    const byKey = new Map(this.fields.map((field) => [field.key, field]));
    if (changes.some((change) => byKey.has(change.key) && validateField(byKey.get(change.key), change.to))) {
      this.saveError.textContent = STRINGS.settings.fixFirst;
      return;
    }
    const dialog = document.querySelector('ao-dialog');
    const approved = await dialog.ask(
      STRINGS.settings.review,
      changes
        .map(
          (change) =>
            `${change.label}: ${String(change.from ?? STRINGS.settings.default)} -> ${String(change.to ?? STRINGS.settings.default)}`,
        )
        .join('\n'),
      STRINGS.settings.save,
    );
    if (!approved) return;
    this.saveError.textContent = '';
    try {
      await api.put(`/api/servers/${this.id}/settings`, buildPutBody(changes, this.fields));
      this.loaded = { ...this.edited };
      const server = await api.get(`/api/servers/${this.id}`).catch(() => null);
      this.needsRestart = server?.status?.observedState === 'running';
      this.render();
      document.querySelector('ao-toast').show(STRINGS.settings.saved);
    } catch (error) {
      this.saveError.textContent = error.message;
      // The server names each rejected setting by its label, so each message goes under its field.
      for (const message of error.errors || []) {
        const field = this.fields.find((item) => message.startsWith(item.label));
        const node = field && this.querySelector(`[data-error-for="${CSS.escape(field.key)}"]`);
        if (node) node.textContent = message;
      }
    }
  }
  hasChanges() {
    return this.changes().length > 0;
  }
}
customElements.define('ao-server-settings', AoServerSettings);
