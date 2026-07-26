import { useState } from 'react';
import { Barcode, Check, Edit3, History, ImagePlus, Info, PackageOpen, Trash2, X } from 'lucide-react';
import type { Container, Draft, HistoryEntry, Item } from '../domain/types';
import { formatDate, formatNumber } from '../lib/format';
import { actionLabel } from '../lib/inventory';
import { MultiValueField } from './MetadataEditors';
import { StockBalanceEditor } from './StockBalanceEditor';

type BalanceInput = { containerId: string; location: string; quantity: number };
type DetailTab = 'overview' | 'stock' | 'history' | 'edit';

type ItemDialogProps = {
  item: Item | null;
  draft: Draft;
  containers: Container[];
  categories: string[];
  units: string[];
  projects: string[];
  tags: string[];
  locations: string[];
  history: HistoryEntry[];
  busy: boolean;
  packageAmount: number;
  onDraftChange: (draft: Draft) => void;
  onClose: () => void;
  onSave: (event: React.FormEvent) => void;
  onPhoto: (file?: File) => void;
  onScan: () => void;
  onAdjust: (amount: number) => void;
  onCreateBalance: (input: BalanceInput) => Promise<void>;
  onUpdateBalance: (balanceId: string, input: BalanceInput) => Promise<void>;
  onTransfer: (fromBalanceId: string, toBalanceId: string, amount: number) => Promise<void>;
  onDeleteBalance: (balanceId: string) => Promise<void>;
  onSetDefaultBalance: (balanceId: string) => Promise<void>;
};

const tabs = [
  { id: 'overview' as const, label: 'Обзор', icon: Info },
  { id: 'stock' as const, label: 'Остатки', icon: PackageOpen },
  { id: 'history' as const, label: 'История', icon: History },
  { id: 'edit' as const, label: 'Изменить', icon: Edit3 }
];

export function ItemDialog(props: ItemDialogProps) {
  const {
    item,
    draft,
    containers,
    categories,
    units,
    projects,
    tags,
    locations,
    history,
    busy,
    packageAmount,
    onDraftChange,
    onClose,
    onSave,
    onPhoto,
    onScan,
    onAdjust,
    onCreateBalance,
    onUpdateBalance,
    onTransfer,
    onDeleteBalance,
    onSetDefaultBalance
  } = props;
  const [tab, setTab] = useState<DetailTab>(item ? 'overview' : 'edit');
  const primaryBalance = item?.balances.find((balance) => balance.id === item.defaultBalanceId) || item?.balances[0];
  const primaryContainer = containers.find((container) => container.id === primaryBalance?.containerId);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="item-dialog" role="dialog" aria-modal="true" aria-labelledby="item-dialog-title" onClick={(event) => event.stopPropagation()}>
        <header className="item-dialog-header">
          <div>
            <small>{item ? item.category : 'Новая позиция'}</small>
            <h2 id="item-dialog-title">{item?.name || 'Добавить в склад'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Закрыть"><X size={19} /></button>
        </header>

        {item && (
          <nav className="item-dialog-tabs" aria-label="Разделы позиции">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={tab === id ? 'active' : ''} aria-selected={tab === id} onClick={() => setTab(id)}>
                <Icon size={17} /><span>{label}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="item-dialog-body">
          {item && tab === 'overview' && (
            <section className="item-overview">
              <div className="item-overview-lead">
                {item.photo ? <img src={item.photo} alt={item.name} /> : <div className="item-photo placeholder"><ImagePlus size={28} /></div>}
                <div>
                  <span className="item-overview-quantity">{formatNumber(item.quantity)} <small>{item.unit}</small></span>
                  <strong>{primaryContainer?.name || primaryBalance?.location || 'Место не указано'}</strong>
                  <small>{item.balances.length} мест хранения</small>
                </div>
              </div>
              <dl className="overview-details">
                <div><dt>Пополнять при</dt><dd>{formatNumber(item.reorderPoint)} {item.unit}</dd></div>
                <div><dt>Желаемый запас</dt><dd>{formatNumber(item.targetQuantity)} {item.unit}</dd></div>
                <div><dt>Проекты</dt><dd>{item.projects.join(', ') || 'Не назначены'}</dd></div>
                <div><dt>Теги</dt><dd>{item.tags.length ? item.tags.map((value) => `#${value}`).join(' ') : 'Нет тегов'}</dd></div>
                <div><dt>Код</dt><dd>{item.barcode || 'Не указан'}</dd></div>
              </dl>
              {item.note && <p className="item-overview-note">{item.note}</p>}
            </section>
          )}

          {item && tab === 'stock' && (
            <section className="item-stock-workspace">
              <div className="stock-quick-actions">
                <button type="button" onClick={() => onAdjust(-1)} disabled={item.quantity <= 0}>-1</button>
                <button type="button" onClick={() => onAdjust(1)}>+1</button>
                <button type="button" onClick={() => onAdjust(packageAmount)}>+ упаковка</button>
                <button type="button" onClick={() => onAdjust(-item.quantity)} disabled={item.quantity <= 0}>Списать всё</button>
              </div>
              <StockBalanceEditor
                item={item}
                containers={containers}
                onCreate={onCreateBalance}
                onUpdate={onUpdateBalance}
                onTransfer={onTransfer}
                onDelete={onDeleteBalance}
                onSetDefault={onSetDefaultBalance}
              />
            </section>
          )}

          {item && tab === 'history' && (
            <section className="item-operation-history">
              {history.length ? (
                <ol>
                  {history.map((entry) => (
                    <li key={entry.id}>
                      <span className="operation-mark" aria-hidden="true" />
                      <span><strong>{actionLabel(entry)}</strong><small>{entry.note || `Остаток стал ${formatNumber(entry.quantityAfter)}`}</small></span>
                      <strong>{entry.amount > 0 ? '+' : ''}{formatNumber(entry.amount)}</strong>
                      <time>{formatDate(entry.createdAt)}</time>
                    </li>
                  ))}
                </ol>
              ) : <p className="muted">Операций по этой позиции пока нет.</p>}
            </section>
          )}

          {tab === 'edit' && (
            <form className="item-form" onSubmit={onSave}>
              <div className="form-section">
                <h3>Основное</h3>
                <label>Название<input required value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="Винт M4x20" /></label>
                <div className="form-grid">
                  <label>Категория<select value={draft.category} onChange={(event) => onDraftChange({ ...draft, category: event.target.value })}>
                    {categories.map((entry) => <option key={entry}>{entry}</option>)}
                  </select></label>
                  <label>Единица<select value={draft.unit} onChange={(event) => onDraftChange({ ...draft, unit: event.target.value })}>
                    {units.map((entry) => <option key={entry}>{entry}</option>)}
                  </select></label>
                </div>
                <MultiValueField label="Проекты и наборы" values={draft.projects} suggestions={projects} placeholder="Электрика, ремонт велосипеда" onChange={(values) => onDraftChange({ ...draft, projects: values, project: values[0] || '' })} />
                <MultiValueField label="Теги" values={draft.tags} suggestions={tags} placeholder="M4, нержавейка" onChange={(values) => onDraftChange({ ...draft, tags: values })} />
              </div>

              {!item && (
                <div className="form-section">
                  <h3>Первый остаток</h3>
                  <div className="form-grid">
                    <label>Количество<input min="0" step="0.01" type="number" value={draft.quantity} onChange={(event) => onDraftChange({ ...draft, quantity: Number(event.target.value) })} /></label>
                    <label>Единица<select value={draft.unit} onChange={(event) => onDraftChange({ ...draft, unit: event.target.value })}>{units.map((entry) => <option key={entry}>{entry}</option>)}</select></label>
                  </div>
                  <label>Контейнер<select value={draft.containerId} onChange={(event) => onDraftChange({ ...draft, containerId: event.target.value })}>
                    <option value="">Без контейнера</option>{containers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select></label>
                  <MultiValueField label="Место хранения" values={draft.locations} suggestions={locations} placeholder="Гараж / стеллаж 2" onChange={(values) => onDraftChange({ ...draft, locations: values, location: values[0] || '' })} />
                </div>
              )}

              <div className="form-section">
                <h3>Пополнение</h3>
                <div className="form-grid thresholds-grid">
                  <label>Порог<input min="0" step="0.01" type="number" value={draft.reorderPoint} onChange={(event) => onDraftChange({ ...draft, reorderPoint: Number(event.target.value), minQuantity: Number(event.target.value) })} /></label>
                  <label>Пополнить до<input min={draft.reorderPoint} step="0.01" type="number" value={draft.targetQuantity} onChange={(event) => onDraftChange({ ...draft, targetQuantity: Number(event.target.value) })} /></label>
                </div>
              </div>

              <div className="form-section">
                <h3>Идентификация</h3>
                <label>QR / штрихкод<span className="inline-input"><input value={draft.barcode} onChange={(event) => onDraftChange({ ...draft, barcode: event.target.value })} placeholder="4601234567890" /><button type="button" onClick={onScan} title="Сканировать"><Barcode size={17} /></button></span></label>
                <label>Фото<input accept="image/*" type="file" onChange={(event) => onPhoto(event.target.files?.[0])} /></label>
                {draft.photo && <div className="photo-preview"><img src={draft.photo} alt="Предпросмотр" /><button type="button" onClick={() => onDraftChange({ ...draft, photo: '' })}><Trash2 size={16} />Убрать фото</button></div>}
                <label>Заметка<textarea rows={4} value={draft.note} onChange={(event) => onDraftChange({ ...draft, note: event.target.value })} /></label>
              </div>

              <footer className="item-dialog-footer">
                <button type="button" className="ghost-button" onClick={onClose}>Отмена</button>
                <button className="primary-button" disabled={busy}><Check size={18} />Сохранить</button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
