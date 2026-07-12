import {
  AlertTriangle,
  Barcode,
  Boxes,
  Camera,
  FolderKanban,
  MapPin,
  Minus,
  PackagePlus,
  Plus,
  QrCode,
  Trash2
} from 'lucide-react';
import type { Container, Item } from '../domain/types';
import { formatNumber } from '../lib/format';
import { itemLocations } from '../lib/inventory';

type ItemCardProps = {
  item: Item;
  container?: Container;
  adjustValue: number;
  packageValue: number;
  onAdjustValueChange: (value: number) => void;
  onAdjust: (amount: number) => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onQr: () => void;
  onDelete: () => void;
};

export function ItemCard({
  item,
  container,
  adjustValue,
  packageValue,
  onAdjustValueChange,
  onAdjust,
  onOpen,
  onDuplicate,
  onQr,
  onDelete
}: ItemCardProps) {
  const low = item.quantity <= item.minQuantity;
  const step = Math.max(0.01, adjustValue || 1);
  const restock = Math.max(0, item.minQuantity - item.quantity);

  return (
    <article
      className={low ? 'item-card low' : 'item-card'}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
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
        {container && (
          <span>
            <Boxes size={14} />
            {container.name}
          </span>
        )}
        {item.tags.map((entry) => (
          <span key={entry}>#{entry}</span>
        ))}
      </div>
      <div className="quantity-row">
        <button onClick={(event) => { event.stopPropagation(); onAdjust(-step); }} title={`Списать ${formatNumber(step)}`}>
          <Minus size={18} />
        </button>
        <strong>{formatNumber(item.quantity)} {item.unit}</strong>
        <button onClick={(event) => { event.stopPropagation(); onAdjust(step); }} title={`Добавить ${formatNumber(step)}`}>
          <Plus size={18} />
        </button>
      </div>
      <label className="adjust-field">
        Шаг
        <input
          min="0.01"
          step="0.01"
          type="number"
          value={adjustValue}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onAdjustValueChange(Number(event.target.value) || 1)}
        />
      </label>
      <div className="quick-quantity-actions">
        <button onClick={(event) => { event.stopPropagation(); onAdjust(packageValue); }} title={`Добавить упаковку: ${formatNumber(packageValue)} ${item.unit}`}>
          + упаковка
        </button>
        <button disabled={item.quantity <= 0} onClick={(event) => { event.stopPropagation(); onAdjust(-item.quantity); }} title="Списать остаток до нуля">
          до 0
        </button>
      </div>
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
            {(itemLocations(item).length ? itemLocations(item) : ['Не указано']).map((location) => (
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
        <button onClick={(event) => { event.stopPropagation(); onDuplicate(); }} title="Дублировать">
          <PackagePlus size={17} />
        </button>
        <button onClick={(event) => { event.stopPropagation(); onQr(); }} title="QR-код позиции">
          <QrCode size={17} />
        </button>
        <button onClick={(event) => { event.stopPropagation(); onDelete(); }} title="Удалить">
          <Trash2 size={17} />
        </button>
      </div>
    </article>
  );
}
