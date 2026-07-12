import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  {
    version: 1,
    name: 'initial schema',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          quantity REAL NOT NULL DEFAULT 0,
          unit TEXT NOT NULL DEFAULT 'шт',
          location TEXT NOT NULL DEFAULT '',
          locations TEXT NOT NULL DEFAULT '[]',
          barcode TEXT NOT NULL DEFAULT '',
          project TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          containerId TEXT NOT NULL DEFAULT '',
          photo TEXT NOT NULL DEFAULT '',
          minQuantity REAL NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS history (
          id TEXT PRIMARY KEY,
          itemId TEXT NOT NULL,
          itemName TEXT NOT NULL,
          amount REAL NOT NULL,
          quantityAfter REAL NOT NULL,
          action TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS containers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          code TEXT NOT NULL UNIQUE,
          location TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS inventory_sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          startedAt TEXT NOT NULL,
          completedAt TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS inventory_checks (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL,
          itemId TEXT NOT NULL,
          itemName TEXT NOT NULL,
          expectedQuantity REAL NOT NULL,
          actualQuantity REAL NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          checkedAt TEXT NOT NULL,
          FOREIGN KEY (sessionId) REFERENCES inventory_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE CASCADE
        );
      `);

      const existingColumns = new Set(db.prepare('PRAGMA table_info(items)').all().map((column) => column.name));
      const itemColumns = [
        ['locations', "ALTER TABLE items ADD COLUMN locations TEXT NOT NULL DEFAULT '[]'"],
        ['barcode', "ALTER TABLE items ADD COLUMN barcode TEXT NOT NULL DEFAULT ''"],
        ['project', "ALTER TABLE items ADD COLUMN project TEXT NOT NULL DEFAULT ''"],
        ['tags', "ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"],
        ['containerId', "ALTER TABLE items ADD COLUMN containerId TEXT NOT NULL DEFAULT ''"],
        ['photo', "ALTER TABLE items ADD COLUMN photo TEXT NOT NULL DEFAULT ''"]
      ];

      for (const [column, statement] of itemColumns) {
        if (!existingColumns.has(column)) db.exec(statement);
      }
    }
  },
  {
    version: 2,
    name: 'query indexes',
    run(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
        CREATE INDEX IF NOT EXISTS idx_items_container ON items(containerId);
        CREATE INDEX IF NOT EXISTS idx_items_project ON items(project);
        CREATE INDEX IF NOT EXISTS idx_history_item_date ON history(itemId, createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_history_date ON history(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_inventory_checks_session ON inventory_checks(sessionId, checkedAt DESC);
      `);
    }
  },
  {
    version: 3,
    name: 'preserve item history after deletion',
    run(db) {
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(history)').all();
      if (!foreignKeys.length) return;

      db.exec(`
        ALTER TABLE history RENAME TO history_with_item_fk;
        CREATE TABLE history (
          id TEXT PRIMARY KEY,
          itemId TEXT NOT NULL,
          itemName TEXT NOT NULL,
          amount REAL NOT NULL,
          quantityAfter REAL NOT NULL,
          action TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        INSERT INTO history (id, itemId, itemName, amount, quantityAfter, action, createdAt)
        SELECT id, itemId, itemName, amount, quantityAfter, action, createdAt
        FROM history_with_item_fk;
        DROP TABLE history_with_item_fk;
        CREATE INDEX IF NOT EXISTS idx_history_item_date ON history(itemId, createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_history_date ON history(createdAt DESC);
      `);
    }
  },
  {
    version: 4,
    name: 'preserve inventory checks after item deletion',
    run(db) {
      const hasItemForeignKey = db
        .prepare('PRAGMA foreign_key_list(inventory_checks)')
        .all()
        .some((foreignKey) => foreignKey.table === 'items');
      if (!hasItemForeignKey) return;

      db.exec(`
        ALTER TABLE inventory_checks RENAME TO inventory_checks_with_item_fk;
        CREATE TABLE inventory_checks (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL,
          itemId TEXT NOT NULL,
          itemName TEXT NOT NULL,
          expectedQuantity REAL NOT NULL,
          actualQuantity REAL NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          checkedAt TEXT NOT NULL,
          FOREIGN KEY (sessionId) REFERENCES inventory_sessions(id) ON DELETE CASCADE
        );
        INSERT INTO inventory_checks (
          id, sessionId, itemId, itemName, expectedQuantity, actualQuantity, note, checkedAt
        )
        SELECT id, sessionId, itemId, itemName, expectedQuantity, actualQuantity, note, checkedAt
        FROM inventory_checks_with_item_fk;
        DROP TABLE inventory_checks_with_item_fk;
        CREATE INDEX IF NOT EXISTS idx_inventory_checks_session ON inventory_checks(sessionId, checkedAt DESC);
      `);
    }
  },
  {
    version: 5,
    name: 'stock balances by storage place',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stock_balances (
          id TEXT PRIMARY KEY,
          itemId TEXT NOT NULL,
          containerId TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE CASCADE,
          UNIQUE (itemId, containerId, location)
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
          id TEXT PRIMARY KEY,
          itemId TEXT NOT NULL,
          itemName TEXT NOT NULL,
          fromBalanceId TEXT NOT NULL DEFAULT '',
          toBalanceId TEXT NOT NULL DEFAULT '',
          amount REAL NOT NULL CHECK (amount >= 0),
          action TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_stock_balances_item ON stock_balances(itemId);
        CREATE INDEX IF NOT EXISTS idx_stock_balances_container ON stock_balances(containerId);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_item_date ON stock_movements(itemId, createdAt DESC);
      `);

      const insertBalance = db.prepare(`
        INSERT INTO stock_balances (id, itemId, containerId, location, quantity, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const items = db.prepare(`
        SELECT id, containerId, location, quantity, createdAt, updatedAt
        FROM items
        WHERE NOT EXISTS (SELECT 1 FROM stock_balances WHERE stock_balances.itemId = items.id)
      `).all();

      for (const item of items) {
        insertBalance.run(
          crypto.randomUUID(),
          item.id,
          item.containerId || '',
          item.location || '',
          Math.max(0, Number(item.quantity) || 0),
          item.createdAt,
          item.updatedAt
        );
      }
    }
  }
];

export function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL
    );
  `);

  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const insertMigration = db.prepare('INSERT INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      migration.run(db);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    });
  }
}

function pruneBackups(backupDir, keep) {
  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => /^garage-\d{8}-\d{6}-\d{3}\.sqlite$/.test(name))
    .sort()
    .reverse();

  for (const name of backups.slice(keep)) {
    fs.rmSync(path.join(backupDir, name));
  }
}

export function createBackup(db, backupDir, keep = 14) {
  fs.mkdirSync(backupDir, { recursive: true });
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}-${iso.slice(20, 23)}`;
  const backupPath = path.join(backupDir, `garage-${stamp}.sqlite`);
  const escapedPath = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  pruneBackups(backupDir, keep);
  return backupPath;
}

export function openDatabase(rootDir, options = {}) {
  const dataDir = path.join(rootDir, 'data');
  const backupDir = path.join(dataDir, 'backups');
  const dbPath = path.join(dataDir, 'garage.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  if (options.backupOnStart !== false && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    createBackup(db, backupDir, options.backupRetention || 14);
  }

  runMigrations(db);
  return { db, dbPath, backupDir };
}
