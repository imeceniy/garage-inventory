// @ts-check

function grouped(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = result.get(row[key]) || [];
    value.push(row);
    result.set(row[key], value);
  }
  return result;
}

export function createItemRepository(db) {
  return {
    activeRows() {
      return db.prepare(`
        SELECT * FROM items
        WHERE deletedAt = ''
        ORDER BY name COLLATE NOCASE, createdAt
      `).all();
    },

    findActive(id) {
      return db.prepare("SELECT * FROM items WHERE id = ? AND deletedAt = ''").get(id);
    },

    findAny(id) {
      return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    },

    query(filters) {
      const conditions = ["items.deletedAt = ''"];
      const values = [];
      if (filters.q) {
        const pattern = `%${filters.q.toLowerCase()}%`;
        conditions.push(`(
          lower(items.name) LIKE ?
          OR lower(items.barcode) LIKE ?
          OR lower(items.note) LIKE ?
          OR EXISTS (
            SELECT 1 FROM item_tags JOIN tags ON tags.id = item_tags.tagId
            WHERE item_tags.itemId = items.id AND lower(tags.name) LIKE ?
          )
          OR EXISTS (
            SELECT 1 FROM item_projects JOIN projects ON projects.id = item_projects.projectId
            WHERE item_projects.itemId = items.id AND lower(projects.name) LIKE ?
          )
        )`);
        values.push(pattern, pattern, pattern, pattern, pattern);
      }
      if (filters.category) {
        conditions.push('items.category = ?');
        values.push(filters.category);
      }
      if (filters.project) {
        conditions.push(`EXISTS (
          SELECT 1 FROM item_projects JOIN projects ON projects.id = item_projects.projectId
          WHERE item_projects.itemId = items.id AND projects.name = ? COLLATE NOCASE
        )`);
        values.push(filters.project);
      }
      if (filters.tag) {
        conditions.push(`EXISTS (
          SELECT 1 FROM item_tags JOIN tags ON tags.id = item_tags.tagId
          WHERE item_tags.itemId = items.id AND tags.name = ? COLLATE NOCASE
        )`);
        values.push(filters.tag);
      }
      if (filters.location) {
        conditions.push(`EXISTS (
          SELECT 1 FROM stock_balances
          WHERE stock_balances.itemId = items.id AND stock_balances.location = ? COLLATE NOCASE
        )`);
        values.push(filters.location);
      }
      if (filters.containerId) {
        conditions.push(`EXISTS (
          SELECT 1 FROM stock_balances
          WHERE stock_balances.itemId = items.id AND stock_balances.containerId = ?
        )`);
        values.push(filters.containerId);
      }
      if (filters.low) {
        conditions.push('items.quantity <= items.reorderPoint AND items.quantity < items.targetQuantity');
      }
      if (filters.cursor?.name && filters.cursor?.id) {
        conditions.push('(lower(items.name) > ? OR (lower(items.name) = ? AND items.id > ?))');
        values.push(filters.cursor.name, filters.cursor.name, filters.cursor.id);
      }

      const rows = db.prepare(`
        SELECT items.*
        FROM items
        WHERE ${conditions.join(' AND ')}
        ORDER BY lower(items.name), items.id
        LIMIT ?
      `).all(...values, filters.limit + 1);
      return {
        hasMore: rows.length > filters.limit,
        rows: rows.slice(0, filters.limit)
      };
    },

    relations(itemIds) {
      if (!itemIds.length) {
        return { balances: new Map(), projects: new Map(), tags: new Map() };
      }
      const placeholders = itemIds.map(() => '?').join(',');
      const balances = db.prepare(`
        SELECT * FROM stock_balances
        WHERE itemId IN (${placeholders})
        ORDER BY createdAt, id
      `).all(...itemIds);
      const projects = db.prepare(`
        SELECT item_projects.itemId, projects.id, projects.name
        FROM item_projects
        JOIN projects ON projects.id = item_projects.projectId
        WHERE item_projects.itemId IN (${placeholders})
        ORDER BY projects.name COLLATE NOCASE
      `).all(...itemIds);
      const tags = db.prepare(`
        SELECT item_tags.itemId, tags.id, tags.name
        FROM item_tags
        JOIN tags ON tags.id = item_tags.tagId
        WHERE item_tags.itemId IN (${placeholders})
        ORDER BY tags.name COLLATE NOCASE
      `).all(...itemIds);
      return {
        balances: grouped(balances, 'itemId'),
        projects: grouped(projects, 'itemId'),
        tags: grouped(tags, 'itemId')
      };
    }
  };
}
