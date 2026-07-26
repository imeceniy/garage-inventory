import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './routes/auth-routes.mjs';
import { openDatabase, withTransaction } from './database.mjs';
import { runIntegrityCheck, scheduleMaintenance } from './maintenance.mjs';
import { createMedia, migrateInlinePhotos } from './routes/media-routes.mjs';
import { createItemRepository } from './repositories/item-repository.mjs';
import { createMetadataService } from './services/metadata-service.mjs';
import { balanceInputSchema, itemInputSchema, itemPatchSchema, parse, transferInputSchema } from './validation.mjs';

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
const runtimeRoot = process.env.GARAGE_RUNTIME_ROOT
  ? path.resolve(process.env.GARAGE_RUNTIME_ROOT)
  : rootDir;

if (!password) {
  console.error('GARAGE_PASSWORD is required');
  process.exit(1);
}

const { db, backupDir } = openDatabase(runtimeRoot, { backupOnStart, backupRetention });
migrateInlinePhotos(db, runtimeRoot);
runIntegrityCheck(db);
scheduleMaintenance({ db, backupDir, retention: backupRetention });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.set('trust proxy', 1);

const httpsEnabled = Boolean(
  httpsPort
  && httpsKeyPath
  && httpsCertPath
  && fs.existsSync(httpsKeyPath)
  && fs.existsSync(httpsCertPath)
);
const secureCookies = httpsEnabled;
const { requireAuth, router: authRouter } = createAuth({ password, secureCookies });
const { router: mediaRouter, staticMiddleware: uploadsStatic } = createMedia({ rootDir: runtimeRoot, requireAuth });
const itemRepository = createItemRepository(db);

app.use('/api/auth', authRouter);
app.use('/api/uploads', mediaRouter);
app.use('/uploads/items', requireAuth, uploadsStatic);

// Normalize API output so SQLite rows do not leak database-specific shape.
function nowIso() {
  return new Date().toISOString();
}

const metadataService = createMetadataService(db, nowIso);

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
  const reorderPoint = Math.max(0, normalizeNumber(row.reorderPoint, row.minQuantity));
  const targetQuantity = Math.max(reorderPoint, normalizeNumber(row.targetQuantity, reorderPoint));
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
    minQuantity: reorderPoint,
    reorderPoint,
    targetQuantity,
    defaultBalanceId: row.defaultBalanceId || '',
    deletedAt: row.deletedAt || '',
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

function hydrateItem(row, relations = null) {
  const item = toItem(row);
  const balances = (relations?.balances?.get(item.id) || stockBalances(item.id)).map(toStockBalance);
  const primary = balances.find((balance) => balance.id === item.defaultBalanceId) || balances[0];
  const locations = Array.from(new Set(balances.map((balance) => balance.location).filter(Boolean)));
  const projects = relations?.projects?.get(item.id)?.map((entry) => entry.name)
    || db.prepare(`
      SELECT projects.name
      FROM item_projects
      JOIN projects ON projects.id = item_projects.projectId
      WHERE item_projects.itemId = ?
      ORDER BY projects.name COLLATE NOCASE
    `).all(item.id).map((entry) => entry.name);
  const tags = relations?.tags?.get(item.id)?.map((entry) => entry.name)
    || db.prepare(`
      SELECT tags.name
      FROM item_tags
      JOIN tags ON tags.id = item_tags.tagId
      WHERE item_tags.itemId = ?
      ORDER BY tags.name COLLATE NOCASE
    `).all(item.id).map((entry) => entry.name);
  const quantity = balances.reduce((sum, balance) => sum + balance.quantity, 0);
  return {
    ...item,
    quantity,
    location: primary?.location || locations[0] || '',
    locations,
    containerId: primary?.containerId || '',
    project: projects[0] || '',
    projects,
    tags,
    balances
  };
}

function toItemWithBalances(row) {
  return hydrateItem(row);
}

function hydrateItems(rows) {
  const relations = itemRepository.relations(rows.map((row) => row.id));
  return rows.map((row) => hydrateItem(row, relations));
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

function adjustBalanceQuantity(item, requestedAmount, requestedBalanceId = '', action = '') {
  const timestamp = nowIso();
  let balances = stockBalances(item.id);
  let balance = balances.find((entry) => entry.id === requestedBalanceId);
  if (!balance) {
    balance = balances.find((entry) => entry.id === item.defaultBalanceId);
  }
  if (!balance && requestedAmount < 0) {
    balance = [...balances].sort((a, b) => b.quantity - a.quantity)[0];
  }
  if (!balance) balance = balances[0];

  if (!balance) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO stock_balances (id, itemId, containerId, location, quantity, createdAt, updatedAt)
      VALUES (?, ?, '', '', 0, ?, ?)
    `).run(id, item.id, timestamp, timestamp);
    db.prepare('UPDATE items SET defaultBalanceId = ? WHERE id = ?').run(id, item.id);
    balance = toStockBalance(db.prepare('SELECT * FROM stock_balances WHERE id = ?').get(id));
    balances = [balance];
  }

  const actualAmount = requestedAmount < 0
    ? -Math.min(balance.quantity, Math.abs(requestedAmount))
    : requestedAmount;
  if (actualAmount === 0) return toItemWithBalances(itemRepository.findActive(item.id));

  db.prepare('UPDATE stock_balances SET quantity = quantity + ?, updatedAt = ? WHERE id = ?').run(
    actualAmount,
    timestamp,
    balance.id
  );
  const total = syncItemQuantity(item.id, timestamp);
  const updated = toItemWithBalances(itemRepository.findActive(item.id));
  recordHistory(
    { ...updated, quantity: total },
    actualAmount,
    action || (actualAmount > 0 ? 'add' : 'subtract'),
    actualAmount < 0 ? balance.id : '',
    actualAmount > 0 ? balance.id : ''
  );
  return updated;
}

function recordStockMovement(item, fromBalanceId, toBalanceId, amount, action, quantityBefore = item.quantity, note = '') {
  db.prepare(`
    INSERT INTO stock_movements (id, itemId, itemName, fromBalanceId, toBalanceId, amount, action, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), item.id, item.name, fromBalanceId || '', toBalanceId || '', amount, action, nowIso());
  if (action === 'transfer') {
    db.prepare(`
      INSERT INTO stock_operations (
        id, itemId, itemName, type, amount, quantityBefore, quantityAfter,
        fromBalanceId, toBalanceId, note, createdAt
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      item.id,
      item.name,
      action,
      quantityBefore,
      quantityBefore,
      fromBalanceId || '',
      toBalanceId || '',
      note || `Перемещено ${amount}`,
      nowIso()
    );
  }
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
    balanceId: row.balanceId || '',
    expectedQuantity: row.expectedQuantity,
    actualQuantity: row.actualQuantity,
    note: row.note,
    checkedAt: row.checkedAt,
    appliedAt: row.appliedAt || ''
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

function toOperation(row) {
  return {
    ...row,
    action: row.type,
    quantityAfter: row.quantityAfter
  };
}

function recordHistory(item, amount, action, fromBalanceId = '', toBalanceId = '', note = '') {
  db.prepare(`
    INSERT INTO history (id, itemId, itemName, amount, quantityAfter, action, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), item.id, item.name, amount, item.quantity, action, nowIso());
  db.prepare(`
    INSERT INTO stock_operations (
      id, itemId, itemName, type, amount, quantityBefore, quantityAfter,
    fromBalanceId, toBalanceId, note, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    item.id,
    item.name,
    action,
    amount,
    item.quantity - amount,
    item.quantity,
    fromBalanceId,
    toBalanceId,
    note,
    nowIso()
  );
}

function replaceLocation(list, from, to) {
  const normalizedFrom = normalizeText(from);
  const normalizedTo = normalizeText(to);
  return list
    .map((entry) => (entry === normalizedFrom ? normalizedTo : entry))
    .filter(Boolean);
}

// Use one validator for create and partial update requests.
function validateItem(payload, partial = false) {
  const parsed = parse(partial ? itemPatchSchema : itemInputSchema, payload);
  const item = { ...parsed };

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

  if (!partial || payload.projects !== undefined || payload.project !== undefined) {
    item.projects = normalizeList(payload.projects ?? (payload.project ? [payload.project] : []));
  }

  if (!partial || payload.tags !== undefined) {
    item.tags = normalizeList(payload.tags);
  }

  if (!partial || payload.containerId !== undefined) {
    item.containerId = normalizeText(payload.containerId);
  }

  if (!partial || payload.photo !== undefined) {
    const photo = normalizeText(payload.photo);
    item.photo = photo.startsWith('/uploads/items/') || photo.startsWith('data:image/') ? photo : '';
  }

  if (!partial || payload.minQuantity !== undefined) {
    item.minQuantity = Math.max(0, normalizeNumber(payload.minQuantity));
  }

  if (!partial || payload.reorderPoint !== undefined || payload.minQuantity !== undefined) {
    item.reorderPoint = Math.max(0, normalizeNumber(payload.reorderPoint, item.minQuantity || 0));
  }

  if (!partial || payload.targetQuantity !== undefined || payload.reorderPoint !== undefined || payload.minQuantity !== undefined) {
    item.targetQuantity = Math.max(
      item.reorderPoint || 0,
      normalizeNumber(payload.targetQuantity, item.reorderPoint || item.minQuantity || 0)
    );
  }

  if (!partial || payload.note !== undefined) {
    item.note = normalizeText(payload.note);
  }

  return item;
}

// Inventory CRUD endpoints.
app.get('/api/items/query', requireAuth, (req, res) => {
  const limit = Math.min(100, Math.max(1, normalizeNumber(req.query.limit, 40)));
  let cursor = null;
  try {
    cursor = req.query.cursor
      ? JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'))
      : null;
  } catch {
    res.status(400).json({ error: 'Некорректный курсор' });
    return;
  }
  const result = itemRepository.query({
    q: normalizeText(req.query.q),
    category: normalizeText(req.query.category),
    project: normalizeText(req.query.project),
    tag: normalizeText(req.query.tag),
    location: normalizeText(req.query.location),
    containerId: normalizeText(req.query.containerId),
    low: req.query.low === 'true',
    cursor,
    limit
  });
  const items = hydrateItems(result.rows);
  const last = result.rows[result.rows.length - 1];
  res.json({
    items,
    nextCursor: result.hasMore && last
      ? Buffer.from(JSON.stringify({ name: String(last.name).toLowerCase(), id: String(last.id) })).toString('base64url')
      : ''
  });
});

app.get('/api/items', requireAuth, (_req, res) => {
  res.json(hydrateItems(itemRepository.activeRows()));
});

app.get('/api/history', requireAuth, (_req, res) => {
  const limit = Math.min(200, Math.max(1, normalizeNumber(_req.query.limit, 50)));
  const before = normalizeText(_req.query.before);
  const rows = before
    ? db.prepare('SELECT * FROM stock_operations WHERE createdAt < ? ORDER BY createdAt DESC LIMIT ?').all(before, limit)
    : db.prepare('SELECT * FROM stock_operations ORDER BY createdAt DESC LIMIT ?').all(limit);
  res.json({
    entries: rows.map(toOperation),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : ''
  });
});

app.get('/api/items/:id/history', requireAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, normalizeNumber(req.query.limit, 50)));
  const before = normalizeText(req.query.before);
  const rows = before
    ? db.prepare(`
      SELECT * FROM stock_operations
      WHERE itemId = ? AND createdAt < ?
      ORDER BY createdAt DESC LIMIT ?
    `).all(req.params.id, before, limit)
    : db.prepare(`
      SELECT * FROM stock_operations
      WHERE itemId = ?
      ORDER BY createdAt DESC LIMIT ?
    `).all(req.params.id, limit);
  res.json({
    entries: rows.map(toOperation),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : ''
  });
});

app.get('/api/meta', requireAuth, (_req, res) => {
  res.json({
    locations: db.prepare('SELECT name FROM locations ORDER BY name COLLATE NOCASE').all().map((entry) => entry.name),
    projects: db.prepare('SELECT name FROM projects ORDER BY name COLLATE NOCASE').all().map((entry) => entry.name),
    tags: db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map((entry) => entry.name)
  });
});

app.post('/api/meta', requireAuth, (req, res, next) => {
  try {
    const type = normalizeText(req.body?.type);
    const name = normalizeText(req.body?.name);
    const table = type === 'location' ? 'locations' : type === 'project' ? 'projects' : type === 'tag' ? 'tags' : '';
    if (!table || !name) {
      res.status(400).json({ error: 'Укажите тип и название' });
      return;
    }
    const id = metadataService.ensure(table, name);
    res.status(201).json({ id, name });
  } catch (error) {
    next(error);
  }
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
    const table = type === 'location' ? 'locations' : type === 'project' ? 'projects' : 'tags';
    const source = db.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).get(from);
    const target = db.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).get(to);
    if (source && target && source.id !== target.id && type === 'project') {
      db.prepare(`
        INSERT OR IGNORE INTO item_projects (itemId, projectId)
        SELECT itemId, ? FROM item_projects WHERE projectId = ?
      `).run(target.id, source.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(source.id);
    } else if (source && target && source.id !== target.id && type === 'tag') {
      db.prepare(`
        INSERT OR IGNORE INTO item_tags (itemId, tagId)
        SELECT itemId, ? FROM item_tags WHERE tagId = ?
      `).run(target.id, source.id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(source.id);
    } else if (source && target && source.id !== target.id && type === 'location') {
      db.prepare('DELETE FROM locations WHERE id = ?').run(source.id);
    } else {
      db.prepare(`UPDATE ${table} SET name = ?, updatedAt = ? WHERE name = ? COLLATE NOCASE`).run(to, timestamp, from);
    }
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
    const table = type === 'location' ? 'locations' : type === 'project' ? 'projects' : 'tags';
    db.prepare(`DELETE FROM ${table} WHERE name = ? COLLATE NOCASE`).run(value);
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
  const timestamp = nowIso();
  withTransaction(db, () => {
    if (status === 'closed' && existing.status !== 'closed' && req.body?.apply !== false) {
      const checks = db.prepare(`
        SELECT * FROM inventory_checks
        WHERE sessionId = ? AND supersededAt = '' AND appliedAt = ''
        ORDER BY checkedAt
      `).all(req.params.id);
      for (const check of checks) {
        const itemRow = itemRepository.findActive(String(check.itemId));
        if (!itemRow) continue;
        const item = toItemWithBalances(itemRow);
        if (check.balanceId) {
          const balance = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(check.balanceId, item.id);
          if (!balance) continue;
          const actualQuantity = Number(check.actualQuantity);
          const delta = actualQuantity - Number(balance.quantity);
          db.prepare('UPDATE stock_balances SET quantity = ?, updatedAt = ? WHERE id = ?').run(
            actualQuantity,
            timestamp,
            balance.id
          );
          const total = syncItemQuantity(item.id, timestamp);
          if (delta !== 0) {
            recordHistory(
              { ...item, quantity: total },
              delta,
              'inventory',
              delta < 0 ? String(balance.id) : '',
              delta > 0 ? String(balance.id) : '',
              String(existing.name)
            );
          }
        } else {
          const actualQuantity = Number(check.actualQuantity);
          const delta = actualQuantity - item.quantity;
          setItemTotalQuantity(item, actualQuantity, timestamp);
          if (delta !== 0) recordHistory({ ...item, quantity: actualQuantity }, delta, 'inventory', '', '', String(existing.name));
        }
        db.prepare('UPDATE inventory_checks SET appliedAt = ? WHERE id = ?').run(timestamp, check.id);
      }
    }

    db.prepare('UPDATE inventory_sessions SET status = ?, completedAt = ? WHERE id = ?').run(
      status,
      status === 'closed' ? timestamp : '',
      req.params.id
    );
  });
  res.json(toInventorySession(db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id)));
});

app.get('/api/inventory/sessions/:id/checks', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM inventory_checks
    WHERE sessionId = ? AND supersededAt = ''
    ORDER BY checkedAt DESC
  `).all(req.params.id);
  res.json(rows.map(toInventoryCheck));
});

app.post('/api/inventory/sessions/:id/checks', requireAuth, (req, res) => {
  const item = itemRepository.findActive(req.body?.itemId);
  const session = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
  if (!session || !item) {
    res.status(404).json({ error: 'Сессия или позиция не найдена' });
    return;
  }
  if (session.status !== 'open') {
    res.status(409).json({ error: 'Закрытую инвентаризацию нельзя изменять' });
    return;
  }

  const current = toItemWithBalances(item);
  const balanceId = normalizeText(req.body?.balanceId);
  const balance = balanceId
    ? current.balances.find((entry) => entry.id === balanceId)
    : current.balances.find((entry) => entry.id === current.defaultBalanceId) || current.balances[0];
  if (balanceId && !balance) {
    res.status(404).json({ error: 'Место остатка не найдено' });
    return;
  }
  const expectedQuantity = balance ? balance.quantity : current.quantity;
  const actualQuantity = Math.max(0, normalizeNumber(req.body?.actualQuantity, expectedQuantity));
  const timestamp = nowIso();
  withTransaction(db, () => {
    db.prepare(`
      UPDATE inventory_checks
      SET supersededAt = ?
      WHERE sessionId = ? AND itemId = ? AND balanceId = ? AND supersededAt = ''
    `).run(timestamp, req.params.id, current.id, balance?.id || '');
    db.prepare(`
      INSERT INTO inventory_checks (
        id, sessionId, itemId, itemName, balanceId, expectedQuantity, actualQuantity,
        note, checkedAt, supersededAt, appliedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')
    `).run(
      crypto.randomUUID(),
      req.params.id,
      current.id,
      current.name,
      balance?.id || '',
      expectedQuantity,
      actualQuantity,
      normalizeText(req.body?.note),
      timestamp
    );
  });

  const rows = db.prepare(`
    SELECT * FROM inventory_checks
    WHERE sessionId = ? AND supersededAt = ''
    ORDER BY checkedAt DESC
  `).all(req.params.id);
  res.status(201).json(rows.map(toInventoryCheck));
});

app.post('/api/items', requireAuth, (req, res) => {
  try {
    const item = validateItem(req.body);
    const container = item.containerId
      ? db.prepare('SELECT * FROM containers WHERE id = ?').get(item.containerId)
      : null;
    if (item.containerId && !container) {
      res.status(400).json({ error: 'Контейнер не найден' });
      return;
    }
    const initialLocation = item.locations[0] || item.location || normalizeText(container?.location);
    const initialLocations = initialLocation
      ? Array.from(new Set([initialLocation, ...item.locations]))
      : item.locations;
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const saved = withTransaction(db, () => {
      db.prepare(`
        INSERT INTO items (
          id, name, category, quantity, unit, location, locations, barcode, project, tags,
          containerId, photo, minQuantity, reorderPoint, targetQuantity, note, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        item.name,
        item.category,
        item.quantity,
        item.unit,
        initialLocation,
        JSON.stringify(initialLocations),
        item.barcode,
        item.projects[0] || item.project,
        JSON.stringify(item.tags),
        item.containerId,
        item.photo,
        item.reorderPoint,
        item.reorderPoint,
        item.targetQuantity,
        item.note,
        timestamp,
        timestamp
      );

      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      const baseItem = toItem(row);
      setItemTotalQuantity(baseItem, baseItem.quantity, timestamp);
      db.prepare(`
        UPDATE items
        SET defaultBalanceId = COALESCE(
          (SELECT id FROM stock_balances WHERE itemId = ? ORDER BY quantity DESC, createdAt LIMIT 1),
          ''
        )
        WHERE id = ?
      `).run(id, id);
      metadataService.syncItem(id, item.projects, item.tags, initialLocations, timestamp);
      const created = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
      if (created.quantity > 0) recordHistory(created, created.quantity, 'create');
      return created;
    });
    res.status(201).json(saved);
  } catch (error) {
    const message = String(error.message || error);
    res.status(400).json({ error: /idx_items_unique_active_barcode|items\.barcode/.test(message) ? 'Этот штрихкод уже используется' : message });
  }
});

app.patch('/api/items/:id', requireAuth, (req, res) => {
  const existing = itemRepository.findActive(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }

  try {
    const previous = toItemWithBalances(existing);
    const candidate = validateItem(req.body, true);
    const update = {
      ...previous,
      ...candidate,
      quantity: previous.quantity,
      location: previous.location,
      locations: previous.locations,
      containerId: previous.containerId,
      projects: candidate.projects ?? previous.projects,
      updatedAt: nowIso()
    };
    const saved = withTransaction(db, () => {
      db.prepare(`
        UPDATE items
        SET name = ?, category = ?, quantity = ?, unit = ?, location = ?, locations = ?, barcode = ?, project = ?,
          tags = ?, containerId = ?, photo = ?, minQuantity = ?, reorderPoint = ?, targetQuantity = ?,
          note = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        update.name,
        update.category,
        update.quantity,
        update.unit,
        update.locations[0] || update.location,
        JSON.stringify(update.locations),
        update.barcode,
        update.projects[0] || '',
        JSON.stringify(update.tags),
        update.containerId,
        update.photo,
        update.reorderPoint,
        update.reorderPoint,
        update.targetQuantity,
        update.note,
        update.updatedAt,
        req.params.id
      );

      metadataService.syncItem(update.id, update.projects, update.tags, update.locations, update.updatedAt);
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
      const updated = toItemWithBalances(row);
      return updated;
    });
    res.json(saved);
  } catch (error) {
    const message = String(error.message || error);
    res.status(400).json({ error: /idx_items_unique_active_barcode|items\.barcode/.test(message) ? 'Этот штрихкод уже используется' : message });
  }
});

app.post('/api/items/:id/adjust', requireAuth, (req, res) => {
  const amount = normalizeNumber(req.body?.amount, Number.NaN);
  if (!Number.isFinite(amount)) {
    res.status(400).json({ error: 'Некорректное изменение количества' });
    return;
  }

  const saved = withTransaction(db, () => {
    const existing = itemRepository.findActive(req.params.id);
    if (!existing) return null;
    const item = toItemWithBalances(existing);
    if (req.body?.all === true && amount < 0) {
      const timestamp = nowIso();
      db.prepare('UPDATE stock_balances SET quantity = 0, updatedAt = ? WHERE itemId = ?').run(timestamp, item.id);
      syncItemQuantity(item.id, timestamp);
      const updated = toItemWithBalances(itemRepository.findActive(item.id));
      if (item.quantity > 0) recordHistory(updated, -item.quantity, 'subtract', '', '', 'Списаны остатки во всех местах');
      return updated;
    }
    return adjustBalanceQuantity(item, amount, normalizeText(req.body?.balanceId));
  });

  if (!saved) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }
  res.json(saved);
});

app.get('/api/items/:id/movements', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stock_operations WHERE itemId = ? ORDER BY createdAt DESC LIMIT 200').all(req.params.id);
  res.json(rows);
});

app.post('/api/items/:id/balances', requireAuth, (req, res) => {
  const row = itemRepository.findActive(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }

  const item = toItemWithBalances(row);
  const input = parse(balanceInputSchema, req.body);
  const containerId = input.containerId;
  const container = containerId ? db.prepare('SELECT * FROM containers WHERE id = ?').get(containerId) : null;
  if (containerId && !container) {
    res.status(400).json({ error: 'Контейнер не найден' });
    return;
  }

  const location = input.location || container?.location || '';
  const quantity = input.quantity;
  const timestamp = nowIso();

  try {
    const saved = withTransaction(db, () => {
      const balanceId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO stock_balances (id, itemId, containerId, location, quantity, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(balanceId, item.id, containerId, location, quantity, timestamp, timestamp);
      if (!item.defaultBalanceId) {
        db.prepare('UPDATE items SET defaultBalanceId = ? WHERE id = ?').run(balanceId, item.id);
      }
      if (location) metadataService.ensure('locations', location, timestamp);
      const total = syncItemQuantity(item.id, timestamp);
      const updated = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
      if (quantity > 0) {
        recordHistory({ ...updated, quantity: total }, quantity, 'add', '', balanceId);
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
  const itemRow = itemRepository.findActive(req.params.id);
  const balanceRow = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(req.params.balanceId, req.params.id);
  if (!itemRow || !balanceRow) {
    res.status(404).json({ error: 'Позиция или место остатка не найдено' });
    return;
  }

  const item = toItemWithBalances(itemRow);
  const balance = toStockBalance(balanceRow);
  const input = parse(balanceInputSchema.partial(), req.body);
  const containerId = input.containerId === undefined ? balance.containerId : input.containerId;
  const container = containerId ? db.prepare('SELECT * FROM containers WHERE id = ?').get(containerId) : null;
  if (containerId && !container) {
    res.status(400).json({ error: 'Контейнер не найден' });
    return;
  }

  const location = input.location === undefined ? balance.location : input.location || container?.location || '';
  const quantity = input.quantity === undefined ? balance.quantity : input.quantity;
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
      if (location) metadataService.ensure('locations', location, timestamp);
      const total = syncItemQuantity(item.id, timestamp);
      const delta = quantity - balance.quantity;
      const updated = toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
      if (delta !== 0) {
        recordHistory(
          { ...updated, quantity: total },
          delta,
          delta > 0 ? 'add' : 'subtract',
          delta < 0 ? balance.id : '',
          delta > 0 ? balance.id : ''
        );
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
  const { amount, fromBalanceId, toBalanceId } = parse(transferInputSchema, req.body);

  const itemRow = itemRepository.findActive(req.params.id);
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

  const item = toItemWithBalances(itemRow);
  const timestamp = nowIso();
  const saved = withTransaction(db, () => {
    db.prepare('UPDATE stock_balances SET quantity = quantity - ?, updatedAt = ? WHERE id = ?').run(amount, timestamp, fromBalanceId);
    db.prepare('UPDATE stock_balances SET quantity = quantity + ?, updatedAt = ? WHERE id = ?').run(amount, timestamp, toBalanceId);
    recordStockMovement(item, fromBalanceId, toBalanceId, amount, 'transfer', item.quantity);
    return toItemWithBalances(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
  });
  res.json(saved);
});

app.post('/api/items/:id/default-balance', requireAuth, (req, res) => {
  const balanceId = normalizeText(req.body?.balanceId);
  const balance = db.prepare('SELECT id FROM stock_balances WHERE id = ? AND itemId = ?').get(balanceId, req.params.id);
  if (!balance) {
    res.status(404).json({ error: 'Место остатка не найдено' });
    return;
  }
  db.prepare('UPDATE items SET defaultBalanceId = ?, updatedAt = ? WHERE id = ?').run(balanceId, nowIso(), req.params.id);
  res.json(toItemWithBalances(itemRepository.findActive(req.params.id)));
});

app.delete('/api/items/:id/balances/:balanceId', requireAuth, (req, res) => {
  const balance = db.prepare('SELECT * FROM stock_balances WHERE id = ? AND itemId = ?').get(req.params.balanceId, req.params.id);
  if (!balance) {
    res.status(404).json({ error: 'Место остатка не найдено' });
    return;
  }
  if (Number(balance.quantity) > 0) {
    res.status(400).json({ error: 'Сначала переместите или спишите остаток' });
    return;
  }
  db.prepare('DELETE FROM stock_balances WHERE id = ?').run(balance.id);
  db.prepare(`
    UPDATE items
    SET defaultBalanceId = COALESCE(
      (SELECT id FROM stock_balances WHERE itemId = items.id ORDER BY quantity DESC, createdAt LIMIT 1),
      ''
    )
    WHERE id = ? AND defaultBalanceId = ?
  `).run(req.params.id, balance.id);
  res.status(204).end();
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const result = db.prepare("UPDATE items SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt = ''").run(
    nowIso(),
    nowIso(),
    req.params.id
  );
  if (!result.changes) {
    res.status(404).json({ error: 'Позиция не найдена' });
    return;
  }
  res.status(204).end();
});

app.post('/api/items/:id/restore', requireAuth, (req, res) => {
  try {
    const result = db.prepare("UPDATE items SET deletedAt = '', updatedAt = ? WHERE id = ? AND deletedAt <> ''").run(
      nowIso(),
      req.params.id
    );
    if (!result.changes) {
      res.status(404).json({ error: 'Удаленная позиция не найдена' });
      return;
    }
    res.json(toItemWithBalances(itemRepository.findActive(req.params.id)));
  } catch (error) {
    const message = String(error.message || error);
    res.status(409).json({ error: message.includes('barcode') ? 'Штрихкод уже занят другой позицией' : message });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((error, _req, res, _next) => {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : error.message });
});

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // Let React handle deep links after static assets and API routes are checked.
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

export function startServers() {
if (httpsEnabled) {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const hostname = req.hostname.includes(':') ? `[${req.hostname}]` : req.hostname;
    res.redirect(308, `https://${hostname}:${httpsPort}${req.originalUrl}`);
  });
  redirectApp.listen(port, '0.0.0.0', () => {
    console.log(`Garage inventory redirects HTTP to HTTPS on port ${port}`);
  });

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
} else {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Garage inventory is running on http://0.0.0.0:${port}`);
  });
}
}

if (process.env.GARAGE_NO_LISTEN !== 'true') startServers();

export { app, db };
