import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-api-'));
let agent;
let db;

beforeAll(async () => {
  process.env.GARAGE_PASSWORD = 'integration-test-password';
  process.env.GARAGE_RUNTIME_ROOT = rootDir;
  process.env.GARAGE_NO_LISTEN = 'true';
  process.env.GARAGE_SECURE_COOKIES = 'false';
  process.env.BACKUP_ON_START = 'false';
  const server = await import('./index.mjs');
  db = server.db;
  agent = supertest.agent(server.app);
  await agent.post('/api/auth/login').send({ password: 'integration-test-password' }).expect(200);
}, 30_000);

afterAll(() => {
  db?.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
  delete process.env.GARAGE_RUNTIME_ROOT;
  delete process.env.GARAGE_NO_LISTEN;
  delete process.env.GARAGE_SECURE_COOKIES;
});

describe('inventory API', () => {
  let item;

  it('creates normalized metadata and an initial balance', async () => {
    const response = await agent.post('/api/items').send({
      name: 'Кабель USB-C',
      category: 'Электрика',
      quantity: 4,
      unit: 'шт',
      projects: ['Электрика', '3D-принтер'],
      tags: ['кабель', 'usb'],
      locations: ['Стеллаж 1'],
      reorderPoint: 2,
      targetQuantity: 8
    }).expect(201);

    item = response.body;
    expect(item.quantity).toBe(4);
    expect(item.projects).toEqual(['3D-принтер', 'Электрика']);
    expect(item.balances).toHaveLength(1);
    expect(item.defaultBalanceId).toBe(item.balances[0].id);

    const meta = await agent.get('/api/meta').expect(200);
    expect(meta.body.projects).toContain('Электрика');
    expect(meta.body.tags).toContain('usb');
    expect(meta.body.locations).toContain('Стеллаж 1');
  });

  it('adjusts only the selected default balance', async () => {
    const second = await agent.post(`/api/items/${item.id}/balances`).send({
      location: 'Верстак',
      quantity: 3
    }).expect(201);
    const secondBalance = second.body.balances.find((balance) => balance.location === 'Верстак');

    await agent.post(`/api/items/${item.id}/default-balance`).send({ balanceId: secondBalance.id }).expect(200);
    const adjusted = await agent.post(`/api/items/${item.id}/adjust`).send({ amount: -1 }).expect(200);
    expect(adjusted.body.quantity).toBe(6);
    expect(adjusted.body.balances.find((balance) => balance.id === secondBalance.id).quantity).toBe(2);
    item = adjusted.body;
  });

  it('supports server-side filtering with a cursor-ready response', async () => {
    const response = await agent.get('/api/items/query?q=кабель&project=Электрика&limit=1').expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(item.id);
    expect(response.body).toHaveProperty('nextCursor');
  });

  it('rejects duplicate active barcodes', async () => {
    const first = await agent.patch(`/api/items/${item.id}`).send({ barcode: '460000000001' }).expect(200);
    item = first.body;
    const duplicate = await agent.post('/api/items').send({
      name: 'Дубликат',
      category: 'Прочее',
      barcode: '460000000001'
    }).expect(400);
    expect(duplicate.body.error).toContain('уже используется');
  });

  it('restores a soft-deleted item with the same identity and balances', async () => {
    const balances = item.balances.map((balance) => balance.id);
    await agent.delete(`/api/items/${item.id}`).expect(204);
    const hidden = await agent.get('/api/items').expect(200);
    expect(hidden.body.some((entry) => entry.id === item.id)).toBe(false);

    const restored = await agent.post(`/api/items/${item.id}/restore`).expect(200);
    expect(restored.body.id).toBe(item.id);
    expect(restored.body.balances.map((balance) => balance.id)).toEqual(balances);
    item = restored.body;
  });

  it('stages inventory differences and applies them only when closing', async () => {
    const session = await agent.post('/api/inventory/sessions').send({ name: 'Тестовая проверка' }).expect(201);
    const balance = item.balances[0];
    await agent.post(`/api/inventory/sessions/${session.body.id}/checks`).send({
      itemId: item.id,
      balanceId: balance.id,
      actualQuantity: 1
    }).expect(201);

    const beforeClose = await agent.get('/api/items').expect(200);
    expect(beforeClose.body.find((entry) => entry.id === item.id).balances.find((entry) => entry.id === balance.id).quantity)
      .toBe(balance.quantity);

    await agent.patch(`/api/inventory/sessions/${session.body.id}`).send({ status: 'closed', apply: true }).expect(200);
    const afterClose = await agent.get('/api/items').expect(200);
    expect(afterClose.body.find((entry) => entry.id === item.id).balances.find((entry) => entry.id === balance.id).quantity)
      .toBe(1);

    await agent.post(`/api/inventory/sessions/${session.body.id}/checks`).send({
      itemId: item.id,
      balanceId: balance.id,
      actualQuantity: 2
    }).expect(409);
  });

  it('returns cursor-ready operation history', async () => {
    const response = await agent.get('/api/history?limit=2').expect(200);
    expect(Array.isArray(response.body.entries)).toBe(true);
    expect(response.body.entries.length).toBeLessThanOrEqual(2);
    expect(response.body).toHaveProperty('nextCursor');
  });
});
