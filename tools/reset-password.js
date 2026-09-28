import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/index.js';
import { transaction } from '../src/db/transaction.js';

// Recovery for a forgotten password or a lost device. The passkeys go too, since a reset is also the
// way to lock out a device that should no longer get in. A new secret signs every browser out.
const folder = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'));
const db = openDatabase(path.join(folder, 'overseer.db'));
try {
  transaction(db, () => {
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    if (!user) return;
    db.prepare('UPDATE users SET password_hash = NULL, session_secret = ?, updated_at = ? WHERE id = ?').run(
      crypto.randomBytes(32),
      new Date().toISOString(),
      user.id,
    );
    db.prepare('DELETE FROM user_passkeys WHERE user_id = ?').run(user.id);
  });
  console.log('The password and passkeys are cleared. Open ARK Overseer on this computer to set a new password.');
} finally {
  db.close();
}
