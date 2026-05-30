import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Boxes,
  Check,
  Edit3,
  Filter,
  LogOut,
  Minus,
  PackagePlus,
  Plus,
  Search,
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
  minQuantity: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

type Draft = Omit<Item, 'id' | 'createdAt' | 'updatedAt'>;

const emptyDraft: Draft = {
  name: '',
  category: 'Винты и крепеж',
  quantity: 0,
  unit: 'шт',
  location: '',
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

const units = ['шт', 'упак', 'м', 'мл', 'г', 'компл'];
const tokenKey = 'garage_inventory_token';

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function App() {
  // UI state is kept local; the server remains the source of truth for items.
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [password, setPassword] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Все');
  const [onlyLow, setOnlyLow] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  // Reload inventory whenever a valid session becomes available.
  async function loadItems() {
    if (!token) return;
    setError('');
    try {
      setItems(await request<Item[]>('/api/items'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные');
    }
  }

  useEffect(() => {
    loadItems();
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

  // Create and update share the same drawer form and local optimistic refresh path.
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
    }
  }

  // Filtering stays client-side because the inventory is expected to be small.
  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      const low = item.quantity <= item.minQuantity;
      const textMatch = [item.name, item.category, item.location, item.note].join(' ').toLowerCase().includes(search);
      const categoryMatch = category === 'Все' || item.category === category;
      const stockMatch = !onlyLow || low;
      return textMatch && categoryMatch && stockMatch;
    });
  }, [items, query, category, onlyLow]);

  const lowCount = items.filter((item) => item.quantity <= item.minQuantity).length;

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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск" />
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

      <section className="inventory-grid">
        {filteredItems.map((item) => {
          const low = item.quantity <= item.minQuantity;
          return (
            <article className={low ? 'item-card low' : 'item-card'} key={item.id}>
              <div className="item-card-header">
                <span className="category-chip">{item.category}</span>
                {low && <AlertTriangle size={18} className="low-icon" />}
              </div>
              <h2>{item.name}</h2>
              <div className="quantity-row">
                <button onClick={() => adjustItem(item, -1)} title="Списать 1">
                  <Minus size={18} />
                </button>
                <strong>
                  {item.quantity.toLocaleString('ru-RU')} {item.unit}
                </strong>
                <button onClick={() => adjustItem(item, 1)} title="Добавить 1">
                  <Plus size={18} />
                </button>
              </div>
              <dl>
                <div>
                  <dt>Минимум</dt>
                  <dd>
                    {item.minQuantity.toLocaleString('ru-RU')} {item.unit}
                  </dd>
                </div>
                <div>
                  <dt>Место</dt>
                  <dd>{item.location || 'Не указано'}</dd>
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

      {filteredItems.length === 0 && (
        <section className="empty-state">
          <Boxes size={36} />
          <h2>Пусто</h2>
          <p>Добавьте первую позицию или измените фильтры.</p>
        </section>
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
                Место хранения
                <input
                  value={draft.location}
                  onChange={(event) => setDraft({ ...draft, location: event.target.value })}
                  placeholder="Гараж, стеллаж 2, ящик 4"
                />
              </label>
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
