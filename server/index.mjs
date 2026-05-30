import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'garage.sqlite');

// Load a local .env file before reading runtime settings.
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT || 8782);
const password = process.env.GARAGE_PASSWORD;

if (!password) {
  console.error('GARAGE_PASSWORD is required');
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });

// Keep the schema intentionally small so the app stays easy to back up and move.
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'шт',
    location TEXT NOT NULL DEFAULT '',
    minQuantity REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

const app = express();
const sessions = new Map();
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

app.use(express.json({ limit: '100kb' }));

// Normalize API output so SQLite rows do not leak database-specific shape.
function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    location: row.location,
    minQuantity: row.minQuantity,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function readToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// Sessions are in memory: simple enough for a home server, and invalidated on restart.
function requireAuth(req, res, next) {
  const token = readToken(req);
  const expiresAt = sessions.get(token);

  if (!token || !expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  sessions.set(token, Date.now() + sessionTtlMs);
  next();
}

// Use one validator for create and partial update requests.
function validateItem(payload, partial = false) {
  const item = {};

  if (!partial || payload.name !== undefined) {
    item.name = normalizeText(payload.name);
    if (!item.name) throw new Error('Название обязательно');
  }

  if (!partial || payload.category !== undefined) {
    item.category = normalizeText(payload.category) || 'Прочее';
  }

  if (!partial || payload.quantity !== undefined) {
    item.quantity = Math.max(0, normalizeNumber(payload.quantity));
  }

  if (!partial || payload.unit !== undefined) {
    item.unit = normalizeText(payload.unit) || 'шт';
  }

  if (!partial || payload.location !== undefined) {
    item.location = normalizeText(payload.location);
  }

  if (!partial || payload.minQuantity !== undefined) {
    item.minQuantity = Math.max(0, normalizeNumber(payload.minQuantity));
  }

  if (!partial || payload.note !== undefined) {
    item.note = normalizeText(payload.note);
  }

  return item;
}

app.post('/api/auth/login', (req, res) => {
  if (req.body?.password !== password) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + sessionTtlMs);
  res.json({ token });
});

app.get('/api/auth/me', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

// Inventory CRUD endpoints.
app.get('/api/items', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY lower(name), createdAt').all();
  res.json(rows.map(toItem));
});

app.post('/api/items', requireAuth, (req, res) => {
  try {
    const item = validateItem(req.body);
    const id = crypto.randomUUID();
    const timestamp = nowIso();

    db.prepare(`
      INSERT INTO items (id, name, category, quantity, unit, location, minQuantity, note, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      item.name,
      item.category,
      item.quantity,
      item.unit,
      item.location,
      item.minQuantity,
      item.note,
      timestamp,
      timestamp
    );

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    res.status(201).json(toItem(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/items/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }

  try {
    const update = { ...toItem(existing), ...validateItem(req.body, true), updatedAt: nowIso() };
    db.prepare(`
      UPDATE items
      SET name = ?, category = ?, quantity = ?, unit = ?, location = ?, minQuantity = ?, note = ?, updatedAt = ?
      WHERE id = ?
    `).run(
      update.name,
      update.category,
      update.quantity,
      update.unit,
      update.location,
      update.minQuantity,
      update.note,
      update.updatedAt,
      req.params.id
    );

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    res.json(toItem(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/items/:id/adjust', requireAuth, (req, res) => {
  const amount = normalizeNumber(req.body?.amount, Number.NaN);
  if (!Number.isFinite(amount)) {
    res.status(400).json({ error: 'Некорректное изменение количества' });
    return;
  }

  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }

  const quantity = Math.max(0, existing.quantity + amount);
  db.prepare('UPDATE items SET quantity = ?, updatedAt = ? WHERE id = ?').run(quantity, nowIso(), req.params.id);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(toItem(row));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // Let React handle deep links after static assets and API routes are checked.
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Garage inventory is running on http://0.0.0.0:${port}`);
});
