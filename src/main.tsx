import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

declare module 'react-dom/client' {
  import * as React from 'react';

  export interface Root {
    render(children: React.ReactNode): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}

import {
  AlertTriangle,
  ArrowUpDown,
  Barcode,
  Boxes,
  Camera,
  Check,
  Filter,
  FolderKanban,
  History,
  LogOut,
  MapPin,
  Minus,
  Moon,
  PackagePlus,
  Plus,
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
import './styles.css';

type Item = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  locations: string[];
  barcode: string;
  project: string;
  photo: string;
  minQuantity: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

type HistoryEntry = {
  id: string;
  itemId: string;
  itemName: string;
  amount: number;
  quantityAfter: number;
  action: 'create' | 'edit' | 'add' | 'subtract';
  createdAt: string;
};

type Draft = Omit<Item, 'id' | 'createdAt' | 'updatedAt'>;
type ViewMode = 'cards' | 'list';
type SortMode = 'name' | 'quantity' | 'low' | 'updated' | 'location';
type MetaType = 'location' | 'project';
type UndoAction = { message: string; run: () => Promise<void> };
type MetaState = { locations: string[]; projects: string[] };

const emptyDraft: Draft = {
  name: '',
  category: 'Винты и крепеж',
  quantity: 0,
  unit: 'шт',
  location: '',
  locations: [],
  barcode: '',
  project: '',
  photo: '',
  minQuantity: 0,
  note: ''
};

const categories = [
  'Винты и крепеж',
  'Гайки и шайбы',
  'Батарейки',
  'Электрика',
  'Клей и химия',
  'Ленты и изоляция',
  'Инструментальные мелочи',
  'Прочее'
];

const defaultProjects = ['Для ремонта велосипеда', 'Электрика', '3D-принтер'];
const units = ['шт', 'упак', 'м', 'мл', 'г', 'компл'];
const tokenKey = 'garage_inventory_token';
const themeKey = 'garage_inventory_theme';

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function parseLocations(value: string) {
  return value
    .split(/\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function itemLocations(item: Pick<Item, 'location' | 'locations'>) {
  return item.locations.length ? item.locations : item.location ? [item.location] : [];
}

async function compressImage(file: File) {
  const image = new Image();
  const url = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = url;
    });

    const maxSide = 1200;
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось обработать фото');

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatNumber(value: number) {
  return value.toLocaleString('ru-RU');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function actionLabel(entry: HistoryEntry) {
  if (entry.action === 'create') return 'создано';
  if (entry.action === 'edit') return 'изменено вручную';
  return entry.amount > 0 ? 'добавлено' : 'списано';
}

function sortItems(items: Item[], sort: SortMode) {
  return [...items].sort((a, b) => {
    if (sort === 'quantity') return a.quantity - b.quantity || a.name.localeCompare(b.name, 'ru');
    if (sort === 'low') return a.quantity - a.minQuantity - (b.quantity - b.minQuantity) || a.name.localeCompare(b.name, 'ru');
    if (sort === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (sort === 'location') return (itemLocations(a)[0] || '').localeCompare(itemLocations(b)[0] || '', 'ru');
    return a.name.localeCompare(b.name, 'ru');
  });
}

function App() {
  // UI state is kept local; the server remains the source of truth for items.
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [meta, setMeta] = useState<MetaState>({ locations: [], projects: [] });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Все');
  const [project, setProject] = useState('Все');
  const [location, setLocation] = useState('Все');
  const [onlyLow, setOnlyLow] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [adjustBy, setAdjustBy] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [itemHistory, setItemHistory] = useState<HistoryEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [scannerMode, setScannerMode] = useState<'search' | 'draft' | null>(null);
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(themeKey) || 'light');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerDoneRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, theme);
  }, [theme]);

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
            } else {
              setQuery(value);
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
  }, [scannerMode]);

  // Shared API wrapper handles auth expiry and consistent error messages.
  async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? authHeaders(token) : {}),
        ...options.headers
      }
    });

    if (response.status === 401) {
      localStorage.removeItem(tokenKey);
      setToken('');
      throw new Error('Нужно войти заново');
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Ошибка запроса');
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  // Reload inventory and history whenever a valid session becomes available.
  async function loadData() {
    if (!token) return;
    setError('');
    try {
      const [nextItems, nextHistory, nextMeta] = await Promise.all([
        request<Item[]>('/api/items'),
        request<HistoryEntry[]>('/api/history'),
        request<MetaState>('/api/meta')
      ]);
      setItems(nextItems);
      setHistory(nextHistory);
      setMeta(nextMeta);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
    }
  }

  useEffect(() => {
    loadData();
  }, [token]);

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

      localStorage.setItem(tokenKey, payload.token);
      setToken(payload.token);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(tokenKey);
    setToken('');
    setItems([]);
    setHistory([]);
    setMeta({ locations: [], projects: [] });
  }

  function startCreate() {
    setDraft(emptyDraft);
    setEditingId(null);
    setItemHistory([]);
    setPanelOpen(true);
  }

  async function startEdit(item: Item) {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = item;
    setDraft(rest);
    setEditingId(item.id);
    setItemHistory([]);
    setPanelOpen(true);
    try {
      setItemHistory(await request<HistoryEntry[]>(`/api/items/${item.id}/history`));
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
      const photo = await compressImage(file);
      setDraft((current) => ({ ...current, photo }));
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
  async function adjustItem(item: Item, amount: number, createUndo = true) {
    try {
      const updated = await request<Item>(`/api/items/${item.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount })
      });
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setHistory(await request<HistoryEntry[]>('/api/history'));
      if (createUndo && updated.quantity !== item.quantity) {
        const actualDelta = updated.quantity - item.quantity;
        setUndo({
          message: `${actualDelta > 0 ? 'Добавлено' : 'Списано'} ${formatNumber(Math.abs(actualDelta))} ${item.unit}: ${item.name}`,
          run: () => adjustItem(updated, -actualDelta, false)
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить количество');
    }
  }

  async function duplicateItem(item: Item) {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = item;
    setDraft({ ...copy, name: `${item.name} копия`, quantity: 0 });
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
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...restore } = item;
          await request<Item>('/api/items', { method: 'POST', body: JSON.stringify(restore) });
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

  async function deleteMeta(type: MetaType, value: string) {
    await request('/api/meta/delete', {
      method: 'POST',
      body: JSON.stringify({ type, value })
    });
    await loadData();
  }

  const projects = useMemo(() => {
    const dynamic = items.map((item) => item.project).filter(Boolean);
    return Array.from(new Set([...defaultProjects, ...meta.projects, ...dynamic])).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [items, meta.projects]);

  const locations = useMemo(() => {
    const dynamic = items.flatMap(itemLocations);
    return Array.from(new Set([...meta.locations, ...dynamic])).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [items, meta.locations]);

  // Filtering stays client-side because the inventory is expected to be small.
  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      const low = item.quantity <= item.minQuantity;
      const locations = itemLocations(item);
      const haystack = [
        item.name,
        item.category,
        item.location,
        locations.join(' '),
        item.barcode,
        item.project,
        item.note
      ]
        .join(' ')
        .toLowerCase();
      const textMatch = haystack.includes(search);
      const categoryMatch = category === 'Все' || item.category === category;
      const projectMatch = project === 'Все' || item.project === project;
      const locationMatch = location === 'Все' || locations.includes(location);
      const stockMatch = !onlyLow || low;
      return textMatch && categoryMatch && projectMatch && locationMatch && stockMatch;
    });
    return sortItems(filtered, sortMode);
  }, [items, query, category, project, location, onlyLow, sortMode]);

  const lowItems = useMemo(() => items.filter((item) => item.quantity <= item.minQuantity), [items]);
  const lowCount = lowItems.length;

  if (!token) {
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
      <header className="topbar">
        <div>
          <h1>Гаражный учет</h1>
          <p>
            {items.length} позиций · {lowCount} требуют пополнения
          </p>
        </div>
        <div className="topbar-actions">
          <button
            className="ghost-button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Светлая тема' : 'Темная тема'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="ghost-button" onClick={() => window.print()} title="Печать списка покупок">
            <Printer size={18} />
          </button>
          <button className="ghost-button" onClick={() => setMetaOpen(true)} title="Редактор мест и проектов">
            <Settings size={18} />
          </button>
          <button className="ghost-button" onClick={logout} title="Выйти">
            <LogOut size={18} />
          </button>
          <button className="primary-button" onClick={startCreate}>
            <PackagePlus size={18} />
            Добавить
          </button>
        </div>
      </header>

      <section className="toolbar">
        <label className="search-field">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск, QR или штрихкод" />
          <button type="button" onClick={() => setScannerMode('search')} title="Сканировать код">
            <Barcode size={17} />
          </button>
        </label>

        <label className="select-field">
          <Filter size={18} />
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option>Все</option>
            {categories.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </label>

        <label className="select-field">
          <FolderKanban size={18} />
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            <option>Все</option>
            {projects.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </label>

        <label className="select-field">
          <MapPin size={18} />
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option>Все</option>
            {locations.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
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

        <button className="toggle-button" onClick={() => setViewMode((value) => (value === 'cards' ? 'list' : 'cards'))}>
          {viewMode === 'cards' ? <Rows3 size={18} /> : <Square size={18} />}
          {viewMode === 'cards' ? 'Список' : 'Карточки'}
        </button>

        <button className={onlyLow ? 'toggle-button active' : 'toggle-button'} onClick={() => setOnlyLow((value) => !value)}>
          <AlertTriangle size={18} />
          Нужно купить
        </button>
      </section>

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

      <section className="workbench">
        <section className={viewMode === 'list' ? 'inventory-grid list-mode' : 'inventory-grid'}>
          {filteredItems.map((item) => {
            const low = item.quantity <= item.minQuantity;
            const step = Math.max(0.01, adjustBy[item.id] || 1);
            const restock = Math.max(0, item.minQuantity - item.quantity);
            return (
              <article
                className={low ? 'item-card low' : 'item-card'}
                key={item.id}
                onClick={() => startEdit(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    startEdit(item);
                  }
                }}
              >
                {item.photo ? (
                  <img className="item-photo" src={item.photo} alt={item.name} />
                ) : (
                  <div className="item-photo placeholder">
                    <Camera size={28} />
                  </div>
                )}
                <div className="item-card-header">
                  <span className="category-chip">{item.category}</span>
                  {low && <AlertTriangle size={18} className="low-icon" />}
                </div>
                <h2>{item.name}</h2>
                <div className="meta-row">
                  {item.project && (
                    <span>
                      <FolderKanban size={14} />
                      {item.project}
                    </span>
                  )}
                  {item.barcode && (
                    <span>
                      <Barcode size={14} />
                      {item.barcode}
                    </span>
                  )}
                </div>
                <div className="quantity-row">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      adjustItem(item, -step);
                    }}
                    title={`Списать ${formatNumber(step)}`}
                  >
                    <Minus size={18} />
                  </button>
                  <strong>
                    {formatNumber(item.quantity)} {item.unit}
                  </strong>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      adjustItem(item, step);
                    }}
                    title={`Добавить ${formatNumber(step)}`}
                  >
                    <Plus size={18} />
                  </button>
                </div>
                <label className="adjust-field">
                  Шаг
                  <input
                    min="0.01"
                    step="0.01"
                    type="number"
                    value={adjustBy[item.id] ?? 1}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setAdjustBy((current) => ({ ...current, [item.id]: Number(event.target.value) || 1 }))}
                  />
                </label>
                <dl>
                  <div>
                    <dt>Минимум</dt>
                    <dd>
                      {formatNumber(item.minQuantity)} {item.unit}
                      {restock > 0 && <span className="restock">докупить {formatNumber(restock)} {item.unit}</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Места</dt>
                    <dd className="location-list">
                      {(item.locations.length ? item.locations : item.location ? [item.location] : ['Не указано']).map((location) => (
                        <span key={location}>
                          <MapPin size={13} />
                          {location}
                        </span>
                      ))}
                    </dd>
                  </div>
                </dl>
                {item.note && <p className="note">{item.note}</p>}
                <div className="card-actions">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      duplicateItem(item);
                    }}
                    title="Дублировать"
                  >
                    <PackagePlus size={17} />
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteItem(item);
                    }}
                    title="Удалить"
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        <aside className="side-panel">
          <section className="shopping-panel">
            <div className="panel-heading">
              <h2>Список покупок</h2>
              <button onClick={() => window.print()} title="Печать">
                <Printer size={17} />
              </button>
            </div>
            {lowItems.length ? (
              <ul>
                {lowItems.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>
                    <span>
                      {formatNumber(item.quantity)} / минимум {formatNumber(item.minQuantity)} {item.unit}
                      {' · '}докупить {formatNumber(Math.max(0, item.minQuantity - item.quantity))} {item.unit}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Все остатки выше минимума.</p>
            )}
          </section>

          <section className="history-panel">
            <div className="panel-heading">
              <h2>История</h2>
              <History size={18} />
            </div>
            {history.length ? (
              <ol>
                {history.slice(0, 12).map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.itemName}</strong>
                    <span>
                      {actionLabel(entry)} {entry.amount > 0 ? '+' : ''}
                      {formatNumber(entry.amount)} · стало {formatNumber(entry.quantityAfter)}
                    </span>
                    <time>{formatDate(entry.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Операций пока нет.</p>
            )}
          </section>
        </aside>
      </section>

      {filteredItems.length === 0 && (
        <section className="empty-state">
          <Boxes size={36} />
          <h2>Пусто</h2>
          <p>Добавьте первую позицию или измените фильтры.</p>
        </section>
      )}

      <section className="print-shopping">
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
                  {formatNumber(item.minQuantity)} {item.unit}
                </td>
                <td>
                  {formatNumber(Math.max(0, item.minQuantity - item.quantity))} {item.unit}
                </td>
                <td>{item.locations.join(', ') || item.location}</td>
                <td>{item.project}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {metaOpen && (
        <div className="drawer-backdrop" onClick={() => setMetaOpen(false)}>
          <aside className="drawer meta-drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <h2>Места и проекты</h2>
              <button onClick={() => setMetaOpen(false)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <MetaEditor
              title="Места хранения"
              type="location"
              values={locations}
              onRename={renameMeta}
              onDelete={deleteMeta}
            />
            <MetaEditor
              title="Проекты и наборы"
              type="project"
              values={meta.projects}
              onRename={renameMeta}
              onDelete={deleteMeta}
            />
          </aside>
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
        <div className="drawer-backdrop" onClick={() => setPanelOpen(false)}>
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <h2>{editingId ? 'Редактирование' : 'Новая позиция'}</h2>
              <button onClick={() => setPanelOpen(false)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <form className="item-form" onSubmit={saveItem}>
              <label>
                Название
                <input
                  required
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Винт M4x20"
                />
              </label>
              <label>
                Категория
                <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                  {categories.map((entry) => (
                    <option key={entry}>{entry}</option>
                  ))}
                </select>
              </label>
              <label>
                Набор / проект
                <input
                  list="project-options"
                  value={draft.project}
                  onChange={(event) => setDraft({ ...draft, project: event.target.value })}
                  placeholder="Для ремонта велосипеда"
                />
                <datalist id="project-options">
                  {projects.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              </label>
              <div className="form-grid">
                <label>
                  Количество
                  <input
                    min="0"
                    step="0.01"
                    type="number"
                    value={draft.quantity}
                    onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Ед.
                  <select value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })}>
                    {units.map((entry) => (
                      <option key={entry}>{entry}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Минимальный остаток
                <input
                  min="0"
                  step="0.01"
                  type="number"
                  value={draft.minQuantity}
                  onChange={(event) => setDraft({ ...draft, minQuantity: Number(event.target.value) })}
                />
              </label>
              <label>
                Места хранения
                <textarea
                  rows={3}
                  value={draft.locations.join('\n')}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      locations: parseLocations(event.target.value),
                      location: parseLocations(event.target.value)[0] || ''
                    })
                  }
                  placeholder="Гараж, стеллаж 2&#10;Мастерская, ящик 4"
                />
              </label>
              <label>
                QR / штрихкод
                <span className="inline-input">
                  <input
                    value={draft.barcode}
                    onChange={(event) => setDraft({ ...draft, barcode: event.target.value })}
                    placeholder="4601234567890 или QR-код"
                  />
                  <button type="button" onClick={() => setScannerMode('draft')} title="Сканировать код">
                    <Barcode size={17} />
                  </button>
                </span>
              </label>
              <label>
                Фото предмета или коробки
                <input accept="image/*" type="file" onChange={(event) => imageToDraft(event.target.files?.[0])} />
              </label>
              {draft.photo && (
                <div className="photo-preview">
                  <img src={draft.photo} alt="Предпросмотр" />
                  <button type="button" onClick={() => setDraft({ ...draft, photo: '' })}>
                    <Trash2 size={16} />
                    Убрать фото
                  </button>
                </div>
              )}
              <label>
                Заметка
                <textarea
                  rows={4}
                  value={draft.note}
                  onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                <Check size={18} />
                Сохранить
              </button>
            </form>
            {editingId && (
              <section className="item-history">
                <h3>История позиции</h3>
                {itemHistory.length ? (
                  <ol>
                    {itemHistory.map((entry) => (
                      <li key={entry.id}>
                        <strong>
                          {actionLabel(entry)} {entry.amount > 0 ? '+' : ''}
                          {formatNumber(entry.amount)}
                        </strong>
                        <span>стало {formatNumber(entry.quantityAfter)}</span>
                        <time>{formatDate(entry.createdAt)}</time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">Истории по этой позиции пока нет.</p>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function MetaEditor({
  title,
  type,
  values,
  onRename,
  onDelete
}: {
  title: string;
  type: MetaType;
  values: string[];
  onRename: (type: MetaType, from: string, to: string) => Promise<void>;
  onDelete: (type: MetaType, value: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyValue, setBusyValue] = useState('');

  async function save(from: string) {
    const to = (drafts[from] ?? from).trim();
    if (!to || to === from) return;
    setBusyValue(from);
    try {
      await onRename(type, from, to);
      setDrafts((current) => {
        const next = { ...current };
        delete next[from];
        return next;
      });
    } finally {
      setBusyValue('');
    }
  }

  async function remove(value: string) {
    const confirmed = window.confirm(`Удалить "${value}" из всех позиций?`);
    if (!confirmed) return;
    setBusyValue(value);
    try {
      await onDelete(type, value);
    } finally {
      setBusyValue('');
    }
  }

  return (
    <section className="meta-section">
      <h3>{title}</h3>
      {values.length ? (
        <div className="meta-list">
          {values.map((value) => (
            <div className="meta-row-edit" key={value}>
              <input
                value={drafts[value] ?? value}
                onChange={(event) => setDrafts((current) => ({ ...current, [value]: event.target.value }))}
              />
              <button disabled={busyValue === value || (drafts[value] ?? value) === value} onClick={() => save(value)}>
                <Check size={16} />
              </button>
              <button disabled={busyValue === value} onClick={() => remove(value)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Пока нет значений.</p>
      )}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
