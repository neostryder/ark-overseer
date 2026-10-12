import { fleetSummary } from './fleet-summary.js';

// The browser tab shows whether anything needs attention: a count in the title and a red dot on the icon.
export function tabTitle(baseName, servers) {
  const { bad } = fleetSummary(servers);
  return bad > 0 ? `(${bad}) ${baseName}` : baseName;
}

// The favicon with a dot in its top right corner. The original markup is kept, so the icon stays in step
// with /favicon.svg.
export function badgedIcon(svgText) {
  const dot = '<circle cx="50" cy="14" r="11" fill="#d9534f" stroke="#0a0f0a" stroke-width="3"/>';
  return svgText.replace('</svg>', `${dot}</svg>`);
}

export function dataUri(svgText) {
  return `data:image/svg+xml,${encodeURIComponent(svgText)}`;
}

// Keeps the title and icon in step with the fleet. Fetching the icon is best effort: without it the title
// still changes and the icon stays as it is.
export function createTabStatus({ baseName, link = document.querySelector('link[rel="icon"]'), fetchSvg }) {
  const plain = link?.getAttribute('href');
  let badged = null;
  let last = null;
  return async function update(servers) {
    const title = tabTitle(baseName, servers);
    document.title = title;
    if (!link || title === last) return;
    last = title;
    if (title === baseName) {
      link.setAttribute('href', plain);
      return;
    }
    try {
      badged ??= dataUri(badgedIcon(await fetchSvg(plain)));
      if (last === title) link.setAttribute('href', badged);
    } catch {
      // The count in the title is enough.
    }
  };
}
