import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { stateName } from '../lib/format.js';
import { icon } from '../lib/icon.js';
export class AoFleetRail extends HTMLElement {
  connectedCallback() {
    this.render();
    this.refresh();
    this.timer = setInterval(() => {
      if (!document.hidden) this.refresh();
    }, 5000);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
  }
  async refresh() {
    try {
      this.servers = await api.get('/api/servers');
      this.refreshError = '';
    } catch (error) {
      this.refreshError = error.message;
    }
    this.render();
  }
  render() {
    this.replaceChildren();
    this.className = 'fleet-rail';
    const brand = document.createElement('a');
    brand.className = 'brand';
    brand.href = '#/';
    const mark = document.createElement('span');
    mark.className = 'brand-mark';
    mark.textContent = 'A';
    const name = document.createElement('span');
    name.textContent = STRINGS.app.name;
    brand.append(mark, name);
    const heading = document.createElement('h2');
    heading.className = 'rail-heading';
    heading.textContent = STRINGS.fleet.servers;
    this.append(brand, heading);
    if (!this.servers?.length) {
      const empty = document.createElement('p');
      empty.className = 'muted rail-empty';
      empty.textContent = STRINGS.app.emptyServers;
      this.append(empty);
    }
    for (const server of this.servers || []) {
      const link = document.createElement('a');
      link.className = 'server-link';
      link.href = `#/servers/${server.id}/overview`;
      const serverName = document.createElement('strong');
      serverName.textContent = server.name;
      const meta = document.createElement('span');
      meta.textContent = `${server.map} · ${stateName(server.status?.observedState)}`;
      const text = document.createElement('span');
      text.className = 'server-text';
      text.append(serverName, meta);
      link.append(icon('server'), text);
      this.append(link);
    }
    if (this.refreshError) {
      const failed = document.createElement('p');
      failed.className = 'error-message';
      failed.textContent = this.refreshError;
      this.append(failed);
    }
    const add = document.createElement('a');
    add.className = 'button secondary rail-add';
    add.href = '#/setup';
    add.append(icon('add'), STRINGS.fleet.add);
    this.append(add);
    const bottom = document.createElement('div');
    bottom.className = 'rail-bottom';
    const account = document.createElement('a');
    account.href = '#/account';
    account.append(icon('account'), STRINGS.fleet.account);
    const signOut = document.createElement('button');
    signOut.className = 'button quiet';
    signOut.append(icon('sign-out'), STRINGS.fleet.signOut);
    signOut.addEventListener('click', async () => {
      try {
        await api.post('/api/auth/logout', {});
      } finally {
        window.location.assign('/login.html');
      }
    });
    bottom.append(account, signOut);
    this.append(bottom);
  }
}
customElements.define('ao-fleet-rail', AoFleetRail);
