export type StockBalance = {
  id: string;
  itemId: string;
  containerId: string;
  location: string;
  quantity: number;
  createdAt: string;
  updatedAt: string;
};

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
  projects: string[];
  tags: string[];
  containerId: string;
  photo: string;
  minQuantity: number;
  reorderPoint: number;
  targetQuantity: number;
  defaultBalanceId: string;
  deletedAt: string;
  note: string;
  balances: StockBalance[];
  createdAt: string;
  updatedAt: string;
};

export type HistoryEntry = {
  id: string;
  itemId: string;
  itemName: string;
  amount: number;
  quantityAfter: number;
  action: 'create' | 'edit' | 'add' | 'subtract' | 'inventory' | 'transfer' | 'receive' | 'adjust';
  type?: string;
  fromBalanceId?: string;
  toBalanceId?: string;
  note?: string;
  createdAt: string;
};

export type Draft = Omit<Item, 'id' | 'balances' | 'createdAt' | 'updatedAt' | 'defaultBalanceId' | 'deletedAt'>;
export type ViewMode = 'cards' | 'list';
export type AppSection = 'stock' | 'containers' | 'projects' | 'inventory' | 'shopping';
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
  balanceId: string;
  expectedQuantity: number;
  actualQuantity: number;
  note: string;
  checkedAt: string;
  appliedAt: string;
};
export type HistoryPage = { entries: HistoryEntry[]; nextCursor: string };
export type QrTarget = { title: string; value: string } | null;
