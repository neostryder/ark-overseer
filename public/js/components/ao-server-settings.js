import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import './ao-settings-drift.js';
import { clusterEditChoice, clusterFieldState } from '../lib/clusters.js';
import { createSettingInput, readSettingInput } from '../lib/settings-controls.js';
import {
  groupFields,
  searchFields,
  rankedFields,
  pendingChanges,
  buildPutBody,
  validateField,
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
    // One banner for the page's whole life: it is moved into each draw, so an open review survives a category change.
    this.driftEl = document.createElement('ao-settings-drift');
    this.driftEl.setAttribute('server-id', this.id);
    this.driftEl.addEventListener('drift-resolved', () => this.load());
    await this.load();
  }
  async load() {
    this.replaceChildren();
    this.textContent = STRINGS.app.loading;
    try {
      [this.fields, this.loaded, this.server] = await Promise.all([
        api.get('/api/settings/fields'),
        api.get(`/api/servers/${this.id}/settings`),
        api.get(`/api/servers/${this.id}`),
      ]);
      this.cluster = this.server.cluster_id ? await api.get(`/api/clusters/${this.server.cluster_id}`) : null;
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
    this.append(this.driftEl);
    this.driftEl.setBlocked(this.changes().length > 0);
    const search = document.createElement('input');
    search.type = 'search';
    search.inputMode = 'search';
    search.enterKeyHint = 'search';
    search.placeholder = STRINGS.settings.search;
    search.setAttribute('aria-label', STRINGS.settings.search);
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderFields();
    });
    this.status = document.createElement('p');
    this.status.className = 'muted search-status';
    this.status.setAttribute('aria-live', 'polite');
    this.append(search, this.status);
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
  // A search covers every category. Settings that hold every word come first; when none do, the local
  // semantic search offers the settings closest in meaning, as editable fields in the same list.
  renderFields() {
    clearTimeout(this.searchTimer);
    const revision = (this.searchRevision = (this.searchRevision ?? 0) + 1);
    const s = STRINGS.settings,
      query = this.query.trim();
    const show = (fields, withCategory) =>
      this.panel.replaceChildren(...fields.map((field) => this.fieldNode(field, withCategory)));
    if (!query) {
      this.status.textContent = '';
      show(this.groups[this.active] || [], false);
      return;
    }
    const exact = searchFields(this.fields, query);
    if (exact.length) {
      const categories = new Set(exact.map((field) => field.category)).size;
      this.status.textContent = s.searchFound
        .replace('{settings}', exact.length === 1 ? s.settingsOne : s.settingsMany.replace('{count}', exact.length))
        .replace('{categories}', categories === 1 ? s.categoriesOne : s.categoriesMany.replace('{count}', categories));
      show(exact, true);
      return;
    }
    show([], true);
    if (query.length < 2) {
      this.status.textContent = s.searchNothing.replace('{query}', query);
      return;
    }
    this.status.textContent = s.searchLooking;
    this.searchTimer = setTimeout(async () => {
      let related = null;
      try {
        related = rankedFields(this.fields, await api.get(`/api/settings/search?q=${encodeURIComponent(query)}`));
      } catch {
        /* reported below as unavailable */
      }
      // A newer keystroke has already redrawn the list.
      if (revision !== this.searchRevision) return;
      if (!related) this.status.textContent = s.searchUnavailable;
      else if (!related.length) this.status.textContent = s.searchNothing.replace('{query}', query);
      else {
        this.status.textContent = s.searchRelated;
        show(related, true);
      }
    }, 350);
  }
  disconnectedCallback() {
    clearTimeout(this.searchTimer);
  }
  fieldNode(field, withCategory = false) {
    const row = document.createElement('article');
    row.className = 'setting-field';
    // Search results come from every category, so each one says where it lives.
    if (withCategory) {
      const where = document.createElement('p');
      where.className = 'setting-category muted';
      where.textContent = field.category;
      row.append(where);
    }
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = field.label;
    const clusterState = clusterFieldState(field.key, this.cluster, this.server?.cluster_overrides_json);
    if (clusterState === 'inherited') {
      const badge = document.createElement('small');
      badge.className = 'badge cluster-badge';
      const fromCluster = STRINGS.settings.fromCluster;
      badge.textContent = fromCluster.replace('{name}', this.cluster.name);
      row.append(badge);
    }
    const current = this.edited[field.key] ?? null;
    const { input, display } = createSettingInput(field, current, `setting-${field.key}`);
    const def = display.isDefault;
    label.htmlFor = input.id;
    input.addEventListener('input', () => this.updateField(field, input));
    input.addEventListener('change', () => this.updateField(field, input));
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = field.description || '';
    if (field.type === 'bool') label.append(input);
    row.append(label);
    if (field.type !== 'bool') row.append(input);
    row.append(description);
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
    if (clusterState === 'override') {
      const restore = document.createElement('button');
      restore.className = 'button quiet';
      restore.type = 'button';
      restore.textContent = STRINGS.settings.removeOverride;
      restore.addEventListener('click', async () => {
        if (
          this.hasChanges() &&
          !(await document.querySelector('ao-dialog').ask(STRINGS.settings.title, STRINGS.settings.confirmLeave))
        )
          return;
        const overrides = this.server.cluster_overrides_json.filter((key) => key !== field.key);
        try {
          await api.put(`/api/servers/${this.id}/cluster-overrides`, { overrides });
          await this.load();
        } catch (cause) {
          this.saveError.textContent = cause.message;
        }
      });
      row.append(restore);
    }
    return row;
  }
  updateField(field, input) {
    const value = readSettingInput(field, input);
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
    this.driftEl?.setBlocked(count > 0);
    old.querySelectorAll('button').forEach((button) => {
      button.disabled = !count;
    });
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
    let clusterChoice;
    if (clusterEditChoice(changes, this.cluster, this.server?.cluster_overrides_json)) {
      const choiceText = STRINGS.settings.clusterChoice;
      clusterChoice = await dialog.choose(
        STRINGS.settings.clusterChoiceTitle,
        choiceText.replace('{name}', this.cluster.name),
        [
          { value: 'keep', label: STRINGS.settings.keepOwn },
          { value: 'cluster', label: STRINGS.settings.changeCluster },
        ],
      );
      if (!clusterChoice) return;
    }
    this.saveError.textContent = '';
    try {
      await api.put(`/api/servers/${this.id}/settings`, {
        ...buildPutBody(changes, this.fields),
        ...(clusterChoice ? { clusterChoice } : {}),
      });
      this.loaded = { ...this.edited };
      const server = await api.get(`/api/servers/${this.id}`).catch(() => null);
      this.needsRestart = server?.status?.observedState === 'running';
      await this.load();
      // The save has recorded what it wrote, so the banner is read again.
      this.driftEl.refresh();
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
