import { api } from './api.js';
import { STRINGS } from './strings.js';
import { passkeysSupported, signInWithPasskey } from './webauthn.js';

const form = document.querySelector('#auth-form');
const title = document.querySelector('#auth-title');
const help = document.querySelector('#auth-help');
const errorBox = document.querySelector('#auth-error');
const passkeyButton = document.querySelector('#passkey-button');
function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  return node;
}
function field(labelText, name, type, autocomplete) {
  const label = el('label', { className: 'field-label', for: name, text: labelText });
  const input = el('input', { id: name, name, type, autocomplete, required: '' });
  form.append(label, input);
  return input;
}
function fail(error) {
  errorBox.textContent = error.message || String(error);
}
async function init() {
  try {
    const state = await api.get('/api/auth/state');
    if (state.signedIn) {
      window.location.replace('/');
      return;
    }
    form.replaceChildren();
    errorBox.textContent = '';
    if (state.needsSetup) {
      title.textContent = STRINGS.login.setupTitle;
      help.textContent = STRINGS.login.setupHelp;
      const password = field(STRINGS.login.password, 'password', 'password', 'new-password');
      password.minLength = 10;
      const confirm = field(STRINGS.login.confirm, 'confirm', 'password', 'new-password');
      confirm.minLength = 10;
      const submit = el('button', { type: 'submit', className: 'button primary full', text: STRINGS.login.save });
      form.append(submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.textContent = '';
        if (password.value.length < 10) {
          errorBox.textContent = STRINGS.login.short;
          return;
        }
        if (password.value !== confirm.value) {
          errorBox.textContent = STRINGS.login.mismatch;
          return;
        }
        try {
          await api.post('/api/auth/setup', { password: password.value });
          window.location.replace('/');
        } catch (error) {
          fail(error.status === 403 ? new Error(error.message || STRINGS.login.remote) : error);
        }
      });
      password.focus();
      return;
    }
    title.textContent = STRINGS.login.signInTitle;
    help.textContent = '';
    const password = field(STRINGS.login.password, 'password', 'password', 'current-password');
    const rememberLabel = el('label', { className: 'check-row' });
    const remember = el('input', { type: 'checkbox', name: 'remember', checked: '' });
    remember.checked = true;
    rememberLabel.append(remember, el('span', { text: STRINGS.login.remember }));
    form.append(rememberLabel);
    form.append(el('button', { type: 'submit', className: 'button primary full', text: STRINGS.login.signIn }));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      try {
        await api.post('/api/auth/login', { password: password.value, remember: remember.checked });
        window.location.replace('/');
      } catch (error) {
        fail(error);
      }
    });
    password.focus();
    if (state.passkeysAvailable && passkeysSupported()) {
      passkeyButton.hidden = false;
      passkeyButton.addEventListener('click', async () => {
        errorBox.textContent = '';
        try {
          await signInWithPasskey();
          window.location.replace('/');
        } catch (error) {
          if (error.name !== 'NotAllowedError') fail(error);
        }
      });
    }
  } catch (error) {
    title.textContent = STRINGS.login.loading;
    fail(error);
  }
}
init();
