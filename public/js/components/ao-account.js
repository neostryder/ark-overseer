import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { passkeysSupported, registerPasskey } from '../webauthn.js';
export class AoAccount extends HTMLElement {
  async connectedCallback() {
    this.render();
    await this.loadPasskeys();
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
    const out = document.createElement('button');
    out.className = 'button quiet';
    out.append(icon('sign-out'), STRINGS.account.signOut);
    out.addEventListener('click', async () => {
      try {
        await api.post('/api/auth/logout', {});
      } finally {
        window.location.assign('/login.html');
      }
    });
    this.append(out);
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
