import { api } from '../api.js';
import { STRINGS } from '../strings.js';
import { relativeTime } from '../lib/format.js';
import { newBuilds, bannerText } from '../lib/builds.js';

const KEY = 'ao.builds.dismissed';
const POLL_MS = 5 * 60 * 1000;

// The browser's own memory of what was dismissed. It can be missing or blocked, and the banner works without it.
function readDismissed() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function writeDismissed(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Without storage the banner returns on the next page load.
  }
}

// A strip above the page when Steam has a new server build on any branch that nobody has dismissed.
export class AoBuildBanner extends HTMLElement {
  connectedCallback() {
    this.hidden = true;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }
  disconnectedCallback() {
    clearInterval(this.timer);
  }
  async refresh() {
    try {
      this.rows = newBuilds((await api.get('/api/builds')).branches, readDismissed());
    } catch {
      return;
    }
    this.render();
  }
  render() {
    this.replaceChildren();
    this.hidden = !this.rows.length;
    if (!this.rows.length) return;
    this.className = 'card restart-banner build-banner';
    this.setAttribute('role', 'status');
    const lines = document.createElement('span');
    lines.textContent = bannerText(this.rows, relativeTime).join(' ');
    const dismiss = document.createElement('button');
    dismiss.className = 'button quiet';
    dismiss.textContent = STRINGS.builds.dismiss;
    dismiss.addEventListener('click', () => {
      const seen = readDismissed();
      for (const row of this.rows) seen[row.branch] = row.build_id;
      writeDismissed(seen);
      this.rows = [];
      this.render();
    });
    this.append(lines, dismiss);
  }
}
customElements.define('ao-build-banner', AoBuildBanner);
