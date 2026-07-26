// @ts-check
import crypto from 'node:crypto';
import express from 'express';

const cookieName = 'garage_session';
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;
const attemptWindowMs = 1000 * 60 * 15;
const maxAttempts = 6;

function cookieValue(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function sameSecret(received, expected) {
  const receivedBuffer = Buffer.from(String(received || ''));
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function createAuth({ password, secureCookies }) {
  const sessions = new Map();
  const attempts = new Map();
  const router = express.Router();

  function requireAuth(req, res, next) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const token = cookieValue(req, cookieName) || bearer;
    const expiresAt = sessions.get(token);

    if (!token || !expiresAt || expiresAt < Date.now()) {
      sessions.delete(token);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    sessions.set(token, Date.now() + sessionTtlMs);
    next();
  }

  router.post('/login', (req, res) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((timestamp) => now - timestamp < attemptWindowMs);

    if (recent.length >= maxAttempts) {
      res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
      return;
    }

    if (!sameSecret(req.body?.password, password)) {
      attempts.set(key, [...recent, now]);
      res.status(401).json({ error: 'Неверный пароль' });
      return;
    }

    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now + sessionTtlMs);
    res.cookie(cookieName, token, {
      httpOnly: true,
      maxAge: sessionTtlMs,
      path: '/',
      sameSite: 'strict',
      secure: secureCookies
    });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/logout', requireAuth, (req, res) => {
    const token = cookieValue(req, cookieName);
    sessions.delete(token);
    res.clearCookie(cookieName, { path: '/', sameSite: 'strict', secure: secureCookies });
    res.status(204).end();
  });

  return { requireAuth, router };
}
