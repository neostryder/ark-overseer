export function parseGameNames(value) {
  return String(value)
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}
export function validGameNames(names) {
  return (
    Array.isArray(names) &&
    names.length <= 50 &&
    names.every(
      (name) =>
        typeof name === 'string' &&
        name.trim() === name &&
        name.length >= 1 &&
        name.length <= 64 &&
        /\.exe$/i.test(name) &&
        !/[\\/\x00-\x1f\x7f]/.test(name),
    )
  );
}
