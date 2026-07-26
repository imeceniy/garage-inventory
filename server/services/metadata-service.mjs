// @ts-check
import crypto from 'node:crypto';

export function createMetadataService(db, nowIso) {
  function ensure(table, name, timestamp = nowIso()) {
    const normalized = String(name || '').trim().replace(/^#+/, '');
    if (!normalized) return '';
    const existing = db.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).get(normalized);
    if (existing) return String(existing.id);
    const id = crypto.randomUUID();
    if (table === 'projects') {
      db.prepare('INSERT INTO projects (id, name, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
        id, normalized, '', timestamp, timestamp
      );
    } else if (table === 'locations') {
      db.prepare('INSERT INTO locations (id, name, parentId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
        id, normalized, '', timestamp, timestamp
      );
    } else if (table === 'tags') {
      db.prepare('INSERT INTO tags (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)').run(
        id, normalized, timestamp, timestamp
      );
    } else {
      throw new Error('Unknown metadata table');
    }
    return id;
  }

  function syncItem(itemId, projects, tags, locations, timestamp = nowIso()) {
    db.prepare('DELETE FROM item_projects WHERE itemId = ?').run(itemId);
    db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(itemId);
    const linkProject = db.prepare('INSERT OR IGNORE INTO item_projects (itemId, projectId) VALUES (?, ?)');
    const linkTag = db.prepare('INSERT OR IGNORE INTO item_tags (itemId, tagId) VALUES (?, ?)');
    for (const name of projects) linkProject.run(itemId, ensure('projects', name, timestamp));
    for (const name of tags) linkTag.run(itemId, ensure('tags', name, timestamp));
    for (const name of locations) ensure('locations', name, timestamp);
  }

  return { ensure, syncItem };
}
