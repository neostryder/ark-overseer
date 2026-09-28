import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('Usage: node tools/list-install-folders.js <dataDir>');
const db = new DatabaseSync(path.join(dataDir, 'overseer.db'), { readOnly: true });
try {
  for (const row of db.prepare('SELECT path FROM installs ORDER BY id').all()) console.log(row.path);
} finally {
  db.close();
}
