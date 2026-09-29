import { api } from '../api.js';
import { STRINGS } from '../strings.js';

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export class AoAccessSettings extends HTMLElement {
  async connectedCallback() {
    this.render(await api.get('/api/access').catch(() => ({ teamDomain: '', aud: '', publicHost: '' })));
  }
  render(data) {
    const s = STRINGS.access;
    const card = element('section', undefined, 'card host-card');
    card.append(element('h2', s.title), element('p', s.help, 'muted'));
    const form = element('form');
    form.className = 'host-form';
    form.noValidate = true;
    const teamDomain = document.createElement('input');
    teamDomain.type = 'text';
    teamDomain.autocomplete = 'url';
    teamDomain.value = data.teamDomain || '';
    const aud = document.createElement('input');
    aud.type = 'text';
    aud.autocomplete = 'off';
    aud.value = data.aud || '';
    const publicHost = document.createElement('input');
    publicHost.type = 'text';
    publicHost.autocomplete = 'off';
    publicHost.value = data.publicHost || '';
    const field = (labelText, input) => {
      const label = element('label', undefined, 'field-label');
      label.append(element('span', labelText), input);
      return label;
    };
    const save = element('button', s.save, 'button primary');
    save.type = 'submit';
    const message = element('p', '', 'error-message');
    message.setAttribute('aria-live', 'polite');
    form.append(
      field(s.teamDomain, teamDomain),
      field(s.aud, aud),
      field(s.publicHost, publicHost),
      element('p', s.publicHostHelp, 'muted'),
      save,
      message,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      save.disabled = true;
      try {
        const result = await api.put('/api/access', {
          teamDomain: teamDomain.value,
          aud: aud.value,
          publicHost: publicHost.value,
        });
        teamDomain.value = result.teamDomain;
        aud.value = result.aud;
        publicHost.value = result.publicHost;
        document.querySelector('ao-toast')?.show(s.saved);
      } catch (error) {
        message.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    card.append(form);
    this.replaceChildren(card);
  }
}
customElements.define('ao-access-settings', AoAccessSettings);
