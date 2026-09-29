// The Settings page uses the same rule as the cluster apply job: a shared key is inherited unless
// this server lists it as an override. An overridden key remains editable as a local setting.
export function clusterFieldState(fieldKey, cluster, overrides = []) {
  if (!cluster || !Object.hasOwn(cluster.settings ?? {}, fieldKey)) return 'local';
  return overrides.includes(fieldKey) ? 'override' : 'inherited';
}

export function clusterEditChoice(changes, cluster, overrides = []) {
  return changes.some((change) => clusterFieldState(change.key, cluster, overrides) === 'inherited');
}
