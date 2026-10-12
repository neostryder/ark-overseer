import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { passkeysSupported, registerPasskey } from '../webauthn.js';
import {
  pushSupported,
  needsHomeScreen,
  pushState,
  enablePush,
  changeEvents,
  disablePush,
  sendTestPush,
} from '../lib/push.js';
export class AoAccount extends HTMLElement {
  async connectedCallback() {
    this.render();
    await this.loadPasskeys();
    await this.loadAlerts();
  }
  render() {
    this.replaceChildren();
    this.className = 'screen';
    const h = document.createElement('h1');
    h.textContent = STRINGS.account.title;
    this.append(h);
    const form = document.createElement('form');
    form.className = 'card form-stack';
    for (const [name, label] of [
      ['current', STRINGS.account.currentPassword],
      ['password', STRINGS.account.newPassword],
      ['confirm', STRINGS.account.confirmPassword],
    ]) {
      const wrapper = document.createElement('label');
      wrapper.className = 'field-label';
      wrapper.textContent = label;
      const input = document.createElement('input');
      input.type = 'password';
      input.name = name;
      input.required = true;
      wrapper.append(input);
      form.append(wrapper);
    }
    const button = document.createElement('button');
    button.className = 'button primary';
    button.textContent = STRINGS.account.changePassword;
    const message = document.createElement('p');
    message.setAttribute('aria-live', 'polite');
    form.append(button, message);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      if (values.password.length < 10) {
        message.textContent = STRINGS.login.short;
        return;
      }
      if (values.password !== values.confirm) {
        message.textContent = STRINGS.login.mismatch;
        return;
      }
      try {
        await api.post('/api/auth/password', { current: values.current, password: values.password });
        message.textContent = STRINGS.account.changed;
        form.reset();
      } catch (error) {
        message.textContent = error.message;
      }
    });
    this.append(form);
    const keys = document.createElement('section');
    keys.className = 'card';
    const title = document.createElement('h2');
    title.textContent = STRINGS.account.passkeys;
    keys.append(title);
    this.keyList = document.createElement('div');
    keys.append(this.keyList);
    if (passkeysSupported()) {
      const add = document.createElement('button');
      add.className = 'button secondary';
      add.textContent = STRINGS.account.addPasskey;
      add.addEventListener('click', async () => {
        try {
          await registerPasskey();
          await this.loadPasskeys();
        } catch (error) {
          document.querySelector('ao-toast').show(error.message);
        }
      });
      keys.append(add);
    }
    this.append(keys);
    this.alerts = document.createElement('section');
    this.alerts.className = 'card form-stack';
    this.append(this.alerts);
    const out = document.createElement('button');
    out.className = 'button quiet';
    out.append(icon('sign-out'), STRINGS.account.signOut);
    out.addEventListener('click', async () => {
      try {
        const result = await api.post('/api/auth/logout', {});
        if (result.message === STRINGS.account.accessSignedOut) window.alert(result.message);
      } finally {
        window.location.assign('/login.html');
      }
    });
    this.append(out);
  }
  // The alerts card shows what this device has now and lets it change.
  async loadAlerts() {
    const text = STRINGS.account.alerts;
    this.alerts.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = text.title;
    const help = document.createElement('p');
    help.textContent = text.help;
    this.alerts.append(title, help);
    const note = (message) => {
      const line = document.createElement('p');
      line.textContent = message;
      line.setAttribute('aria-live', 'polite');
      this.alerts.append(line);
      return line;
    };
    if (needsHomeScreen({ userAgent: navigator.userAgent, standalone: Boolean(navigator.standalone) })) {
      note(text.homeScreen);
      return;
    }
    if (!pushSupported()) {
      note(text.unsupported);
      return;
    }
    let state;
    try {
      state = await pushState();
    } catch (error) {
      note(error.message);
      return;
    }
    const boxes = {};
    for (const kind of ['crash', 'build']) {
      const row = document.createElement('label');
      row.className = 'check-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state ? state.events.includes(kind) : true;
      boxes[kind] = box;
      row.append(box, text[kind]);
      this.alerts.append(row);
    }
    const chosen = () => Object.keys(boxes).filter((kind) => boxes[kind].checked);
    const status = note(state ? text.on : text.off);
    const fail = (error) => {
      status.textContent = error.message === 'denied' ? text.denied : error.message;
    };
    if (state) {
      for (const box of Object.values(boxes)) {
        box.addEventListener('change', async () => {
          try {
            await changeEvents(chosen());
          } catch (error) {
            fail(error);
          }
        });
      }
    }
    const actions = document.createElement('div');
    actions.className = 'button-row';
    const toggle = document.createElement('button');
    toggle.className = state ? 'button secondary' : 'button primary';
    toggle.textContent = state ? text.turnOff : text.turnOn;
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        if (state) await disablePush();
        else await enablePush(chosen());
        await this.loadAlerts();
      } catch (error) {
        toggle.disabled = false;
        fail(error);
      }
    });
    actions.append(toggle);
    if (state) {
      const test = document.createElement('button');
      test.className = 'button quiet';
      test.textContent = text.sendTest;
      test.addEventListener('click', async () => {
        try {
          const result = await sendTestPush();
          status.textContent = result.delivered ? text.testSent : text.testFailed;
        } catch (error) {
          fail(error);
        }
      });
      actions.append(test);
    }
    this.alerts.append(actions);
  }
  async loadPasskeys() {
    try {
      this.passkeys = await api.get('/api/auth/passkeys');
      if (!this.keyList) return;
      this.keyList.replaceChildren();
      for (const key of this.passkeys) {
        const row = document.createElement('p');
        const text = document.createElement('span');
        text.textContent = `${key.label || `${STRINGS.account.passkey} ${key.id}`} · ${key.created_at}`;
        const remove = document.createElement('button');
        remove.className = 'button quiet';
        remove.textContent = STRINGS.account.remove;
        remove.addEventListener('click', async () => {
          if (!(await document.querySelector('ao-dialog').ask(STRINGS.account.remove, STRINGS.account.confirmRemove)))
            return;
          try {
            await api.post('/api/auth/passkey/remove', { id: key.id });
            await this.loadPasskeys();
          } catch (error) {
            document.querySelector('ao-toast').show(error.message);
          }
        });
        row.append(text, remove);
        this.keyList.append(row);
      }
    } catch (error) {
      if (this.keyList) this.keyList.textContent = error.message;
    }
  }
}
customElements.define('ao-account', AoAccount);
