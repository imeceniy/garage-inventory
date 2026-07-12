import type { HistoryEntry, Item, SortMode } from '../domain/types';

export function parseDelimitedList(value: string) {
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim().replace(/^#+/, '').trim())
    .filter(Boolean);
}

export function mergeDelimitedValues(current: string[], value: string) {
  const incoming = parseDelimitedList(value);
  if (!incoming.length) return current;
  return Array.from(new Set([...current, ...incoming]));
}

export function itemLocations(item: Pick<Item, 'location' | 'locations'>) {
  return item.locations.length ? item.locations : item.location ? [item.location] : [];
}

export function actionLabel(entry: HistoryEntry) {
  if (entry.action === 'create') return 'создано';
  if (entry.action === 'edit') return 'изменено вручную';
  if (entry.action === 'inventory') return 'инвентаризация';
  return entry.amount > 0 ? 'добавлено' : 'списано';
}

export function sortItems(items: Item[], sort: SortMode) {
  return [...items].sort((a, b) => {
    if (sort === 'quantity') return a.quantity - b.quantity || a.name.localeCompare(b.name, 'ru');
    if (sort === 'low') return a.quantity - a.minQuantity - (b.quantity - b.minQuantity) || a.name.localeCompare(b.name, 'ru');
    if (sort === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (sort === 'location') return (itemLocations(a)[0] || '').localeCompare(itemLocations(b)[0] || '', 'ru');
    return a.name.localeCompare(b.name, 'ru');
  });
}
