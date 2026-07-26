import { useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Camera,
  Copy,
  MapPin,
  Minus,
  MoreVertical,
  PackagePlus,
  Plus,
  QrCode,
  Trash2
} from 'lucide-react';
import type { Container, Item } from '../domain/types';
import { formatNumber } from '../lib/format';
import { thumbnailUrl } from '../lib/image';

type ItemCardProps = {
  item: Item;
  container?: Container;
  packageValue: number;
  onAdjust: (amount: number) => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onQr: () => void;
  onDelete: () => void;
};

export function ItemCard({
  item,
  container,
  packageValue,
  onAdjust,
  onOpen,
  onDuplicate,
  onQr,
  onDelete
}: ItemCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const low = item.quantity <= item.reorderPoint && item.quantity < item.targetQuantity;
  const primaryBalance = item.balances.find((balance) => balance.id === item.defaultBalanceId) || item.balances[0];
  const place = container?.name || primaryBalance?.location || 'Место не указано';

  return (
    <article className={low ? 'item-card low' : 'item-card'}>
      <button className="item-card-open" type="button" onClick={onOpen} aria-label={`Открыть ${item.name}`}>
        {item.photo ? (
          <img
            className="item-photo"
            src={thumbnailUrl(item.photo)}
            alt=""
            onError={(event) => {
              if (event.currentTarget.src !== item.photo) event.currentTarget.src = item.photo;
            }}
          />
        ) : (
          <span className="item-photo placeholder" aria-hidden="true">
            <Camera size={26} />
          </span>
        )}
        <span className="item-card-copy">
          <span className="item-card-title-row">
            <strong>{item.name}</strong>
            {low && <AlertTriangle size={17} className="low-icon" aria-label="Нужно пополнить" />}
          </span>
          <span className="item-location">
            {container ? <Boxes size={15} /> : <MapPin size={15} />}
            {place}
          </span>
          <span className="item-context">
            {item.category}
            {item.projects[0] ? ` · ${item.projects[0]}` : ''}
          </span>
        </span>
      </button>

      <div className="item-stock-row">
        <button type="button" onClick={() => onAdjust(-1)} disabled={item.quantity <= 0} title="Списать одну">
          <Minus size={19} />
        </button>
        <button className="item-stock-value" type="button" onClick={onOpen}>
          <strong>{formatNumber(item.quantity)}</strong>
          <span>{item.unit}</span>
        </button>
        <button type="button" onClick={() => onAdjust(1)} title="Добавить одну">
          <Plus size={19} />
        </button>
      </div>

      <div className="item-card-footer">
        <span className={low ? 'stock-state low' : 'stock-state'}>
          {low
            ? `Пополнить на ${formatNumber(Math.max(0, item.targetQuantity - item.quantity))} ${item.unit}`
            : `${item.balances.length} ${item.balances.length === 1 ? 'место' : 'места'}`}
        </span>
        <div className="item-menu">
          <button
            type="button"
            className="icon-button"
            aria-expanded={menuOpen}
            aria-label="Действия с позицией"
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div className="item-menu-popover">
              <button type="button" onClick={() => { onAdjust(packageValue); setMenuOpen(false); }}>
                <PackagePlus size={17} /> Добавить упаковку
              </button>
              <button type="button" onClick={() => { onQr(); setMenuOpen(false); }}>
                <QrCode size={17} /> QR-код
              </button>
              <button type="button" onClick={() => { onDuplicate(); setMenuOpen(false); }}>
                <Copy size={17} /> Дублировать
              </button>
              <button className="danger-action" type="button" onClick={() => { onDelete(); setMenuOpen(false); }}>
                <Trash2 size={17} /> Удалить
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
