import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { durationInputs, readWhole } from '../lib/idle.js';

const text = STRINGS.idle.settings;

function check(label, checked) {
  const row = document.createElement('label');
  row.className = 'check-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  row.append(box, label);
  return { row, box };
}

function numberField(label, value) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field-label';
  wrapper.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  input.value = String(value);
  wrapper.append(input);
  return { wrapper, input };
}

// The Account page card for the empty-server prompt: when it asks, what it offers, whether it shuts a server down
// by itself, and which servers it watches. These apply to every device and to Telegram.
export class AoIdleSettings extends HTMLElement {
  async connectedCallback() {
    this.className = 'card form-stack';
    try {
      this.data = await api.get('/api/idle');
    } catch (error) {
      this.textContent = error.message;
      return;
    }
    this.render();
  }
  render() {
    const { settings, servers, telegram } = this.data;
    this.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = text.title;
    const help = document.createElement('p');
    help.textContent = text.help;
    this.append(title, help);

    const enabled = check(text.enabled, settings.enabled);
    const idle = numberField(text.idleMinutes, settings.idleMinutes);
    const extendLabel = document.createElement('label');
    extendLabel.className = 'field-label';
    extendLabel.textContent = text.extend;
    const time = durationInputs({ value: settings.extendValue, unit: settings.extendUnit });
    const timeRow = document.createElement('div');
    timeRow.className = 'button-row';
    timeRow.append(time.number, time.select);
    extendLabel.append(timeRow);
    const auto = check(text.autoShutdown, settings.autoShutdown);
    const wait = numberField(text.autoMinutes, settings.autoShutdownMinutes);
    const syncAuto = () => {
      wait.input.disabled = !auto.box.checked;
    };
    auto.box.addEventListener('change', syncAuto);
    syncAuto();

    const every = check(text.everyServer, settings.serverIds === null);
    const list = document.createElement('div');
    list.className = 'form-stack';
    const picks = servers.map((server) => {
      const pick = check(server.name, settings.serverIds === null || settings.serverIds.includes(server.id));
      pick.id = server.id;
      list.append(pick.row);
      return pick;
    });
    const syncList = () => {
      list.hidden = every.box.checked;
    };
    every.box.addEventListener('change', syncList);
    syncList();

    const telegramNote = document.createElement('p');
    telegramNote.textContent = telegram.configured ? text.telegramOn : text.telegramOff;

    const message = document.createElement('p');
    message.setAttribute('aria-live', 'polite');
    const save = document.createElement('button');
    save.className = 'button primary';
    save.textContent = text.save;
    save.addEventListener('click', async () => {
      const idleMinutes = readWhole(idle.input.value);
      const autoShutdownMinutes = readWhole(wait.input.value);
      const extend = time.read();
      if (!idleMinutes || !autoShutdownMinutes || !extend.value) {
        message.textContent = text.needNumbers;
        return;
      }
      save.disabled = true;
      try {
        await api.put('/api/idle', {
          enabled: enabled.box.checked,
          idleMinutes,
          extendValue: extend.value,
          extendUnit: extend.unit,
          autoShutdown: auto.box.checked,
          autoShutdownMinutes,
          serverIds: every.box.checked ? null : picks.filter((pick) => pick.box.checked).map((pick) => pick.id),
        });
        message.textContent = text.saved;
      } catch (error) {
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    this.append(
      enabled.row,
      idle.wrapper,
      extendLabel,
      auto.row,
      wait.wrapper,
      every.row,
      list,
      telegramNote,
      save,
      message,
    );
  }
}
customElements.define('ao-idle-settings', AoIdleSettings);
