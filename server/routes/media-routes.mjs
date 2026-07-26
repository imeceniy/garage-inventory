// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

function decodeImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error('Некорректное изображение'), { status: 400 });
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  return { bytes: Buffer.from(match[2], 'base64'), extension };
}

function writeImage(uploadDir, value, suffix, stem) {
  const image = decodeImage(value);
  if (image.bytes.length > 2_500_000) {
    throw Object.assign(new Error('Изображение слишком большое'), { status: 413 });
  }
  const name = `${stem}-${suffix}.${image.extension}`;
  fs.writeFileSync(path.join(uploadDir, name), image.bytes, { flag: 'wx' });
  return `/uploads/items/${name}`;
}

export function createMedia({ rootDir, requireAuth }) {
  const uploadDir = path.join(rootDir, 'data', 'uploads', 'items');
  fs.mkdirSync(uploadDir, { recursive: true });
  const router = express.Router();

  router.post('/photos', requireAuth, (req, res, next) => {
    try {
      const stem = `${Date.now()}-${crypto.randomUUID()}`;
      const photo = writeImage(uploadDir, req.body?.photo, 'original', stem);
      const thumbnail = req.body?.thumbnail
        ? writeImage(uploadDir, req.body.thumbnail, 'thumb', stem)
        : photo;
      res.status(201).json({ photo, thumbnail });
    } catch (error) {
      next(error);
    }
  });

  return {
    router,
    staticMiddleware: express.static(uploadDir, {
      fallthrough: false,
      immutable: true,
      maxAge: '30d'
    })
  };
}

export function migrateInlinePhotos(db, rootDir) {
  const uploadDir = path.join(rootDir, 'data', 'uploads', 'items');
  fs.mkdirSync(uploadDir, { recursive: true });
  const rows = db.prepare("SELECT id, photo FROM items WHERE photo LIKE 'data:image/%'").all();
  const update = db.prepare('UPDATE items SET photo = ? WHERE id = ?');

  for (const row of rows) {
    try {
      const stem = `legacy-${row.id}`;
      const photo = writeImage(uploadDir, row.photo, 'original', stem);
      update.run(photo, row.id);
    } catch {
      // Keep the original data URL if an old image cannot be decoded.
    }
  }
}
