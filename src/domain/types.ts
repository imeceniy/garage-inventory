export type Item = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  locations: string[];
  barcode: string;
  project: string;
  tags: string[];
  containerId: string;
  photo: string;
  minQuantity: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type HistoryEntry = {
  id: string;
  itemId: string;
  itemName: string;
  amount: number;
  quantityAfter: number;
  action: 'create' | 'edit' | 'add' | 'subtract' | 'inventory';
  createdAt: string;
};

export type Draft = Omit<Item, 'id' | 'createdAt' | 'updatedAt'>;
export type ViewMode = 'cards' | 'list';
export type SortMode = 'name' | 'quantity' | 'low' | 'updated' | 'location';
export type MetaType = 'location' | 'project' | 'tag';
export type UndoAction = { message: string; run: () => Promise<void> };
export type MetaState = { locations: string[]; projects: string[]; tags: string[] };
export type Container = {
  id: string;
  name: string;
  code: string;
  location: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};
export type InventorySession = {
  id: string;
  name: string;
  status: 'open' | 'closed';
  startedAt: string;
  completedAt: string;
};
export type InventoryCheck = {
  id: string;
  sessionId: string;
  itemId: string;
  itemName: string;
  expectedQuantity: number;
  actualQuantity: number;
  note: string;
  checkedAt: string;
};
export type QrTarget = { title: string; value: string } | null;
