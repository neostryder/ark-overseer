const patterns = [
  [/^#\/clusters\/(\d+)$/, (m) => ({ screen: 'cluster', id: Number(m[1]) })],
  [/^#\/clusters$/, () => ({ screen: 'clusters' })],
  [/^#\/servers\/(\d+)\/overview$/, (m) => ({ screen: 'overview', id: Number(m[1]) })],
  [/^#\/servers\/(\d+)\/settings$/, (m) => ({ screen: 'settings', id: Number(m[1]) })],
  [/^#\/servers\/(\d+)\/maps$/, (m) => ({ screen: 'maps', id: Number(m[1]) })],
  [/^#\/servers\/(\d+)\/backups$/, (m) => ({ screen: 'backups', id: Number(m[1]) })],
  [/^#\/servers\/(\d+)\/network$/, (m) => ({ screen: 'network', id: Number(m[1]) })],
  [/^#\/servers\/(\d+)\/automation$/, (m) => ({ screen: 'automation', id: Number(m[1]) })],
  [/^#\/jobs$/, () => ({ screen: 'jobs' })],
  [/^#\/account$/, () => ({ screen: 'account' })],
  [/^#\/host$/, () => ({ screen: 'host' })],
  [/^#\/setup$/, () => ({ screen: 'setup' })],
  [/^#\/$/, () => ({ screen: 'home' })],
];
export function parseRoute(hash) {
  const value = String(hash || '#/');
  for (const [pattern, make] of patterns) {
    const match = value.match(pattern);
    if (match) return make(match);
  }
  return { screen: 'unknown' };
}
export function buildRoute(route) {
  if (typeof route === 'string') return route.startsWith('#') ? route : `#${route}`;
  if (route?.screen === 'home') return '#/';
  if (route?.screen === 'cluster' && Number.isInteger(Number(route.id)) && Number(route.id) > 0)
    return `#/clusters/${Number(route.id)}`;
  if (
    ['overview', 'settings', 'maps', 'backups', 'network', 'automation'].includes(route?.screen) &&
    Number.isInteger(Number(route.id)) &&
    Number(route.id) > 0
  )
    return `#/servers/${Number(route.id)}/${route.screen}`;
  if (['jobs', 'account', 'host', 'setup', 'clusters'].includes(route?.screen)) return `#/${route.screen}`;
  return '#/';
}
