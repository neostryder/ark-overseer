// A CurseForge mod id, optionally followed by -dev, which loads that mod's unpublished test build. The server
// checks the same pattern before it launches.
export const MOD_ID = /^\d+(-dev)?$/;

const base = (id) =>
  String(id)
    .replace(/-dev$/, '')
    .replace(/^0+(?=\d)/, '');

// The list with the id added at the end, or null when that mod is already listed (123 and 123-dev are one mod).
export function addMod(mods, id) {
  return mods.some((item) => base(item) === base(id)) ? null : [...mods, String(id)];
}

export function removeMod(mods, index) {
  return mods.filter((_, position) => position !== index);
}

// The list with the id at `index` moved by `step` places, or the list as it was when that runs off either end.
export function moveMod(mods, index, step) {
  const target = index + step;
  if (target < 0 || target >= mods.length) return mods;
  const next = [...mods];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
