import { api } from './api.js';
import { STRINGS } from './strings.js';
import { parseRoute } from './lib/route.js';
import { icon } from './lib/icon.js';
import { setCatalogMaps } from './lib/wizard.js';
import { layoutMode, resizeDeadline, isResizing, railClass, shouldCloseSwipe } from './lib/layout.js';
import './components/ao-dialog.js';
import './components/ao-toast.js';
import './components/ao-fleet-rail.js';
import './components/ao-server-overview.js';
import './components/ao-clusters.js';
import './components/ao-servers.js';
import './components/ao-server-settings.js';
import './components/ao-server-maps.js';
import './components/ao-server-backups.js';
import './components/ao-server-network.js';
import './components/ao-server-automation.js';
import './components/ao-jobs-panel.js';
import './components/ao-account.js';
import './components/ao-host-settings.js';
import './components/ao-setup-wizard.js';

class AoApp extends HTMLElement {
  connectedCallback() {
    this.renderFrame();
    this.onResize = () => {
      this.classList.add('resizing');
      this.resizeUntil = resizeDeadline(Date.now());
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (!isResizing(Date.now(), this.resizeUntil)) this.classList.remove('resizing');
      }, 160);
      this.syncLayout();
    };
    this.onViewport = () => {
      const viewport = window.visualViewport;
      const covered = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty('--keyboard-inset', `${covered}px`);
      document.documentElement.style.setProperty('--visual-height', `${viewport?.height ?? window.innerHeight}px`);
      if (document.activeElement?.closest('dialog')) document.activeElement.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    // The same breakpoints as the stylesheet. Their change events fire whenever the CSS layout changes, even
    // when no resize event does (browser zoom, device emulation), so the script's mode never drifts from it.
    this.layoutQueries = [
      '(max-width: 720px), (max-height: 559px)',
      '(min-width: 721px) and (max-width: 1024px) and (min-height: 560px)',
    ].map((query) => matchMedia(query));
    for (const query of this.layoutQueries) query.addEventListener('change', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onViewport);
    window.visualViewport?.addEventListener('scroll', this.onViewport);
    this.syncLayout();
    this.onViewport();
    this.shownHash = location.hash;
    this.onRoute = () => this.leaveGuarded();
    this.onUnload = (event) => {
      if (this.unsaved()) event.preventDefault();
    };
    window.addEventListener('hashchange', this.onRoute);
    window.addEventListener('beforeunload', this.onUnload);
    this.route();
    this.loadServers();
    this.loadCatalog();
    this.serverTimer = setInterval(() => {
      if (!document.hidden) this.loadServers();
    }, 5000);
  }
  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onRoute);
    window.removeEventListener('beforeunload', this.onUnload);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    for (const query of this.layoutQueries ?? []) query.removeEventListener('change', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onViewport);
    window.visualViewport?.removeEventListener('scroll', this.onViewport);
    clearTimeout(this.resizeTimer);
    this.navObserver?.disconnect();
    this.closeDrawer(false);
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
    scrim.tabIndex = -1;
    scrim.addEventListener('click', () => this.closeDrawer());
    const main = document.createElement('main');
    main.className = 'main-area';
    const top = document.createElement('header');
    top.className = 'topbar';
    const menu = document.createElement('button');
    menu.className = 'button quiet menu-button';
    menu.setAttribute('aria-label', STRINGS.app.menu);
    menu.append(icon('menu'), STRINGS.app.menuButton);
    menu.addEventListener('click', () => this.toggleRail(menu));
    menu.setAttribute('aria-expanded', 'false');
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
    this.main = main;
    this.menuButton = menu;
    rail.addEventListener('rail-toggle', (event) => this.toggleRail(event.detail.opener));
    rail.addEventListener('click', (event) => {
      if (event.target.closest('a[href]') && this.isRailOpen()) {
        this.closeDrawer(false);
        this.querySelector('.topbar button:not(.menu-button)')?.focus();
      }
    });
    rail.addEventListener('pointerdown', (event) => this.beginSwipe(event));
    rail.addEventListener('pointermove', (event) => this.moveSwipe(event));
    rail.addEventListener('pointerup', (event) => this.endSwipe(event));
    rail.addEventListener('pointercancel', () => this.cancelSwipe());
    this.addEventListener('keydown', (event) => {
      if (this.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && this.isRailOpen()) {
        event.preventDefault();
        this.closeDrawer();
      }
      if (event.key === 'Tab' && this.isRailOpen()) this.trapRailFocus(event);
    });
  }
  syncLayout() {
    const mode = layoutMode(window.innerWidth, window.innerHeight, matchMedia('(pointer: coarse)').matches);
    if (mode !== this.dataset.mode) {
      const wasOpen = this.isRailOpen();
      this.closeDrawer(false);
      this.dataset.mode = mode;
      if (wasOpen) {
        const target =
          mode === 'drawer'
            ? this.menuButton
            : mode === 'compact'
              ? this.rail.querySelector('.rail-expand')
              : this.querySelector('.topbar button:not(.menu-button)');
        target?.focus();
      }
    }
  }
  isRailOpen() {
    return this.classList.contains('drawer-open') || this.classList.contains('rail-expanded');
  }
  toggleRail(opener) {
    if (this.isRailOpen()) this.closeDrawer();
    else this.openRail(opener);
  }
  openRail(opener) {
    if (this.dataset.mode === 'wide') return;
    this.opener = opener;
    this.savedScroll = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${this.savedScroll}px`;
    document.body.style.width = '100%';
    this.classList.add(railClass(this.dataset.mode, true));
    this.main.inert = true;
    this.menuButton.setAttribute('aria-expanded', 'true');
    const expand = this.rail.querySelector('.rail-expand');
    expand?.setAttribute('aria-expanded', 'true');
    expand?.setAttribute('aria-label', STRINGS.app.collapseRail);
    if (expand) expand.title = STRINGS.app.collapseRail;
    this.rail.querySelector('a, button')?.focus();
  }
  trapRailFocus(event) {
    const focusable = [...this.rail.querySelectorAll('a[href], button:not([disabled])')].filter(
      (node) => node.getClientRects().length,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  beginSwipe(event) {
    if (!this.isRailOpen() || event.pointerType === 'mouse') return;
    this.swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), dragging: false };
  }
  moveSwipe(event) {
    const swipe = this.swipe;
    if (!swipe || swipe.id !== event.pointerId) return;
    const distance = swipe.x - event.clientX;
    if (!swipe.dragging && (distance < 8 || Math.abs(distance) < Math.abs(event.clientY - swipe.y) * 1.3)) return;
    swipe.dragging = true;
    this.rail.setPointerCapture(event.pointerId);
    this.rail.style.transform = `translateX(${-Math.min(Math.max(distance, 0), this.rail.offsetWidth)}px)`;
    this.classList.add('rail-dragging');
  }
  endSwipe(event) {
    const swipe = this.swipe;
    if (!swipe || swipe.id !== event.pointerId) return;
    const close =
      swipe.dragging && shouldCloseSwipe(swipe.x - event.clientX, performance.now() - swipe.at, this.rail.offsetWidth);
    this.cancelSwipe();
    if (close) this.closeDrawer();
  }
  cancelSwipe() {
    this.swipe = null;
    this.rail.style.transform = '';
    this.classList.remove('rail-dragging');
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
  closeDrawer(restoreFocus = true) {
    if (!this.isRailOpen()) return;
    this.cancelSwipe();
    this.classList.remove('drawer-open', 'rail-expanded');
    this.main.inert = false;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, this.savedScroll ?? 0);
    this.menuButton.setAttribute('aria-expanded', 'false');
    const expand = this.rail.querySelector('.rail-expand');
    expand?.setAttribute('aria-expanded', 'false');
    expand?.setAttribute('aria-label', STRINGS.app.expandRail);
    if (expand) expand.title = STRINGS.app.expandRail;
    if (restoreFocus) {
      const target = this.opener?.getClientRects().length
        ? this.opener
        : this.dataset.mode === 'compact'
          ? expand
          : this.menuButton.getClientRects().length
            ? this.menuButton
            : this.querySelector('.topbar button:not(.menu-button)');
      target?.focus();
    }
  }
  // Map names follow the catalog once it has loaded; until then, or if it can't be reached, the built-in
  // list names them.
  async loadCatalog() {
    try {
      setCatalogMaps((await api.get('/api/maps')).maps);
      this.dispatchEvent(
        new CustomEvent('servers-loaded', { detail: { servers: this.servers, error: this.serversError ?? '' } }),
      );
    } catch {
      /* the built-in list stays in use */
    }
  }
  // The one poll of the server list; the fleet rail draws from the event it sends.
  async loadServers() {
    let error = '';
    try {
      this.servers = await api.get('/api/servers');
      if (parseRoute(location.hash).screen === 'home') this.route();
    } catch (cause) {
      error = cause.message;
    }
    this.serversError = error;
    this.serversError = error;
    this.dispatchEvent(new CustomEvent('servers-loaded', { detail: { servers: this.servers, error } }));
  }
  route() {
    this.navObserver?.disconnect();
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
    if (['overview', 'settings', 'maps', 'backups', 'network', 'automation'].includes(route.screen)) {
      if (this.servers && !this.servers.some((s) => s.id === route.id)) {
        this.view.textContent = STRINGS.app.emptyServers;
        return;
      }
      const tag = {
        overview: 'ao-server-overview',
        settings: 'ao-server-settings',
        maps: 'ao-server-maps',
        backups: 'ao-server-backups',
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
        ['maps', STRINGS.maps.title],
        ['backups', STRINGS.backups.title],
        ['network', STRINGS.network.title],
        ['automation', STRINGS.automation.title],
      ]) {
        const a = document.createElement('a');
        a.href = `#/servers/${route.id}/${screen}`;
        a.append(
          icon(
            {
              overview: 'server',
              settings: 'settings',
              maps: 'map',
              backups: 'backup',
              network: 'network',
              automation: 'jobs',
            }[screen],
          ),
          label,
        );
        if (screen === route.screen) a.setAttribute('aria-current', 'page');
        nav.append(a);
      }
      this.view.replaceChildren(nav, page);
      // On a narrow screen the tab strip scrolls, and the current tab may start out of sight.
      nav.querySelector('[aria-current]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const edges = () => {
        nav.classList.toggle('has-more-left', nav.scrollLeft > 2);
        nav.classList.toggle('has-more-right', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
      };
      nav.addEventListener('scroll', edges, { passive: true });
      this.navObserver = new ResizeObserver(edges);
      this.navObserver.observe(nav);
      requestAnimationFrame(edges);
    } else if (route.screen === 'servers') this.view.replaceChildren(document.createElement('ao-servers'));
    else if (route.screen === 'clusters' || route.screen === 'cluster') {
      const page = document.createElement('ao-clusters');
      if (route.id) page.setAttribute('cluster-id', route.id);
      this.view.replaceChildren(page);
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
