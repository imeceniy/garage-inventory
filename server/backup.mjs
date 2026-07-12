import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, openDatabase } from './database.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retention = Math.max(1, Number(process.argv[2] || 14));
const { db, backupDir } = openDatabase(rootDir, { backupOnStart: false });

try {
  const backupPath = createBackup(db, backupDir, retention);
  console.log(backupPath);
} finally {
  db.close();
}
