import { api } from './api.js';
import { STRINGS } from './strings.js';
import { parseRoute } from './lib/route.js';
import { icon } from './lib/icon.js';
import './components/ao-dialog.js';
import './components/ao-toast.js';
import './components/ao-fleet-rail.js';
import './components/ao-server-overview.js';
import './components/ao-server-settings.js';
import './components/ao-server-network.js';
import './components/ao-server-automation.js';
import './components/ao-jobs-panel.js';
import './components/ao-account.js';
import './components/ao-host-settings.js';
import './components/ao-setup-wizard.js';

class AoApp extends HTMLElement {
  connectedCallback() {
    this.renderFrame();
    this.shownHash = location.hash;
    this.onRoute = () => this.leaveGuarded();
    this.onUnload = (event) => {
      if (this.unsaved()) event.preventDefault();
    };
    window.addEventListener('hashchange', this.onRoute);
    window.addEventListener('beforeunload', this.onUnload);
    this.route();
    this.loadServers();
    this.serverTimer = setInterval(() => {
      if (!document.hidden) this.loadServers();
    }, 5000);
  }
  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onRoute);
    window.removeEventListener('beforeunload', this.onUnload);
    clearInterval(this.serverTimer);
  }
  renderFrame() {
    this.replaceChildren();
    this.className = 'app-frame';
    const rail = document.createElement('ao-fleet-rail');
    this.rail = rail;
    const scrim = document.createElement('button');
    scrim.className = 'drawer-scrim';
    scrim.setAttribute('aria-label', STRINGS.app.closeMenu);
    scrim.addEventListener('click', () => this.closeDrawer());
    const main = document.createElement('main');
    main.className = 'main-area';
    const top = document.createElement('header');
    top.className = 'topbar';
    const menu = document.createElement('button');
    menu.className = 'button quiet menu-button';
    menu.setAttribute('aria-label', STRINGS.app.menu);
    menu.append(icon('menu'), STRINGS.app.menuButton);
    menu.addEventListener('click', () => this.classList.toggle('drawer-open'));
    const title = document.createElement('span');
    title.className = 'topbar-title';
    title.textContent = STRINGS.app.name;
    const jobsButton = document.createElement('button');
    jobsButton.className = 'button secondary';
    jobsButton.append(icon('jobs'), STRINGS.app.jobs);
    jobsButton.addEventListener('click', () => {
      window.location.hash = '#/jobs';
    });
    top.append(menu, title, jobsButton);
    this.view = document.createElement('div');
    this.view.className = 'view';
    const jobs = document.createElement('details');
    jobs.className = 'jobs-drawer';
    const summary = document.createElement('summary');
    summary.textContent = STRINGS.app.jobs;
    this.jobsPanel = document.createElement('ao-jobs-panel');
    this.jobsDrawer = jobs;
    jobs.append(summary, this.jobsPanel);
    main.append(top, this.view, jobs);
    const dialog = document.createElement('ao-dialog');
    const toast = document.createElement('ao-toast');
    this.append(rail, scrim, main, dialog, toast);
    this.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeDrawer();
    });
  }
  unsaved() {
    return Boolean(
      this.view.querySelector('ao-server-settings')?.hasChanges() ||
      this.view.querySelector('ao-setup-wizard')?.hasChanges(),
    );
  }
  async leaveGuarded() {
    if (this.unsaved()) {
      const target = location.hash;
      // Put the address back while asking, so a refusal leaves the page as it was.
      history.replaceState(null, '', this.shownHash);
      const wizard = this.view.querySelector('ao-setup-wizard')?.hasChanges();
      const leave = await this.querySelector('ao-dialog').ask(
        wizard ? STRINGS.wizard.title : STRINGS.settings.title,
        wizard ? STRINGS.wizard.confirmLeave : STRINGS.settings.confirmLeave,
      );
      if (!leave) return;
      history.replaceState(null, '', target);
    }
    this.route();
  }
  closeDrawer() {
    this.classList.remove('drawer-open');
  }
  async loadServers() {
    try {
      this.servers = await api.get('/api/servers');
      if (parseRoute(location.hash).screen === 'home') this.route();
    } catch {}
  }
  route() {
    this.shownHash = location.hash;
    if (this.jobsPanel.parentElement !== this.jobsDrawer) {
      this.jobsDrawer.append(this.jobsPanel);
      this.jobsDrawer.hidden = false;
    }
    const route = parseRoute(location.hash || '#/');
    if (route.screen === 'unknown') {
      this.view.textContent = STRINGS.app.emptyServers;
      return;
    }
    if (route.screen === 'home') {
      if (!this.servers) {
        this.view.textContent = STRINGS.app.loading;
        return;
      }
      if (!this.servers.length) {
        this.view.replaceChildren();
        const h = document.createElement('h1');
        h.textContent = STRINGS.app.emptyServers;
        const p = document.createElement('p');
        p.textContent = STRINGS.app.emptyHelp;
        const link = document.createElement('a');
        link.href = '#/setup';
        link.className = 'button primary';
        link.textContent = STRINGS.app.setupLink;
        this.view.append(h, p, link);
        return;
      }
      route.screen = 'overview';
      route.id = this.servers[0].id;
      window.history.replaceState(null, '', `#/servers/${route.id}/overview`);
    }
    if (['overview', 'settings', 'network', 'automation'].includes(route.screen)) {
      if (this.servers && !this.servers.some((s) => s.id === route.id)) {
        this.view.textContent = STRINGS.app.emptyServers;
        return;
      }
      const tag = {
        overview: 'ao-server-overview',
        settings: 'ao-server-settings',
        network: 'ao-server-network',
        automation: 'ao-server-automation',
      }[route.screen];
      const page = document.createElement(tag);
      page.setAttribute('server-id', route.id);
      const nav = document.createElement('nav');
      nav.className = 'section-nav';
      for (const [screen, label] of [
        ['overview', STRINGS.overview.title],
        ['settings', STRINGS.settings.title],
        ['network', STRINGS.network.title],
        ['automation', STRINGS.automation.title],
      ]) {
        const a = document.createElement('a');
        a.href = `#/servers/${route.id}/${screen}`;
        a.append(
          icon({ overview: 'server', settings: 'settings', network: 'network', automation: 'jobs' }[screen]),
          label,
        );
        if (screen === route.screen) a.setAttribute('aria-current', 'page');
        nav.append(a);
      }
      this.view.replaceChildren(nav, page);
      // On a narrow screen the tab strip scrolls, and the current tab may start out of sight.
      nav.querySelector('[aria-current]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (route.screen === 'account') this.view.replaceChildren(document.createElement('ao-account'));
    else if (route.screen === 'host') this.view.replaceChildren(document.createElement('ao-host-settings'));
    else if (route.screen === 'jobs') {
      this.jobsDrawer.hidden = true;
      this.view.replaceChildren(this.jobsPanel);
    } else if (route.screen === 'setup') {
      this.view.replaceChildren(document.createElement('ao-setup-wizard'));
    }
    this.closeDrawer();
  }
}
customElements.define('ao-app', AoApp);
