import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Barcode,
  Boxes,
  Camera,
  Check,
  Edit3,
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
  Search,
  Sun,
  Trash2,
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

function App() {
  // UI state is kept local; the server remains the source of truth for items.
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Все');
  const [project, setProject] = useState('Все');
  const [onlyLow, setOnlyLow] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(themeKey) || 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, theme);
  }, [theme]);

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
      const [nextItems, nextHistory] = await Promise.all([
        request<Item[]>('/api/items'),
        request<HistoryEntry[]>('/api/history')
      ]);
      setItems(nextItems);
      setHistory(nextHistory);
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
  }

  function startCreate() {
    setDraft(emptyDraft);
    setEditingId(null);
    setPanelOpen(true);
  }

  function startEdit(item: Item) {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = item;
    setDraft(rest);
    setEditingId(item.id);
    setPanelOpen(true);
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

    const reader = new FileReader();
    reader.onload = () => setDraft((current) => ({ ...current, photo: String(reader.result || '') }));
    reader.readAsDataURL(file);
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
  async function adjustItem(item: Item, amount: number) {
    try {
      const updated = await request<Item>(`/api/items/${item.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount })
      });
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setHistory(await request<HistoryEntry[]>('/api/history'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить количество');
    }
  }

  async function deleteItem(item: Item) {
    const confirmed = window.confirm(`Удалить "${item.name}"?`);
    if (!confirmed) return;

    try {
      await request(`/api/items/${item.id}`, { method: 'DELETE' });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setHistory((current) => current.filter((entry) => entry.itemId !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
    }
  }

  const projects = useMemo(() => {
    const dynamic = items.map((item) => item.project).filter(Boolean);
    return Array.from(new Set([...defaultProjects, ...dynamic]));
  }, [items]);

  // Filtering stays client-side because the inventory is expected to be small.
  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      const low = item.quantity <= item.minQuantity;
      const haystack = [
        item.name,
        item.category,
        item.location,
        item.locations.join(' '),
        item.barcode,
        item.project,
        item.note
      ]
        .join(' ')
        .toLowerCase();
      const textMatch = haystack.includes(search);
      const categoryMatch = category === 'Все' || item.category === category;
      const projectMatch = project === 'Все' || item.project === project;
      const stockMatch = !onlyLow || low;
      return textMatch && categoryMatch && projectMatch && stockMatch;
    });
  }, [items, query, category, project, onlyLow]);

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

      <section className="workbench">
        <section className="inventory-grid">
          {filteredItems.map((item) => {
            const low = item.quantity <= item.minQuantity;
            return (
              <article className={low ? 'item-card low' : 'item-card'} key={item.id}>
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
                  <button onClick={() => adjustItem(item, -1)} title="Списать 1">
                    <Minus size={18} />
                  </button>
                  <strong>
                    {formatNumber(item.quantity)} {item.unit}
                  </strong>
                  <button onClick={() => adjustItem(item, 1)} title="Добавить 1">
                    <Plus size={18} />
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Минимум</dt>
                    <dd>
                      {formatNumber(item.minQuantity)} {item.unit}
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
                  <button onClick={() => startEdit(item)} title="Редактировать">
                    <Edit3 size={17} />
                  </button>
                  <button onClick={() => deleteItem(item)} title="Удалить">
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
                <td>{item.locations.join(', ') || item.location}</td>
                <td>{item.project}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

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
                <input
                  value={draft.barcode}
                  onChange={(event) => setDraft({ ...draft, barcode: event.target.value })}
                  placeholder="4601234567890 или QR-код"
                />
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
          </aside>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
