import { STRINGS } from '../strings.js';
import { icon } from '../lib/icon.js';
import { tabFor } from '../lib/tabs.js';

// The phone's main navigation: four places that are always one tap away. It shows only on a narrow screen.
const TABS = [
  { screen: 'servers', href: '#/servers', icon: 'server', label: () => STRINGS.fleet.servers },
  { screen: 'clusters', href: '#/clusters', icon: 'network', label: () => STRINGS.fleet.clusters },
  { screen: 'host', href: '#/host', icon: 'settings', label: () => STRINGS.fleet.host },
  { screen: 'account', href: '#/account', icon: 'account', label: () => STRINGS.fleet.account },
];

export class AoTabBar extends HTMLElement {
  connectedCallback() {
    this.setAttribute('role', 'navigation');
    this.setAttribute('aria-label', STRINGS.app.mainNav);
    this.replaceChildren();
    for (const tab of TABS) {
      const link = document.createElement('a');
      link.href = tab.href;
      link.dataset.screen = tab.screen;
      link.append(icon(tab.icon), document.createTextNode(tab.label()));
      this.append(link);
    }
    this.onRoute = () => this.sync();
    window.addEventListener('hashchange', this.onRoute);
    this.sync();
  }
  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onRoute);
  }
  sync() {
    const current = tabFor(location.hash);
    for (const link of this.querySelectorAll('a')) {
      if (link.dataset.screen === current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
}
customElements.define('ao-tab-bar', AoTabBar);
