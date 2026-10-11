import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { stateName } from '../lib/format.js';
import { icon } from '../lib/icon.js';
import { mapName } from '../lib/wizard.js';
import { GENERIC_MAP_ART, markArtFailed, railPictureUrl } from '../lib/map-art.js';
import { themeMode, nextMode, setThemeMode, watchSystemTheme } from '../lib/theme.js';

watchSystemTheme();

export class AoFleetRail extends HTMLElement {
  connectedCallback() {
    this.app = this.closest('ao-app');
    this.onServers = ({ detail }) => {
      if (detail.servers) this.servers = detail.servers;
      this.refreshError = detail.error;
      this.render();
    };
    this.app?.addEventListener('servers-loaded', this.onServers);
    this.servers = this.app?.servers;
    this.render();
    // The catalog says which maps are official and whether Steam pictures are allowed. Until it loads,
    // or if it fails, every server shows the generic picture.
    api
      .get('/api/maps')
      .then((maps) => {
        this.maps = maps;
        this.render();
      })
      .catch(() => {});
  }
  // The rail is drawn again on every server poll. A server keeps its picture element while the picture it
  // should show stays the same, so nothing is fetched again and nothing flickers.
  thumbFor(server) {
    this.thumbs ??= new Map();
    const want = railPictureUrl(server, this.maps);
    const kept = this.thumbs.get(server.id);
    if (kept?.dataset.want === want) return kept;
    const thumb = document.createElement('img');
    thumb.className = 'rail-thumb';
    // The server's name and map are written beside it, so the picture adds nothing for a screen reader.
    thumb.alt = '';
    thumb.width = 460;
    thumb.height = 215;
    thumb.decoding = 'async';
    thumb.loading = this.servers?.indexOf(server) > 2 ? 'lazy' : 'eager';
    thumb.dataset.want = want;
    thumb.addEventListener('error', () => {
      markArtFailed(want);
      if (!thumb.src.endsWith(GENERIC_MAP_ART)) thumb.src = GENERIC_MAP_ART;
    });
    // The source is set after the listener, so even a failure reported at once reaches it.
    thumb.src = want;
    this.thumbs.set(server.id, thumb);
    return thumb;
  }
  disconnectedCallback() {
    this.app?.removeEventListener('servers-loaded', this.onServers);
  }
  render() {
    const scroll = this.scrollTop;
    const active = this.contains(document.activeElement) ? document.activeElement : null;
    const focused = active?.getAttribute('href');
    const expandFocused = active?.classList.contains('rail-expand');
    this.replaceChildren();
    this.className = 'fleet-rail';
    const brand = document.createElement('a');
    brand.className = 'brand';
    brand.href = '#/';
    const mark = document.createElement('img');
    mark.className = 'brand-mark';
    mark.src = '/favicon.svg';
    mark.alt = '';
    mark.width = 38;
    mark.height = 38;
    const name = document.createElement('span');
    name.textContent = STRINGS.app.name;
    brand.append(mark, name);
    brand.title = STRINGS.app.name;
    const expand = document.createElement('button');
    expand.className = 'button quiet rail-expand';
    expand.type = 'button';
    const expanded = Boolean(this.app?.classList.contains('rail-expanded'));
    expand.setAttribute('aria-label', expanded ? STRINGS.app.collapseRail : STRINGS.app.expandRail);
    expand.setAttribute('aria-expanded', String(expanded));
    expand.title = expanded ? STRINGS.app.collapseRail : STRINGS.app.expandRail;
    expand.append(icon('menu'));
    expand.addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('rail-toggle', { detail: { opener: expand } })),
    );
    const heading = document.createElement('a');
    heading.className = 'rail-heading';
    heading.href = '#/servers';
    heading.title = STRINGS.fleet.servers;
    heading.setAttribute('aria-label', STRINGS.fleet.servers);
    heading.append(icon('server'), document.createTextNode(STRINGS.fleet.servers));
    this.append(brand, expand, heading);
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
      link.setAttribute(
        'aria-label',
        STRINGS.fleet.serverLabel
          .replace('{name}', server.name)
          .replace('{map}', mapName(server.map))
          .replace('{state}', stateName(server.status?.observedState)),
      );
      const clusterLabel = STRINGS.fleet.clusterLabel;
      link.title = server.cluster_name
        ? `${server.name}, ${clusterLabel.replace('{name}', server.cluster_name)}`
        : server.name;
      const serverName = document.createElement('strong');
      serverName.textContent = server.name;
      serverName.title = server.name;
      const meta = document.createElement('span');
      meta.textContent = `${mapName(server.map)} · ${stateName(server.status?.observedState)}`;
      meta.title = meta.textContent;
      const text = document.createElement('span');
      text.className = 'server-text';
      text.append(serverName, meta);
      if (server.cluster_name) {
        const cluster = document.createElement('span');
        cluster.className = 'rail-cluster';
        cluster.textContent = clusterLabel.replace('{name}', server.cluster_name);
        text.append(cluster);
      }
      // A server on a Steam test branch is marked, since it cannot join live servers.
      if (server.install_branch && server.install_branch !== 'public') {
        const test = document.createElement('span');
        test.className = 'badge ptr-badge';
        test.textContent = STRINGS.builds.ptrBadge;
        test.title = STRINGS.builds.ptrBadgeHelp;
        text.append(test);
      }
      // Settings files that changed outside Overseer and that nobody has looked at yet.
      if (server.settingsChanged) {
        const flag = document.createElement('span');
        flag.className = 'badge drift-badge';
        flag.textContent = STRINGS.fleet.settingsChanged;
        flag.title = STRINGS.fleet.settingsChangedHelp;
        text.append(flag);
      }
      const thumb = this.thumbFor(server);
      const status = document.createElement('span');
      status.className = `rail-status ${server.status?.observedState ?? 'unknown'}`;
      status.setAttribute('aria-hidden', 'true');
      status.title = link.title;
      link.append(thumb, status, text);
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
    add.title = STRINGS.fleet.add;
    this.append(add);
    const clusters = document.createElement('a');
    clusters.className = 'button secondary rail-clusters';
    clusters.href = '#/clusters';
    clusters.append(icon('network'), document.createTextNode(STRINGS.fleet.clusters));
    clusters.title = STRINGS.fleet.clusters;
    this.append(clusters);
    const bottom = document.createElement('div');
    bottom.className = 'rail-bottom';
    const account = document.createElement('a');
    account.href = '#/account';
    account.setAttribute('aria-label', STRINGS.fleet.account);
    account.title = STRINGS.fleet.account;
    account.append(icon('account'), document.createTextNode(STRINGS.fleet.account));
    const host = document.createElement('a');
    host.href = '#/host';
    host.setAttribute('aria-label', STRINGS.fleet.host);
    host.title = STRINGS.fleet.host;
    host.append(icon('settings'), document.createTextNode(STRINGS.fleet.host));
    const signOut = document.createElement('button');
    signOut.className = 'button quiet';
    signOut.setAttribute('aria-label', STRINGS.fleet.signOut);
    signOut.title = STRINGS.fleet.signOut;
    signOut.append(icon('sign-out'), STRINGS.fleet.signOut);
    signOut.addEventListener('click', async () => {
      try {
        await api.post('/api/auth/logout', {});
      } finally {
        window.location.assign('/login.html');
      }
    });
    const mode = themeMode();
    const themeTemplate = STRINGS.app.theme;
    const themeLabel = themeTemplate.replace('{mode}', STRINGS.app.themeModes[mode]);
    const themeButton = document.createElement('button');
    themeButton.className = 'button quiet';
    themeButton.type = 'button';
    themeButton.setAttribute('aria-label', themeLabel);
    themeButton.title = `${themeLabel}. ${STRINGS.app.themeHelp}`;
    themeButton.append(icon(`theme-${mode}`), themeLabel);
    themeButton.addEventListener('click', () => {
      setThemeMode(nextMode(themeMode()));
      this.render();
      this.querySelector('.rail-bottom .theme-toggle')?.focus();
    });
    themeButton.classList.add('theme-toggle');
    bottom.append(host, account, themeButton, signOut);
    this.append(bottom);
    this.scrollTop = scroll;
    if (focused) [...this.querySelectorAll('a[href]')].find((link) => link.getAttribute('href') === focused)?.focus();
    else if (expandFocused) expand.focus();
  }
}
customElements.define('ao-fleet-rail', AoFleetRail);
