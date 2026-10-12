import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { stateTone } from '../lib/fleet-summary.js';
import { MOD_ID, addMod, moveMod, removeMod } from '../lib/mod-list.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// The launch mod list for one server, in load order. A change is held here until Save, and the server reads the
// list when it starts, so a running server picks the change up on its next restart.
export class AoServerMods extends HTMLElement {
  async connectedCallback() {
    this.serverId = this.getAttribute('server-id');
    this.className = 'card mod-list';
    this.replaceChildren(el('p', STRINGS.mods.loading));
    try {
      this.load(await api.get(`/api/servers/${this.serverId}`));
    } catch (error) {
      this.replaceChildren(el('p', error.message || STRINGS.mods.failed, 'error-message'));
    }
  }
  load(server) {
    this.server = server;
    this.saved = [...(server.settings_json?.mods ?? [])].map(String);
    this.mods = [...this.saved];
    this.render();
  }
  render() {
    const m = STRINGS.mods;
    this.replaceChildren(el('h2', m.title), el('p', m.intro, 'muted'));
    const list = el('ol', undefined, 'mod-rows');
    this.mods.forEach((id, index) => {
      const row = el('li', undefined, 'mod-row');
      row.append(el('code', id, 'mod-id'));
      if (id.endsWith('-dev')) row.append(el('span', m.testBuild, 'pill'));
      const buttons = el('span', undefined, 'mod-buttons');
      for (const [label, glyph, className, move] of [
        [m.moveUp, 'chevron', 'mod-up', () => this.change(moveMod(this.mods, index, -1))],
        [m.moveDown, 'chevron', 'mod-down', () => this.change(moveMod(this.mods, index, 1))],
        [m.remove, 'close', 'mod-remove', () => this.change(removeMod(this.mods, index))],
      ]) {
        const button = el('button', undefined, `button secondary icon-button ${className}`);
        button.type = 'button';
        const text = fill(label, { id });
        button.setAttribute('aria-label', text);
        button.title = text;
        button.append(icon(glyph));
        button.disabled =
          (className === 'mod-up' && index === 0) || (className === 'mod-down' && index === this.mods.length - 1);
        button.addEventListener('click', move);
        buttons.append(button);
      }
      row.append(buttons);
      list.append(row);
    });
    if (!this.mods.length) this.append(el('p', m.empty, 'muted'));
    else this.append(list);
    const form = el('form', undefined, 'mod-add');
    const label = el('label', m.idLabel, 'field-label');
    this.input = el('input');
    this.input.placeholder = m.idPlaceholder;
    this.input.inputMode = 'numeric';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.enterKeyHint = 'done';
    label.append(this.input);
    const add = el('button', m.add, 'button secondary');
    add.type = 'submit';
    form.append(label, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = this.input.value.trim();
      if (!MOD_ID.test(value)) return this.say(m.badId, true);
      const next = addMod(this.mods, value);
      if (!next) return this.say(m.duplicate, true);
      this.change(next);
    });
    this.status = el('p', undefined, 'muted');
    this.status.setAttribute('role', 'status');
    const dirty = this.mods.join() !== this.saved.join();
    this.save = el('button', m.save, 'button primary');
    this.save.type = 'button';
    this.save.disabled = !dirty;
    this.save.addEventListener('click', () => this.persist());
    this.append(form, this.save, this.status);
    if (dirty) this.say(m.unsaved);
  }
  say(text, isError = false) {
    this.status.textContent = text;
    this.status.className = isError ? 'error-message' : 'muted';
  }
  change(mods) {
    this.mods = mods;
    this.render();
  }
  async persist() {
    this.save.disabled = true;
    try {
      const server = await api.put(`/api/servers/${this.serverId}/mods`, { mods: this.mods });
      const m = STRINGS.mods;
      this.load(server);
      const running = stateTone(server) !== 'idle';
      const text = running ? m.savedRunning : m.saved;
      this.say(text);
      document.querySelector('ao-toast')?.show(text);
    } catch (error) {
      this.save.disabled = false;
      this.say(error.message, true);
    }
  }
}
customElements.define('ao-server-mods', AoServerMods);
