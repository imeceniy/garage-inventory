import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, openDatabase, withTransaction } from './database.mjs';

const temporaryDirectories = [];

function createTestDatabase() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-inventory-'));
  temporaryDirectories.push(rootDir);
  return { rootDir, ...openDatabase(rootDir, { backupOnStart: false }) };
}

function insertItem(db, id = 'item-1') {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO items (
      id, name, category, quantity, unit, location, locations, barcode, project, tags,
      containerId, photo, minQuantity, note, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'Тестовая позиция', 'Прочее', 5, 'шт', '', '[]', '', '', '[]', '', '', 0, '', timestamp, timestamp);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('database foundation', () => {
  it('applies versioned migrations and enables foreign keys', () => {
    const { db } = createTestDatabase();
    expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count).toBe(5);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    db.close();
  });

  it('keeps immutable history after an item is deleted', () => {
    const { db } = createTestDatabase();
    insertItem(db);
    db.prepare(`
      INSERT INTO history (id, itemId, itemName, amount, quantityAfter, action, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('history-1', 'item-1', 'Тестовая позиция', 5, 5, 'create', new Date().toISOString());

    db.prepare('DELETE FROM items WHERE id = ?').run('item-1');
    expect(db.prepare('SELECT count(*) AS count FROM history').get().count).toBe(1);
    db.close();
  });

  it('keeps inventory audit records after an item is deleted', () => {
    const { db } = createTestDatabase();
    insertItem(db);
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO inventory_sessions (id, name, status, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-1', 'Проверка', 'closed', timestamp, timestamp);
    db.prepare(`
      INSERT INTO inventory_checks (
        id, sessionId, itemId, itemName, expectedQuantity, actualQuantity, note, checkedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('check-1', 'session-1', 'item-1', 'Тестовая позиция', 5, 4, '', timestamp);

    db.prepare('DELETE FROM items WHERE id = ?').run('item-1');
    expect(db.prepare('SELECT count(*) AS count FROM inventory_checks').get().count).toBe(1);
    db.close();
  });

  it('migrates the legacy cascading history table without losing records', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-inventory-legacy-'));
    temporaryDirectories.push(rootDir);
    const dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dataDir, 'garage.sqlite'));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE items (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, quantity REAL NOT NULL,
        unit TEXT NOT NULL, location TEXT NOT NULL, locations TEXT NOT NULL, barcode TEXT NOT NULL,
        project TEXT NOT NULL, tags TEXT NOT NULL, containerId TEXT NOT NULL, photo TEXT NOT NULL,
        minQuantity REAL NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE history (
        id TEXT PRIMARY KEY, itemId TEXT NOT NULL, itemName TEXT NOT NULL, amount REAL NOT NULL,
        quantityAfter REAL NOT NULL, action TEXT NOT NULL, createdAt TEXT NOT NULL,
        FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE CASCADE
      );
    `);
    insertItem(legacy);
    legacy.prepare(`
      INSERT INTO history (id, itemId, itemName, amount, quantityAfter, action, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-history', 'item-1', 'Тестовая позиция', 5, 5, 'create', new Date().toISOString());
    legacy.close();

    const { db } = openDatabase(rootDir, { backupOnStart: false });
    expect(db.prepare('PRAGMA foreign_key_list(history)').all()).toHaveLength(0);
    expect(db.prepare('SELECT quantity FROM stock_balances WHERE itemId = ?').get('item-1').quantity).toBe(5);
    db.prepare('DELETE FROM items WHERE id = ?').run('item-1');
    expect(db.prepare('SELECT count(*) AS count FROM history').get().count).toBe(1);
    db.close();
  });

  it('rolls back all writes when a transaction fails', () => {
    const { db } = createTestDatabase();
    expect(() =>
      withTransaction(db, () => {
        insertItem(db);
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(db.prepare('SELECT count(*) AS count FROM items').get().count).toBe(0);
    db.close();
  });

  it('creates a readable SQLite backup', () => {
    const { db, backupDir } = createTestDatabase();
    insertItem(db);
    const backupPath = createBackup(db, backupDir);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare('SELECT count(*) AS count FROM items').get().count).toBe(1);
    backup.close();
    db.close();
  });
});
