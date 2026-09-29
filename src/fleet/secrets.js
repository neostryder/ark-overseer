// Password overrides live only in the owning database session until the clone settles.
const sessions = new WeakMap();
export function clonePasswords(db) {
  let values = sessions.get(db);
  if (!values) {
    values = new Map();
    sessions.set(db, values);
  }
  return values;
}
