// The tab for the current page: the Servers tab also covers one server's pages, and Clusters covers one cluster.
export function tabFor(hash) {
  const value = String(hash || '#/');
  if (value.startsWith('#/clusters')) return 'clusters';
  if (value.startsWith('#/host')) return 'host';
  if (value.startsWith('#/account')) return 'account';
  if (value === '#/' || value.startsWith('#/servers') || value.startsWith('#/setup')) return 'servers';
  return null;
}
