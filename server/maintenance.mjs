// @ts-check
import { createBackup } from './database.mjs';

const dayMs = 24 * 60 * 60 * 1000;

export function runIntegrityCheck(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const messages = rows.map((row) => String(row.integrity_check));
  if (messages.length !== 1 || messages[0] !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${messages.join('; ')}`);
  }
  return true;
}

export function scheduleMaintenance({ db, backupDir, retention }) {
  const timer = setInterval(() => {
    try {
      runIntegrityCheck(db);
      createBackup(db, backupDir, retention);
    } catch (error) {
      console.error('Scheduled database maintenance failed', error);
    }
  }, dayMs);
  timer.unref();
  return timer;
}
