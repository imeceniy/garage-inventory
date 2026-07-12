import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDatabase, withTransaction } from './database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

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
const httpsPort = Number(process.env.HTTPS_PORT || 0);
const httpsKeyPath = process.env.HTTPS_KEY ? path.resolve(rootDir, process.env.HTTPS_KEY) : '';
const httpsCertPath = process.env.HTTPS_CERT ? path.resolve(rootDir, process.env.HTTPS_CERT) : '';
const password = process.env.GARAGE_PASSWORD;
const backupOnStart = process.env.BACKUP_ON_START !== 'false';
const configuredBackupRetention = Number(process.env.BACKUP_RETENTION || 14);
const backupRetention = Number.isInteger(configuredBackupRetention) && configuredBackupRetention > 0 ? configuredBackupRetention : 14;

if (!password) {
  console.error('GARAGE_PASSWORD is required');
  process.exit(1);
}

const { db } = openDatabase(rootDir, { backupOnStart, backupRetention });

const app = express();
const sessions = new Map();
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

app.use(express.json({ limit: '5mb' }));

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

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  return normalizeText(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseList(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string' && entry.trim()) : fallback;
  } catch {
    return fallback;
  }
}

function toItem(row) {
  const legacyLocation = normalizeText(row.location);
  const locations = parseList(row.locations, legacyLocation ? [legacyLocation] : []);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    location: legacyLocation,
    locations,
    barcode: row.barcode,
    project: row.project,
    tags: parseList(row.tags),
    containerId: row.containerId,
    photo: row.photo,
    minQuantity: row.minQuantity,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toStockBalance(row) {
  return {
    id: row.id,
    itemId: row.itemId,
    containerId: row.containerId,
    location: row.location,
    quantity: row.quantity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function stockBalances(itemId) {
  return db
    .prepare('SELECT * FROM stock_balances WHERE itemId = ? ORDER BY createdAt, id')
    .all(itemId)
    .map(toStockBalance);
}

function toItemWithBalances(row) {
  const item = toItem(row);
  return { ...item, balances: stockBalances(item.id) };
}

function setItemTotalQuantity(item, targetQuantity, timestamp = nowIso()) {
  const target = Math.max(0, targetQuantity);
  const balances = stockBalances(item.id);

  if (!balances.length) {
    db.prepare(`
      INSERT INTO stock_balances (id, itemId, containerId, location, quantity, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), item.id, item.containerId || '', item.location || '', target, timestamp, timestamp);
  } else {
    const currentTotal = balances.reduce((sum, balance) => sum + balance.quantity, 0);
    let delta = target - currentTotal;
    if (delta > 0) {
      const primary = balances[0];
      db.prepare('UPDATE stock_balances SET quantity = ?, updatedAt = ? WHERE id = ?').run(primary.quantity + delta, timestamp, primary.id);
    } else if (delta < 0) {
      let remaining = Math.abs(delta);
      for (const balance of balances) {
        if (remaining <= 0) break;
        const deducted = Math.min(balance.quantity, remaining);
        db.prepare('UPDATE stock_balances SET quantity = ?, updatedAt = ? WHERE id = ?').run(balance.quantity - deducted, timestamp, balance.id);
        remaining -= deducted;
      }
    }
  }

  db.prepare('UPDATE items SET quantity = ?, updatedAt = ? WHERE id = ?').run(target, timestamp, item.id);
}

function syncItemQuantity(itemId, timestamp = nowIso()) {
  const total = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_balances WHERE itemId = ?').get(itemId).total;
  db.prepare('UPDATE items SET quantity = ?, updatedAt = ? WHERE id = ?').run(total, timestamp, itemId);
  return total;
}

function recordStockMovement(item, fromBalanceId, toBalanceId, amount, action) {
  db.prepare(`
    INSERT INTO stock_movements (id, itemId, itemName, fromBalanceId, toBalanceId, amount, action, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), item.id, item.name, fromBalanceId || '', toBalanceId || '', amount, action, nowIso());
}

function moveBalanceIdentity(balance, containerId, location, timestamp) {
  const duplicate = db.prepare(`
    SELECT * FROM stock_balances
    WHERE itemId = ? AND containerId = ? AND location = ? AND id <> ?
  `).get(balance.itemId, containerId, location, balance.id);

  if (duplicate) {
    db.prepare('UPDATE stock_balances SET quantity = quantity + ?, updatedAt = ? WHERE id = ?').run(balance.quantity, timestamp, duplicate.id);
    db.prepare('DELETE FROM stock_balances WHERE id = ?').run(balance.id);
    return;
  }

  db.prepare('UPDATE stock_balances SET containerId = ?, location = ?, updatedAt = ? WHERE id = ?').run(
    containerId,
    location,
    timestamp,
    balance.id
  );
}

function renameBalanceLocation(from, to, timestamp) {
  const balances = db.prepare('SELECT * FROM stock_balances WHERE location = ?').all(from).map(toStockBalance);
  for (const balance of balances) moveBalanceIdentity(balance, balance.containerId, to, timestamp);
}

function toContainer(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    location: row.location,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toInventorySession(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt
  };
}

function toInventoryCheck(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    itemId: row.itemId,
    itemName: row.itemName,
    expectedQuantity: row.expectedQuantity,
    actualQuantity: row.actualQuantity,
    note: row.note,
    checkedAt: row.checkedAt
  };
}

function toHistory(row) {
  return {
    id: row.id,
    itemId: row.itemId,
    itemName: row.itemName,
    amount: row.amount,
    quantityAfter: row.quantityAfter,
    action: row.action,
    createdAt: row.createdAt
  };
}

function recordHistory(item, amount, action) {
  db.prepare(`
    INSERT INTO history (id, itemId, itemName, amount, quantityAfter, action, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), item.id, item.name, amount, item.quantity, action, nowIso());
}

function replaceLocation(list, from, to) {
  const normalizedFrom = normalizeText(from);
  const normalizedTo = normalizeText(to);
  return list
    .map((entry) => (entry === normalizedFrom ? normalizedTo : entry))
    .filter(Boolean);
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

  if (!partial || payload.locations !== undefined) {
    item.locations = normalizeList(payload.locations);
  }

  if (!partial || payload.barcode !== undefined) {
    item.barcode = normalizeText(payload.barcode);
  }

  if (!partial || payload.project !== undefined) {
    item.project = normalizeText(payload.project);
  }

  if (!partial || payload.tags !== undefined) {
    item.tags = normalizeList(payload.tags);
  }

  if (!partial || payload.containerId !== undefined) {
    item.containerId = normalizeText(payload.containerId);
  }

  if (!partial || payload.photo !== undefined) {
    const photo = normalizeText(payload.photo);
    item.photo = photo.startsWith('data:image/') ? photo : '';
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
  res.json(rows.map(toItemWithBalances));
});

app.get('/api/history', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM history ORDER BY createdAt DESC LIMIT 200').all();
  res.json(rows.map(toHistory));
});

app.get('/api/items/:id/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM history WHERE itemId = ? ORDER BY createdAt DESC').all(req.params.id);
  res.json(rows.map(toHistory));
});

app.get('/api/meta', requireAuth, (_req, res) => {
  const items = db.prepare('SELECT locations, location, project, tags FROM items').all().map(toItem);
  const locations = new Set();
  const projects = new Set();
  const tags = new Set();

  for (const item of items) {
    for (const location of item.locations) locations.add(location);
    for (const tag of item.tags) tags.add(tag);
    if (item.project) projects.add(item.project);
  }

  res.json({
    locations: Array.from(locations).sort((a, b) => a.localeCompare(b, 'ru')),
    projects: Array.from(projects).sort((a, b) => a.localeCompare(b, 'ru')),
    tags: Array.from(tags).sort((a, b) => a.localeCompare(b, 'ru'))
  });
});

app.post('/api/meta/rename', requireAuth, (req, res) => {
  const type = req.body?.type;
  const from = normalizeText(req.body?.from);
  const to = normalizeText(req.body?.to);

  if (!['location', 'project', 'tag'].includes(type) || !from || !to) {
    res.status(400).json({ error: 'Некорректное переименование' });
    return;
  }

  const timestamp = nowIso();
  const rows = db.prepare('SELECT * FROM items').all();
  const update = db.prepare('UPDATE items SET location = ?, locations = ?, project = ?, tags = ?, updatedAt = ? WHERE id = ?');

  withTransaction(db, () => {
    for (const row of rows) {
      const item = toItem(row);
      if (type === 'project' && item.project === from) {
        update.run(item.location, JSON.stringify(item.locations), to, JSON.stringify(item.tags), timestamp, item.id);
      }

      if (type === 'location' && item.locations.includes(from)) {
        const locations = replaceLocation(item.locations, from, to);
        update.run(locations[0] || '', JSON.stringify(locations), item.project, JSON.stringify(item.tags), timestamp, item.id);
      }

      if (type === 'tag' && item.tags.includes(from)) {
        const tags = item.tags.map((entry) => (entry === from ? to : entry));
        update.run(item.location, JSON.stringify(item.locations), item.project, JSON.stringify(tags), timestamp, item.id);
      }
    }
    if (type === 'location') renameBalanceLocation(from, to, timestamp);
  });

  res.json({ ok: true });
});

app.post('/api/meta/delete', requireAuth, (req, res) => {
  const type = req.body?.type;
  const value = normalizeText(req.body?.value);

  if (!['location', 'project', 'tag'].includes(type) || !value) {
    res.status(400).json({ error: 'Некорректное удаление' });
    return;
  }

  const timestamp = nowIso();
  const rows = db.prepare('SELECT * FROM items').all();
  const update = db.prepare('UPDATE items SET location = ?, locations = ?, project = ?, tags = ?, updatedAt = ? WHERE id = ?');

  withTransaction(db, () => {
    for (const row of rows) {
      const item = toItem(row);
      if (type === 'project' && item.project === value) {
        update.run(item.location, JSON.stringify(item.locations), '', JSON.stringify(item.tags), timestamp, item.id);
      }

      if (type === 'location' && item.locations.includes(value)) {
        const locations = item.locations.filter((entry) => entry !== value);
        update.run(locations[0] || '', JSON.stringify(locations), item.project, JSON.stringify(item.tags), timestamp, item.id);
      }

      if (type === 'tag' && item.tags.includes(value)) {
        const tags = item.tags.filter((entry) => entry !== value);
        update.run(item.location, JSON.stringify(item.locations), item.project, JSON.stringify(tags), timestamp, item.id);
      }
    }
    if (type === 'location') renameBalanceLocation(value, '', timestamp);
  });

  res.json({ ok: true });
});

app.get('/api/containers', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM containers ORDER BY lower(name), createdAt').all();
  res.json(rows.map(toContainer));
});

app.post('/api/containers', requireAuth, (req, res) => {
  const name = normalizeText(req.body?.name);
  if (!name) {
    res.status(400).json({ error: 'Название контейнера обязательно' });
    return;
  }

  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const code = normalizeText(req.body?.code) || `container:${id}`;
  db.prepare(`
    INSERT INTO containers (id, name, code, location, note, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, code, normalizeText(req.body?.location), normalizeText(req.body?.note), timestamp, timestamp);

  res.status(201).json(toContainer(db.prepare('SELECT * FROM containers WHERE id = ?').get(id)));
});

app.patch('/api/containers/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM containers WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Контейнер не найден' });
    return;
  }

  const current = toContainer(existing);
  const update = {
    name: req.body?.name === undefined ? current.name : normalizeText(req.body.name),
    code: req.body?.code === undefined ? current.code : normalizeText(req.body.code),
    location: req.body?.location === undefined ? current.location : normalizeText(req.body.location),
    note: req.body?.note === undefined ? current.note : normalizeText(req.body.note)
  };

  if (!update.name || !update.code) {
    res.status(400).json({ error: 'Название и код контейнера обязательны' });
    return;
  }

  db.prepare('UPDATE containers SET name = ?, code = ?, location = ?, note = ?, updatedAt = ? WHERE id = ?').run(
    update.name,
    update.code,
    update.location,
    update.note,
    nowIso(),
    req.params.id
  );

  res.json(toContainer(db.prepare('SELECT * FROM containers WHERE id = ?').get(req.params.id)));
});

app.delete('/api/containers/:id', requireAuth, (req, res) => {
  withTransaction(db, () => {
    const timestamp = nowIso();
    const balances = db.prepare('SELECT * FROM stock_balances WHERE containerId = ?').all(req.params.id).map(toStockBalance);
    for (const balance of balances) moveBalanceIdentity(balance, '', balance.location, timestamp);
    db.prepare('UPDATE items SET containerId = ?, updatedAt = ? WHERE containerId = ?').run('', timestamp, req.params.id);
    db.prepare('DELETE FROM containers WHERE id = ?').run(req.params.id);
  });
  res.status(204).end();
});

app.get('/api/inventory/sessions', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM inventory_sessions ORDER BY startedAt DESC').all();
  res.json(rows.map(toInventorySession));
});

app.post('/api/inventory/sessions', requireAuth, (req, res) => {
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  const name = normalizeText(req.body?.name) || `Инвентаризация ${new Date().toLocaleDateString('ru-RU')}`;
  db.prepare('INSERT INTO inventory_sessions (id, name, status, startedAt, completedAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    'open',
    timestamp,
    ''
  );
  res.status(201).json(toInventorySession(db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(id)));
});

app.patch('/api/inventory/sessions/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Сессия инвентаризации не найдена' });
    return;
  }

  const status = req.body?.status === 'closed' ? 'closed' : 'open';
  db.prepare('UPDATE inventory_sessions SET status = ?, completedAt = ? WHERE id = ?').run(
    status,
    status === 'closed' ? nowIso() : '',
    req.params.id
  );
  res.json(toInventorySession(db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id)));
});

app.get('/api/inventory/sessions/:id/checks', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM inventory_checks WHERE sessionId = ? ORDER BY checkedAt DESC').all(req.params.id);
  res.json(rows.map(toInventoryCheck));
});

app.post('/api/inventory/sessions/:id/checks', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.body?.itemId);
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
  if (!session || !item) {
    res.status(404).json({ error: 'Сессия или позиция не найдена' });
    return;
  }

  const current = toItem(item);
  const actualQuantity = Math.max(0, normalizeNumber(req.body?.actualQuantity, current.quantity));
  const timestamp = nowIso();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO inventory_checks (id, sessionId, itemId, itemName, expectedQuantity, actualQuantity, note, checkedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.params.id,
      current.id,
      current.name,
      current.quantity,
      actualQuantity,
      normalizeText(req.body?.note),
      timestamp
    );

    if (actualQuantity !== current.quantity) {
      setItemTotalQuantity(current, actualQuantity, timestamp);
      recordHistory({ ...current, quantity: actualQuantity }, actualQuantity - current.quantity, 'inventory');
    }
  });

  const rows = db.prepare('SELECT * FROM inventory_checks WHERE sessionId = ? ORDER BY checkedAt DESC').all(req.params.id);
  res.status(201).json(rows.map(toInventoryCheck));
});

app.post('/api/items', requireAuth, (req, res) => {
  try {
    const item = validateItem(req.body);
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const saved = withTransaction(db, () => {
      db.prepare(`
        INSERT INTO items (
          id, name, category, quantity, unit, location, locations, barcode, project, tags,
          containerId, photo, minQuantity, note, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        item.name,
        item.category,
        item.quantity,
        item.unit,
        item.locations[0] || item.location,
        JSON.stringify(item.locations),
        item.barcode,
        item.project,
        JSON.stringify(item.tags),
        item.containerId,
        item.photo,
        item.minQuantity,
        item.note,
        timestamp,
        timestamp
      );

      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      const baseItem = toItem(row);
      setItemTotalQuantity(baseItem, baseItem.quantity, timestamp);
      const created = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
      if (created.quantity > 0) recordHistory(created, created.quantity, 'create');
      return created;
    });
    res.status(201).json(saved);
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
    const previous = toItem(existing);
    const update = { ...previous, ...validateItem(req.body, true), updatedAt: nowIso() };
    const saved = withTransaction(db, () => {
      db.prepare(`
        UPDATE items
        SET name = ?, category = ?, quantity = ?, unit = ?, location = ?, locations = ?, barcode = ?, project = ?,
          tags = ?, containerId = ?, photo = ?, minQuantity = ?, note = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        update.name,
        update.category,
        update.quantity,
        update.unit,
        update.locations[0] || update.location,
        JSON.stringify(update.locations),
        update.barcode,
        update.project,
        JSON.stringify(update.tags),
        update.containerId,
        update.photo,
        update.minQuantity,
        update.note,
        update.updatedAt,
        req.params.id
      );

      setItemTotalQuantity(previous, update.quantity, update.updatedAt);
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
      const updated = toItemWithBalances(row);
      const delta = updated.quantity - previous.quantity;
      if (delta !== 0) recordHistory(updated, delta, 'edit');
      return updated;
    });
    res.json(saved);
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

  const saved = withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!existing) return null;

    const current = toItem(existing);
    const quantity = Math.max(0, current.quantity + amount);
    setItemTotalQuantity(current, quantity);
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    const updated = toItemWithBalances(row);
    const actualDelta = quantity - existing.quantity;
    if (actualDelta !== 0) recordHistory(updated, actualDelta, actualDelta > 0 ? 'add' : 'subtract');
    return updated;
  });

  if (!saved) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }
  res.json(saved);
});

app.get('/api/items/:id/movements', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stock_movements WHERE itemId = ? ORDER BY createdAt DESC').all(req.params.id);
  res.json(rows);
});

app.post('/api/items/:id/balances', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }

  const item = toItem(row);
  const containerId = normalizeText(req.body?.containerId);
  const container = containerId ? db.prepare('SELECT * FROM containers WHERE id = ?').get(containerId) : null;
  if (containerId && !container) {
    res.status(400).json({ error: 'Контейнер не найден' });
    return;
  }

  const location = normalizeText(req.body?.location) || container?.location || '';
  const quantity = Math.max(0, normalizeNumber(req.body?.quantity));
  const timestamp = nowIso();

  try {
    const saved = withTransaction(db, () => {
      const balanceId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO stock_balances (id, itemId, containerId, location, quantity, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(balanceId, item.id, containerId, location, quantity, timestamp, timestamp);
      const total = syncItemQuantity(item.id, timestamp);
      const updated = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
      if (quantity > 0) {
        recordHistory({ ...updated, quantity: total }, quantity, 'add');
        recordStockMovement(item, '', balanceId, quantity, 'receive');
      }
      return updated;
    });
    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ error: String(error.message || error).includes('UNIQUE') ? 'Такое место уже добавлено' : error.message });
  }
});

app.patch('/api/items/:id/balances/:balanceId', requireAuth, (req, res) => {
  const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  const balanceRow = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(req.params.balanceId, req.params.id);
  if (!itemRow || !balanceRow) {
    res.status(404).json({ error: 'Позиция или место остатка не найдено' });
    return;
  }

  const item = toItem(itemRow);
  const balance = toStockBalance(balanceRow);
  const containerId = req.body?.containerId === undefined ? balance.containerId : normalizeText(req.body.containerId);
  const container = containerId ? db.prepare('SELECT * FROM containers WHERE id = ?').get(containerId) : null;
  if (containerId && !container) {
    res.status(400).json({ error: 'Контейнер не найден' });
    return;
  }

  const location = req.body?.location === undefined ? balance.location : normalizeText(req.body.location) || container?.location || '';
  const quantity = req.body?.quantity === undefined ? balance.quantity : Math.max(0, normalizeNumber(req.body.quantity, balance.quantity));
  const timestamp = nowIso();

  try {
    const saved = withTransaction(db, () => {
      db.prepare('UPDATE stock_balances SET containerId = ?, location = ?, quantity = ?, updatedAt = ? WHERE id = ?').run(
        containerId,
        location,
        quantity,
        timestamp,
        balance.id
      );
      const total = syncItemQuantity(item.id, timestamp);
      const delta = quantity - balance.quantity;
      const updated = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
      if (delta !== 0) {
        recordHistory({ ...updated, quantity: total }, delta, delta > 0 ? 'add' : 'subtract');
        recordStockMovement(item, delta < 0 ? balance.id : '', delta > 0 ? balance.id : '', Math.abs(delta), 'adjust');
      }
      return updated;
    });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: String(error.message || error).includes('UNIQUE') ? 'Такое место уже добавлено' : error.message });
  }
});

app.post('/api/items/:id/transfer', requireAuth, (req, res) => {
  const amount = normalizeNumber(req.body?.amount, Number.NaN);
  const fromBalanceId = normalizeText(req.body?.fromBalanceId);
  const toBalanceId = normalizeText(req.body?.toBalanceId);
  if (!Number.isFinite(amount) || amount <= 0 || !fromBalanceId || !toBalanceId || fromBalanceId === toBalanceId) {
    res.status(400).json({ error: 'Некорректное перемещение' });
    return;
  }

  const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  const fromRow = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(fromBalanceId, req.params.id);
  const toRow = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(toBalanceId, req.params.id);
  if (!itemRow || !fromRow || !toRow) {
    res.status(404).json({ error: 'Позиция или место остатка не найдено' });
    return;
  }
  if (fromRow.quantity < amount) {
    res.status(400).json({ error: 'Недостаточно остатка для перемещения' });
    return;
  }

  const item = toItem(itemRow);
  const timestamp = nowIso();
  const saved = withTransaction(db, () => {
    db.prepare('UPDATE stock_balances SET quantity = quantity - ?, updatedAt = ? WHERE id = ?').run(amount, timestamp, fromBalanceId);
    db.prepare('UPDATE stock_balances SET quantity = quantity + ?, updatedAt = ? WHERE id = ?').run(amount, timestamp, toBalanceId);
    recordStockMovement(item, fromBalanceId, toBalanceId, amount, 'transfer');
    return toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
  });
  res.json(saved);
});

app.delete('/api/items/:id/balances/:balanceId', requireAuth, (req, res) => {
  const balance = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(req.params.balanceId, req.params.id);
  if (!balance) {
    res.status(404).json({ error: 'Место остатка не найдено' });
    return;
  }
  if (balance.quantity > 0) {
    res.status(400).json({ error: 'Сначала переместите или спишите остаток' });
    return;
  }
  db.prepare('DELETE FROM stock_balances WHERE id = ?').run(balance.id);
  res.status(204).end();
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

if (httpsPort && httpsKeyPath && httpsCertPath && fs.existsSync(httpsKeyPath) && fs.existsSync(httpsCertPath)) {
  https
    .createServer(
      {
        key: fs.readFileSync(httpsKeyPath),
        cert: fs.readFileSync(httpsCertPath)
      },
      app
    )
    .listen(httpsPort, '0.0.0.0', () => {
      console.log(`Garage inventory HTTPS is running on https://0.0.0.0:${httpsPort}`);
    });
}
