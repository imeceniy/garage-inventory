import { describe, expect, it } from 'vitest';
import type { Item } from '../domain/types';
import { itemLocations, mergeDelimitedValues, parseDelimitedList, sortItems } from './inventory';

function item(overrides: Partial<Item>): Item {
  return {
    id: overrides.id || crypto.randomUUID(),
    name: 'Позиция',
    category: 'Прочее',
    quantity: 0,
    unit: 'шт',
    location: '',
    locations: [],
    barcode: '',
    project: '',
    tags: [],
    containerId: '',
    photo: '',
    minQuantity: 0,
    note: '',
    balances: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('inventory helpers', () => {
  it('splits pasted values and removes tag prefixes', () => {
    expect(parseDelimitedList('M4, #крепеж; нержавейка\nэлектрика')).toEqual(['M4', 'крепеж', 'нержавейка', 'электрика']);
  });

  it('merges values without duplicates', () => {
    expect(mergeDelimitedValues(['M4'], 'M4, сталь')).toEqual(['M4', 'сталь']);
  });

  it('falls back to the legacy location', () => {
    expect(itemLocations(item({ location: 'Гараж' }))).toEqual(['Гараж']);
  });

  it('sorts low stock by distance from the minimum', () => {
    const sorted = sortItems(
      [item({ name: 'Запас', quantity: 5, minQuantity: 2 }), item({ name: 'Нужно', quantity: 1, minQuantity: 4 })],
      'low'
    );
    expect(sorted.map((entry) => entry.name)).toEqual(['Нужно', 'Запас']);
  });
});
