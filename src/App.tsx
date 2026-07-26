import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  AlertTriangle,
  ArrowUpDown,
  Barcode,
  Boxes,
  Check,
  ClipboardCheck,
  Filter,
  FolderKanban,
  History,
  LogOut,
  MapPin,
  Moon,
  PackagePlus,
  Printer,
  Rows3,
  Search,
  Settings,
  Square,
  Sun,
  Trash2,
  Undo2,
  X
} from 'lucide-react';
import { AppNavigation } from './components/AppNavigation';
import { ContainerEditor } from './components/ContainerEditor';
import { ItemCard } from './components/ItemCard';
import { ItemDialog } from './components/ItemDialog';
import { MetaEditor, MultiValueField } from './components/MetadataEditors';
import { StockBalanceEditor } from './components/StockBalanceEditor';
import { ApiError, apiRequest } from './api/client';
import { categories, emptyDraft, themeKey, units } from './domain/constants';
import type {
  Container,
  Draft,
  AppSection,
  HistoryEntry,
  HistoryPage,
  InventoryCheck,
  InventorySession,
  Item,
  MetaState,
  MetaType,
  QrTarget,
  SortMode,
  UndoAction,
  ViewMode
} from './domain/types';
import { formatDate, formatNumber } from './lib/format';
import { createImageVariants } from './lib/image';
import { actionLabel, itemLocations, sortItems } from './lib/inventory';
import { matchesSearch, searchAliasesFor } from './lib/search';
import './styles.css';

export function App() {
  // UI state is kept local; the server remains the source of truth for items.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [inventorySessions, setInventorySessions] = useState<InventorySession[]>([]);
  const [inventoryChecks, setInventoryChecks] = useState<InventoryCheck[]>([]);
  const [meta, setMeta] = useState<MetaState>({ locations: [], projects: [], tags: [] });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Все');
  const [project, setProject] = useState('Все');
  const [location, setLocation] = useState('Все');
  const [tag, setTag] = useState('Все');
  const [containerId, setContainerId] = useState('Все');
  const [onlyLow, setOnlyLow] = useState(false);
  const [section, setSection] = useState<AppSection>('stock');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [adjustBy, setAdjustBy] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [itemHistory, setItemHistory] = useState<HistoryEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [scannerMode, setScannerMode] = useState<'search' | 'draft' | 'inventory' | null>(null);
  const [inventoryFocusItemId, setInventoryFocusItemId] = useState('');
  const [inventoryContainerId, setInventoryContainerId] = useState('');
  const [foundContainerId, setFoundContainerId] = useState('');
  const [qrTarget, setQrTarget] = useState<QrTarget>(null);
  const [qrImage, setQrImage] = useState('');
  const [printMode, setPrintMode] = useState<'shopping' | 'qr'>('shopping');
  const [activeInventoryId, setActiveInventoryId] = useState('');
  const [inventoryQuantities, setInventoryQuantities] = useState<Record<string, number>>({});
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(themeKey) || 'light');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerDoneRef = useRef(false);

  function findContainerByCode(value: string) {
    const normalized = value.trim().toLowerCase();
    return containers.find((container) => {
      const code = container.code.trim().toLowerCase();
      return code === normalized || `container:${container.id}`.toLowerCase() === normalized || container.id.toLowerCase() === normalized;
    });
  }

  function openContainer(container: Container) {
    setFoundContainerId(container.id);
    setContainerId(container.id);
    setQuery('');
    setOnlyLow(false);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!qrTarget) {
      setQrImage('');
      return;
    }

    let cancelled = false;
    import('qrcode').then((QRCode) => {
      QRCode.toDataURL(qrTarget.value, { margin: 2, width: 280 }).then((url: string) => {
        if (!cancelled) setQrImage(url);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [qrTarget]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    if (!scannerMode) return;

    if (!window.isSecureContext) {
      setError('Камера браузера требует HTTPS. Используйте HTTPS-адрес приложения.');
      setScannerMode(null);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Камера недоступна в этом браузере');
      setScannerMode(null);
      return;
    }

    const Detector = (window as unknown as { BarcodeDetector?: new (options?: { formats?: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    if (!Detector) {
      setError('Сканер кодов не поддерживается этим браузером');
      setScannerMode(null);
      return;
    }

    scannerDoneRef.current = false;
    const detector = new Detector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
    let stream: MediaStream | null = null;
    let frame = 0;

    async function startScanner() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        const scan = async () => {
          if (!videoRef.current || scannerDoneRef.current) return;
          const codes = await detector.detect(videoRef.current).catch(() => []);
          const value = codes[0]?.rawValue;
          if (value) {
            scannerDoneRef.current = true;
            if (scannerMode === 'draft') {
              setDraft((current) => ({ ...current, barcode: value }));
            } else if (scannerMode === 'inventory') {
              const container = findContainerByCode(value);
              if (container) {
                setInventoryContainerId(container.id);
                setInventoryFocusItemId('');
              } else {
                const normalized = value.trim().toLowerCase();
                const item = items.find((entry) =>
                  entry.barcode.toLowerCase() === normalized
                  || `item:${entry.id}`.toLowerCase() === normalized
                  || entry.id.toLowerCase() === normalized
                );
                if (item) setInventoryFocusItemId(item.id);
                else setError('Позиция или контейнер с таким кодом не найдены');
              }
            } else {
              const container = findContainerByCode(value);
              if (container) {
                openContainer(container);
              } else {
                setFoundContainerId('');
                setQuery(value);
              }
            }
            setScannerMode(null);
            return;
          }
          frame = window.requestAnimationFrame(scan);
        };

        frame = window.requestAnimationFrame(scan);
      } catch {
        setError('Не удалось открыть камеру');
        setScannerMode(null);
      }
    }

    startScanner();

    return () => {
      scannerDoneRef.current = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scannerMode, containers, items]);

  // Shared API wrapper handles auth expiry and consistent error messages.
  async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    try {
      return await apiRequest<T>(url, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
      throw error;
    }
  }

  // Reload inventory and history whenever a valid session becomes available.
  async function loadData() {
    if (!authenticated) return;
    setError('');
    try {
      const [nextItems, nextHistory, nextMeta, nextContainers, nextSessions] = await Promise.all([
        request<Item[]>('/api/items'),
        request<HistoryPage>('/api/history'),
        request<MetaState>('/api/meta'),
        request<Container[]>('/api/containers'),
        request<InventorySession[]>('/api/inventory/sessions')
      ]);
      setItems(nextItems);
      setHistory(nextHistory.entries);
      setMeta(nextMeta);
      setContainers(nextContainers);
      setInventorySessions(nextSessions);
      setActiveInventoryId((current) => current || nextSessions.find((session) => session.status === 'open')?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
    }
  }

  useEffect(() => {
    apiRequest<{ ok: boolean }>('/api/auth/me')
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (authenticated) loadData();
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) loadInventoryChecks(activeInventoryId);
  }, [authenticated, activeInventoryId]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Не удалось войти');
      }

      setAuthenticated(true);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    setAuthenticated(false);
    setItems([]);
    setHistory([]);
    setContainers([]);
    setInventorySessions([]);
    setInventoryChecks([]);
    setMeta({ locations: [], projects: [], tags: [] });
  }

  function startCreate(container?: Container) {
    setDraft(container ? { ...emptyDraft, containerId: container.id, locations: container.location ? [container.location] : [], location: container.location } : emptyDraft);
    setEditingId(null);
    setItemHistory([]);
    setPanelOpen(true);
  }

  async function startEdit(item: Item) {
    const { id: _id, balances: _balances, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = item;
    setDraft(rest);
    setEditingId(item.id);
    setItemHistory([]);
    setPanelOpen(true);
    try {
      setItemHistory((await request<HistoryPage>(`/api/items/${item.id}/history`)).entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю позиции');
    }
  }

  async function imageToDraft(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Можно загрузить только изображение');
      return;
    }

    if (file.size > 1_500_000) {
      setError('Фото должно быть меньше 1.5 МБ');
      return;
    }

    try {
      const variants = await createImageVariants(file);
      const uploaded = await request<{ photo: string; thumbnail: string }>('/api/uploads/photos', {
        method: 'POST',
        body: JSON.stringify(variants)
      });
      setDraft((current) => ({ ...current, photo: uploaded.photo }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обработать фото');
    }
  }

  // Create and update share the same drawer form and local refresh path.
  async function saveItem(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = editingId
        ? await request<Item>(`/api/items/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify(draft)
          })
        : await request<Item>('/api/items', {
            method: 'POST',
            body: JSON.stringify(draft)
          });

      setItems((current) => {
        if (!editingId) return [...current, saved];
        return current.map((item) => (item.id === saved.id ? saved : item));
      });
      await loadData();
      setPanelOpen(false);
      setEditingId(null);
      setDraft(emptyDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  // Fast quantity changes are applied through a dedicated API route.
  async function adjustItem(item: Item, amount: number, createUndo = true, balanceId = item.defaultBalanceId) {
    try {
      const clearAll = amount < 0 && Math.abs(amount) >= item.quantity;
      const previousBalances = item.balances.map((balance) => ({ ...balance }));
      const updated = await request<Item>(`/api/items/${item.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount, balanceId, all: clearAll })
      });
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setHistory((await request<HistoryPage>('/api/history')).entries);
      if (createUndo && updated.quantity !== item.quantity) {
        const actualDelta = updated.quantity - item.quantity;
        setUndo({
          message: `${actualDelta > 0 ? 'Добавлено' : 'Списано'} ${formatNumber(Math.abs(actualDelta))} ${item.unit}: ${item.name}`,
          run: async () => {
            if (clearAll) {
              for (const balance of previousBalances) {
                await request<Item>(`/api/items/${item.id}/balances/${balance.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    containerId: balance.containerId,
                    location: balance.location,
                    quantity: balance.quantity
                  })
                });
              }
              await loadData();
            } else {
              await adjustItem(updated, -actualDelta, false, balanceId);
            }
          }
        });
      }
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить количество');
      return null;
    }
  }

  function packageAmount(item: Pick<Item, 'id' | 'minQuantity'>) {
    return Math.max(0.01, adjustBy[item.id] || item.minQuantity || 1);
  }

  async function adjustOpenItem(item: Item, amount: number) {
    const updated = await adjustItem(item, amount);
    if (updated) {
      setDraft((current) => ({ ...current, quantity: updated.quantity }));
    }
  }

  function applyStockUpdate(updated: Item) {
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setDraft((current) => ({ ...current, quantity: updated.quantity }));
  }

  async function createStockBalance(itemId: string, input: { containerId: string; location: string; quantity: number }) {
    try {
      const updated = await request<Item>(`/api/items/${itemId}/balances`, { method: 'POST', body: JSON.stringify(input) });
      applyStockUpdate(updated);
      setHistory((await request<HistoryPage>('/api/history')).entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить место остатка');
      throw err;
    }
  }

  async function updateStockBalance(itemId: string, balanceId: string, input: { containerId: string; location: string; quantity: number }) {
    try {
      const updated = await request<Item>(`/api/items/${itemId}/balances/${balanceId}`, { method: 'PATCH', body: JSON.stringify(input) });
      applyStockUpdate(updated);
      setHistory((await request<HistoryPage>('/api/history')).entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить остаток');
      throw err;
    }
  }

  async function transferStock(itemId: string, fromBalanceId: string, toBalanceId: string, amount: number) {
    try {
      const updated = await request<Item>(`/api/items/${itemId}/transfer`, {
        method: 'POST',
        body: JSON.stringify({ fromBalanceId, toBalanceId, amount })
      });
      applyStockUpdate(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переместить остаток');
      throw err;
    }
  }

  async function deleteStockBalance(itemId: string, balanceId: string) {
    try {
      await request(`/api/items/${itemId}/balances/${balanceId}`, { method: 'DELETE' });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить место остатка');
      throw err;
    }
  }

  async function setDefaultStockBalance(itemId: string, balanceId: string) {
    try {
      const updated = await request<Item>(`/api/items/${itemId}/default-balance`, {
        method: 'POST',
        body: JSON.stringify({ balanceId })
      });
      applyStockUpdate(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выбрать основное место');
      throw err;
    }
  }

  async function duplicateItem(item: Item) {
    const { id: _id, balances: _balances, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = item;
    const { defaultBalanceId: _defaultBalanceId, deletedAt: _deletedAt, ...draftCopy } = copy;
    setDraft({ ...draftCopy, name: `${item.name} копия`, barcode: '', quantity: 0 });
    setEditingId(null);
    setItemHistory([]);
    setPanelOpen(true);
  }

  async function deleteItem(item: Item) {
    const confirmed = window.confirm(`Удалить "${item.name}"?`);
    if (!confirmed) return;

    try {
      await request(`/api/items/${item.id}`, { method: 'DELETE' });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setHistory((current) => current.filter((entry) => entry.itemId !== item.id));
      setUndo({
        message: `Удалено: ${item.name}`,
        run: async () => {
          await request<Item>(`/api/items/${item.id}/restore`, { method: 'POST' });
          await loadData();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
    }
  }

  async function renameMeta(type: MetaType, from: string, to: string) {
    await request('/api/meta/rename', {
      method: 'POST',
      body: JSON.stringify({ type, from, to })
    });
    await loadData();
  }

  async function createMeta(type: MetaType, name: string) {
    await request('/api/meta', {
      method: 'POST',
      body: JSON.stringify({ type, name })
    });
    await loadData();
  }

  async function deleteMeta(type: MetaType, value: string) {
    await request('/api/meta/delete', {
      method: 'POST',
      body: JSON.stringify({ type, value })
    });
    await loadData();
  }

  async function saveContainer(container: Partial<Container>) {
    const body = JSON.stringify(container);
    if (container.id) {
      await request<Container>(`/api/containers/${container.id}`, { method: 'PATCH', body });
    } else {
      await request<Container>('/api/containers', { method: 'POST', body });
    }
    await loadData();
  }

  async function deleteContainer(id: string) {
    await request(`/api/containers/${id}`, { method: 'DELETE' });
    await loadData();
  }

  async function createInventorySession() {
    const session = await request<InventorySession>('/api/inventory/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: `Инвентаризация ${new Date().toLocaleDateString('ru-RU')}` })
    });
    setActiveInventoryId(session.id);
    await loadData();
  }

  async function closeInventorySession(id: string) {
    if (!window.confirm('Применить найденные расхождения и закрыть инвентаризацию?')) return;
    await request<InventorySession>(`/api/inventory/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed', apply: true })
    });
    setActiveInventoryId('');
    await loadData();
  }

  async function loadInventoryChecks(sessionId: string) {
    if (!sessionId) {
      setInventoryChecks([]);
      return;
    }
    setInventoryChecks(await request<InventoryCheck[]>(`/api/inventory/sessions/${sessionId}/checks`));
  }

  async function checkInventoryItem(item: Item, balanceId = item.defaultBalanceId) {
    if (!activeInventoryId) return;
    const balance = item.balances.find((entry) => entry.id === balanceId);
    const actualQuantity = inventoryQuantities[balanceId] ?? balance?.quantity ?? item.quantity;
    const checks = await request<InventoryCheck[]>(`/api/inventory/sessions/${activeInventoryId}/checks`, {
      method: 'POST',
      body: JSON.stringify({ itemId: item.id, balanceId, actualQuantity })
    });
    setInventoryChecks(checks);
  }

  const projects = useMemo(() => {
    const dynamic = items.flatMap((item) => item.projects);
    return Array.from(new Set([...meta.projects, ...dynamic])).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [items, meta.projects]);

  const locations = useMemo(() => {
    const dynamic = items.flatMap(itemLocations);
    return Array.from(new Set([...meta.locations, ...dynamic])).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [items, meta.locations]);

  const tags = useMemo(() => {
    const dynamic = items.flatMap((item) => item.tags);
    return Array.from(new Set([...meta.tags, ...dynamic])).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [items, meta.tags]);

  const activeInventory = inventorySessions.find((session) => session.id === activeInventoryId);
  const activeEditItem = editingId ? items.find((item) => item.id === editingId) : null;
  const foundContainer = containers.find((container) => container.id === foundContainerId);

  function printShoppingList() {
    setPrintMode('shopping');
    window.setTimeout(() => window.print(), 0);
  }

  function printQrCode() {
    setPrintMode('qr');
    window.setTimeout(() => window.print(), 0);
  }

  // Filtering stays client-side because the inventory is expected to be small.
  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      const low = item.quantity <= item.reorderPoint && item.quantity < item.targetQuantity;
      const locations = itemLocations(item);
      const itemContainers = containers.filter((entry) => item.balances.some((balance) => balance.containerId === entry.id));
      const haystack = [
        item.id,
        `item:${item.id}`,
        item.name,
        item.category,
        item.location,
        locations.join(' '),
        item.barcode,
        item.projects.join(' '),
        item.tags.join(' '),
        itemContainers.map((entry) => `${entry.name} ${entry.code} ${entry.location}`).join(' '),
        item.note
      ]
        .join(' ');
      const aliases = searchAliasesFor([item.category, ...item.projects, ...item.tags].join(' '));
      const textMatch = matchesSearch(search, { searchText: haystack, aliases });
      const categoryMatch = category === 'Все' || item.category === category;
      const projectMatch = project === 'Все' || item.projects.includes(project);
      const locationMatch = location === 'Все' || locations.includes(location);
      const tagMatch = tag === 'Все' || item.tags.includes(tag);
      const containerMatch = containerId === 'Все' || item.balances.some((balance) => balance.containerId === containerId);
      const stockMatch = !onlyLow || low;
      return textMatch && categoryMatch && projectMatch && locationMatch && tagMatch && containerMatch && stockMatch;
    });
    return sortItems(filtered, sortMode);
  }, [items, query, category, project, location, tag, containerId, onlyLow, sortMode, containers]);

  const lowItems = useMemo(
    () => items.filter((item) => item.quantity <= item.reorderPoint && item.quantity < item.targetQuantity),
    [items]
  );
  const lowCount = lowItems.length;
  const inventoryItems = items.filter((item) =>
    (!inventoryContainerId || item.balances.some((balance) => balance.containerId === inventoryContainerId))
    && (!inventoryFocusItemId || item.id === inventoryFocusItemId)
  );
  const inventoryRows = inventoryItems.flatMap((item) =>
    item.balances
      .filter((balance) => !inventoryContainerId || balance.containerId === inventoryContainerId)
      .map((balance) => ({ item, balance }))
  );
  const checkedBalanceIds = new Set(inventoryChecks.map((check) => check.balanceId).filter(Boolean));
  const inventoryRowIds = new Set(inventoryRows.map(({ balance }) => balance.id));
  const visibleCheckedCount = Array.from(checkedBalanceIds).filter((id) => inventoryRowIds.has(id)).length;
  const activeFilterCount = [category, project, location, tag, containerId].filter((value) => value !== 'Все').length
    + (onlyLow ? 1 : 0);
  const sectionCopy: Record<AppSection, { title: string; subtitle: string }> = {
    stock: { title: 'Запасы', subtitle: `${items.length} позиций в домашнем складе` },
    containers: { title: 'Контейнеры', subtitle: 'Ящики, коробки и их содержимое' },
    projects: { title: 'Проекты и метки', subtitle: 'Связи предметов с работами и назначением' },
    inventory: { title: 'Инвентаризация', subtitle: 'Проверка фактических остатков по местам' },
    shopping: { title: 'Покупки', subtitle: `${lowCount} позиций пора пополнить` }
  };

  function resetFilters() {
    setCategory('Все');
    setProject('Все');
    setLocation('Все');
    setTag('Все');
    setContainerId('Все');
    setOnlyLow(false);
    setFoundContainerId('');
  }

  if (authenticated === null) {
    return <main className="login-shell"><div className="login-box"><strong>Загрузка склада...</strong></div></main>;
  }

  if (!authenticated) {
    return (
      <main className="login-shell">
        <form className="login-box" onSubmit={login}>
          <div className="brand-mark">
            <Boxes size={32} />
          </div>
          <h1>Гаражный учет</h1>
          <label>
            Пароль
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Введите пароль"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary-button" disabled={busy || !password}>
            <Check size={18} />
            Войти
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <AppNavigation active={section} lowCount={lowCount} onChange={setSection} />
      <div className="app-content">
      <header className="topbar">
        <div>
          <h1>{sectionCopy[section].title}</h1>
          <p>{sectionCopy[section].subtitle}</p>
        </div>
        <div className="topbar-actions">
          <button
            className="ghost-button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Светлая тема' : 'Темная тема'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="ghost-button" onClick={() => void logout()} title="Выйти">
            <LogOut size={18} />
          </button>
          {section === 'stock' && (
            <button className="primary-button" onClick={() => startCreate()}>
              <PackagePlus size={18} />
              Добавить позицию
            </button>
          )}
        </div>
      </header>

      {section === 'stock' && <section className="toolbar">
        <label className="search-field">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск, QR или штрихкод" />
          <button type="button" onClick={() => setScannerMode('search')} title="Сканировать код">
            <Barcode size={17} />
          </button>
        </label>

        <label className="select-field">
          <ArrowUpDown size={18} />
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="name">По названию</option>
            <option value="low">Сначала докупить</option>
            <option value="quantity">По количеству</option>
            <option value="location">По месту</option>
            <option value="updated">Недавно измененные</option>
          </select>
        </label>

        <button
          className="toggle-button compact"
          aria-label={viewMode === 'cards' ? 'Показать списком' : 'Показать карточками'}
          onClick={() => setViewMode((value) => (value === 'cards' ? 'list' : 'cards'))}
        >
          {viewMode === 'cards' ? <Rows3 size={18} /> : <Square size={18} />}
          <span>{viewMode === 'cards' ? 'Список' : 'Карточки'}</span>
        </button>

        <button
          className={filtersOpen || activeFilterCount ? 'toggle-button active compact' : 'toggle-button compact'}
          onClick={() => setFiltersOpen((value) => !value)}
          aria-expanded={filtersOpen}
          aria-label="Фильтры"
        >
          <Filter size={18} />
          <span>Фильтры</span>
          {activeFilterCount > 0 && <b>{activeFilterCount}</b>}
        </button>
      </section>}

      {section === 'stock' && filtersOpen && (
        <section className="filter-panel" aria-label="Фильтры запасов">
          <label>Категория<select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option>Все</option>{categories.map((entry) => <option key={entry}>{entry}</option>)}
          </select></label>
          <label>Проект<select value={project} onChange={(event) => setProject(event.target.value)}>
            <option>Все</option>{projects.map((entry) => <option key={entry}>{entry}</option>)}
          </select></label>
          <label>Место<select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option>Все</option>{locations.map((entry) => <option key={entry}>{entry}</option>)}
          </select></label>
          <label>Тег<select value={tag} onChange={(event) => setTag(event.target.value)}>
            <option>Все</option>{tags.map((entry) => <option key={entry}>{entry}</option>)}
          </select></label>
          <label>Контейнер<select value={containerId} onChange={(event) => {
            setContainerId(event.target.value);
            setFoundContainerId(event.target.value === 'Все' ? '' : event.target.value);
          }}>
            <option>Все</option>{containers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label>
          <label className="filter-check">
            <input type="checkbox" checked={onlyLow} onChange={(event) => setOnlyLow(event.target.checked)} />
            Только требующие пополнения
          </label>
          <button className="ghost-button" type="button" onClick={resetFilters}>Сбросить</button>
        </section>
      )}

      {section === 'stock' && activeFilterCount > 0 && (
        <div className="active-filter-row">
          {category !== 'Все' && <button onClick={() => setCategory('Все')}>{category}<X size={14} /></button>}
          {project !== 'Все' && <button onClick={() => setProject('Все')}>{project}<X size={14} /></button>}
          {location !== 'Все' && <button onClick={() => setLocation('Все')}>{location}<X size={14} /></button>}
          {tag !== 'Все' && <button onClick={() => setTag('Все')}>#{tag}<X size={14} /></button>}
          {containerId !== 'Все' && <button onClick={() => { setContainerId('Все'); setFoundContainerId(''); }}>
            {containers.find((entry) => entry.id === containerId)?.name || 'Контейнер'}<X size={14} />
          </button>}
          {onlyLow && <button onClick={() => setOnlyLow(false)}>Нужно пополнить<X size={14} /></button>}
        </div>
      )}

      {section === 'stock' && foundContainer && (
        <section className="found-container-panel">
          <div>
            <strong>{foundContainer.name}</strong>
            <span>
              {items.filter((item) => item.containerId === foundContainer.id).length} позиций
              {foundContainer.location && ` · ${foundContainer.location}`}
            </span>
          </div>
          <button className="ghost-button" onClick={() => startCreate(foundContainer)}>
            <PackagePlus size={17} />
            Добавить сюда
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              setFoundContainerId('');
              setContainerId('Все');
            }}
          >
            <X size={17} />
            Сбросить
          </button>
        </section>
      )}

      {error && (
        <div className="toast">
          <span>{error}</span>
          <button onClick={() => setError('')} title="Закрыть">
            <X size={16} />
          </button>
        </div>
      )}

      {undo && (
        <div className="toast undo-toast">
          <span>{undo.message}</span>
          <button
            onClick={async () => {
              const action = undo;
              setUndo(null);
              await action.run();
            }}
            title="Отменить"
          >
            <Undo2 size={16} />
          </button>
        </div>
      )}

      {section === 'stock' && <section className="workbench">
        <section className={viewMode === 'list' ? 'inventory-grid list-mode' : 'inventory-grid'}>
          {filteredItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              container={containers.find((entry) => entry.id === item.containerId)}
              packageValue={packageAmount(item)}
              onAdjust={(amount) => {
                void adjustItem(item, amount);
              }}
              onOpen={() => {
                void startEdit(item);
              }}
              onDuplicate={() => duplicateItem(item)}
              onQr={() => setQrTarget({ title: item.name, value: item.barcode || `item:${item.id}` })}
              onDelete={() => {
                void deleteItem(item);
              }}
            />
          ))}
        </section>
      </section>}

      {section === 'stock' && filteredItems.length === 0 && (
        <section className="empty-state">
          <Boxes size={36} />
          <h2>Пусто</h2>
          <p>Добавьте первую позицию или измените фильтры.</p>
        </section>
      )}

      {section === 'containers' && (
        <section className="workspace-page">
          <div className="workspace-heading">
            <div>
              <h2>Физические ящики</h2>
              <p>QR-код открывает содержимое контейнера и позволяет добавить предмет прямо в него.</p>
            </div>
          </div>
          <ContainerEditor
            containers={containers}
            onSave={saveContainer}
            onDelete={deleteContainer}
            onQr={(container) => setQrTarget({ title: container.name, value: container.code })}
          />
        </section>
      )}

      {section === 'projects' && (
        <section className="workspace-page metadata-workspace">
          <MetaEditor title="Проекты и наборы" type="project" values={meta.projects} onCreate={createMeta} onRename={renameMeta} onDelete={deleteMeta} />
          <MetaEditor title="Места хранения" type="location" values={locations} onCreate={createMeta} onRename={renameMeta} onDelete={deleteMeta} />
          <MetaEditor title="Теги" type="tag" values={tags} onCreate={createMeta} onRename={renameMeta} onDelete={deleteMeta} />
        </section>
      )}

      {section === 'inventory' && (
        <section className="workspace-page inventory-workspace">
          <div className="inventory-session-bar">
            <select value={activeInventoryId} onChange={(event) => setActiveInventoryId(event.target.value)}>
              <option value="">Выберите сессию</option>
              {inventorySessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} · {session.status === 'open' ? 'открыта' : 'закрыта'}
                </option>
              ))}
            </select>
            <button className="primary-button" onClick={createInventorySession}>
              <ClipboardCheck size={18} />Новая проверка
            </button>
            <button className="ghost-button" disabled={!activeInventoryId} onClick={() => setScannerMode('inventory')}>
              <Barcode size={18} />Сканировать
            </button>
          </div>

          {activeInventoryId ? (
            <>
              <div className="inventory-progress">
                <span><strong>{visibleCheckedCount}</strong> из {inventoryRows.length} мест проверено</span>
                <progress max={Math.max(1, inventoryRows.length)} value={visibleCheckedCount} />
                {activeInventory?.status === 'open' && (
                  <button className="ghost-button" onClick={() => void closeInventorySession(activeInventory.id)}>
                    <Check size={18} />Сверить и закрыть
                  </button>
                )}
              </div>

              {(inventoryContainerId || inventoryFocusItemId) && (
                <div className="inventory-scope">
                  <span>
                    {inventoryContainerId
                      ? `Контейнер: ${containers.find((entry) => entry.id === inventoryContainerId)?.name || 'не найден'}`
                      : `Позиция: ${items.find((entry) => entry.id === inventoryFocusItemId)?.name || 'не найдена'}`}
                  </span>
                  <button onClick={() => { setInventoryContainerId(''); setInventoryFocusItemId(''); }}>
                    <X size={16} />Показать все
                  </button>
                </div>
              )}

              <div className="inventory-balance-list">
                {inventoryRows.map(({ item, balance }) => {
                  const checked = checkedBalanceIds.has(balance.id);
                  const container = containers.find((entry) => entry.id === balance.containerId);
                  return (
                    <div className={checked ? 'inventory-balance-row checked' : 'inventory-balance-row'} key={balance.id}>
                      <span className="inventory-item-name">
                        <strong>{item.name}</strong>
                        <small>{container?.name || balance.location || 'Без места'}</small>
                      </span>
                      <span className="inventory-expected">
                        <small>В учете</small>
                        <strong>{formatNumber(balance.quantity)} {item.unit}</strong>
                      </span>
                      <label>
                        <span>Фактически</span>
                        <input
                          min="0"
                          step="0.01"
                          type="number"
                          value={inventoryQuantities[balance.id] ?? balance.quantity}
                          disabled={activeInventory?.status === 'closed'}
                          onChange={(event) => setInventoryQuantities((current) => ({
                            ...current,
                            [balance.id]: Number(event.target.value) || 0
                          }))}
                        />
                      </label>
                      <button
                        className={checked ? 'checked' : ''}
                        disabled={activeInventory?.status === 'closed'}
                        onClick={() => void checkInventoryItem(item, balance.id)}
                        title={checked ? 'Обновить проверку' : 'Подтвердить'}
                      >
                        <Check size={18} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="empty-state"><ClipboardCheck size={36} /><h2>Начните проверку</h2><p>Создайте сессию, затем сканируйте ящик или позицию.</p></div>
          )}
        </section>
      )}

      {section === 'shopping' && (
        <section className="workspace-page shopping-workspace">
          <div className="workspace-heading">
            <div>
              <h2>Нужно пополнить</h2>
              <p>Количество рассчитывается до желаемого запаса, а не только до порога.</p>
            </div>
            <button className="ghost-button" onClick={printShoppingList}><Printer size={18} />Печать</button>
          </div>
          {lowItems.length ? (
            <div className="shopping-table">
              {lowItems.map((item) => (
                <button key={item.id} type="button" onClick={() => void startEdit(item)}>
                  <span><strong>{item.name}</strong><small>{item.locations.join(' · ') || 'Место не указано'}</small></span>
                  <span><small>Осталось</small><strong>{formatNumber(item.quantity)} {item.unit}</strong></span>
                  <span><small>Купить</small><strong>{formatNumber(Math.max(0, item.targetQuantity - item.quantity))} {item.unit}</strong></span>
                </button>
              ))}
            </div>
          ) : <div className="empty-state"><Check size={34} /><h2>Запасов достаточно</h2><p>Ни одна позиция не достигла порога пополнения.</p></div>}
          <section className="operations-feed">
            <div className="panel-heading"><h2>Последние операции</h2><History size={18} /></div>
            <ol>
              {history.slice(0, 20).map((entry) => (
                <li key={entry.id}>
                  <span><strong>{entry.itemName}</strong><small>{actionLabel(entry)}</small></span>
                  <strong>{entry.amount > 0 ? '+' : ''}{formatNumber(entry.amount)}</strong>
                  <time>{formatDate(entry.createdAt)}</time>
                </li>
              ))}
            </ol>
          </section>
        </section>
      )}

      <section className={printMode === 'shopping' ? 'print-shopping active' : 'print-shopping'}>
        <h1>Список покупок</h1>
        <p>{formatDate(new Date().toISOString())}</p>
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              <th>Остаток</th>
              <th>Минимум</th>
              <th>Докупить</th>
              <th>Места</th>
              <th>Проект</th>
            </tr>
          </thead>
          <tbody>
            {lowItems.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>
                  {formatNumber(item.quantity)} {item.unit}
                </td>
                <td>
                  {formatNumber(item.reorderPoint)} {item.unit}
                </td>
                <td>
                  {formatNumber(Math.max(0, item.targetQuantity - item.quantity))} {item.unit}
                </td>
                <td>{item.locations.join(', ') || item.location}</td>
                <td>{item.project}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={printMode === 'qr' ? 'print-qr active' : 'print-qr'}>
        {qrTarget && (
          <>
            <h1>{qrTarget.title}</h1>
            {qrImage && <img src={qrImage} alt={qrTarget.title} />}
            <p>{qrTarget.value}</p>
          </>
        )}
      </section>

      {qrTarget && (
        <div className="drawer-backdrop" onClick={() => setQrTarget(null)}>
          <div className="qr-box" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <h2>QR-код</h2>
              <button onClick={() => setQrTarget(null)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <h3>{qrTarget.title}</h3>
            {qrImage && <img src={qrImage} alt={qrTarget.title} />}
            <code>{qrTarget.value}</code>
            <button className="primary-button" onClick={printQrCode}>
              <Printer size={18} />
              Печать
            </button>
          </div>
        </div>
      )}

      {scannerMode && (
        <div className="drawer-backdrop scanner-backdrop">
          <div className="scanner-box">
            <div className="drawer-header">
              <h2>Сканирование кода</h2>
              <button onClick={() => setScannerMode(null)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <video ref={videoRef} muted playsInline />
            <p className="muted">Наведите камеру на QR-код или штрихкод.</p>
          </div>
        </div>
      )}

      {panelOpen && (
        <ItemDialog
          key={editingId || 'new'}
          item={activeEditItem || null}
          draft={draft}
          containers={containers}
          categories={categories}
          units={units}
          projects={projects}
          tags={tags}
          locations={locations}
          history={itemHistory}
          busy={busy}
          packageAmount={activeEditItem ? packageAmount(activeEditItem) : 1}
          onDraftChange={setDraft}
          onClose={() => setPanelOpen(false)}
          onSave={saveItem}
          onPhoto={(file) => void imageToDraft(file)}
          onScan={() => setScannerMode('draft')}
          onAdjust={(amount) => activeEditItem && void adjustOpenItem(activeEditItem, amount)}
          onCreateBalance={(input) => createStockBalance(activeEditItem!.id, input)}
          onUpdateBalance={(balanceId, input) => updateStockBalance(activeEditItem!.id, balanceId, input)}
          onTransfer={(fromBalanceId, toBalanceId, amount) => transferStock(activeEditItem!.id, fromBalanceId, toBalanceId, amount)}
          onDeleteBalance={(balanceId) => deleteStockBalance(activeEditItem!.id, balanceId)}
          onSetDefaultBalance={(balanceId) => setDefaultStockBalance(activeEditItem!.id, balanceId)}
        />
      )}
      </div>
    </main>
  );
}
