import { useMemo, useState } from 'react';
import { ArrowRight, Check, Plus, Trash2 } from 'lucide-react';
import type { Container, Item, StockBalance } from '../domain/types';
import { formatNumber } from '../lib/format';

type BalanceInput = { containerId: string; location: string; quantity: number };

type StockBalanceEditorProps = {
  item: Item;
  containers: Container[];
  onCreate: (input: BalanceInput) => Promise<void>;
  onUpdate: (balanceId: string, input: BalanceInput) => Promise<void>;
  onTransfer: (fromBalanceId: string, toBalanceId: string, amount: number) => Promise<void>;
  onDelete: (balanceId: string) => Promise<void>;
};

function balanceLabel(balance: StockBalance, containers: Container[]) {
  const container = containers.find((entry) => entry.id === balance.containerId);
  return container?.name || balance.location || 'Без места';
}

export function StockBalanceEditor({ item, containers, onCreate, onUpdate, onTransfer, onDelete }: StockBalanceEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, BalanceInput>>({});
  const [newBalance, setNewBalance] = useState<BalanceInput>({ containerId: '', location: '', quantity: 0 });
  const [transfer, setTransfer] = useState({ fromBalanceId: '', toBalanceId: '', amount: 1 });
  const [busy, setBusy] = useState(false);

  const effectiveTransfer = useMemo(() => {
    const fromBalanceId = transfer.fromBalanceId || item.balances.find((balance) => balance.quantity > 0)?.id || '';
    const requestedTarget = item.balances.find((balance) => balance.id === transfer.toBalanceId && balance.id !== fromBalanceId)?.id;
    const toBalanceId = requestedTarget || item.balances.find((balance) => balance.id !== fromBalanceId)?.id || '';
    return { ...transfer, fromBalanceId, toBalanceId };
  }, [item.balances, transfer]);

  function draftFor(balance: StockBalance) {
    return drafts[balance.id] || { containerId: balance.containerId, location: balance.location, quantity: balance.quantity };
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stock-balance-editor">
      <div className="stock-balance-heading">
        <h3>Распределение остатка</h3>
        <strong>{formatNumber(item.quantity)} {item.unit}</strong>
      </div>

      <div className="stock-balance-list">
        {item.balances.map((balance) => {
          const draft = draftFor(balance);
          return (
            <div className="stock-balance-row" key={balance.id}>
              <select value={draft.containerId} onChange={(event) => setDrafts((current) => ({ ...current, [balance.id]: { ...draft, containerId: event.target.value } }))}>
                <option value="">Без контейнера</option>
                {containers.map((container) => <option key={container.id} value={container.id}>{container.name}</option>)}
              </select>
              <input value={draft.location} onChange={(event) => setDrafts((current) => ({ ...current, [balance.id]: { ...draft, location: event.target.value } }))} placeholder="Место" />
              <input min="0" step="0.01" type="number" value={draft.quantity} onChange={(event) => setDrafts((current) => ({ ...current, [balance.id]: { ...draft, quantity: Number(event.target.value) || 0 } }))} />
              <span>{item.unit}</span>
              <button type="button" disabled={busy} onClick={() => run(() => onUpdate(balance.id, draft))} title="Сохранить">
                <Check size={16} />
              </button>
              <button type="button" disabled={busy || balance.quantity > 0} onClick={() => run(() => onDelete(balance.id))} title="Удалить пустое место">
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="stock-balance-row stock-balance-create">
        <select value={newBalance.containerId} onChange={(event) => setNewBalance({ ...newBalance, containerId: event.target.value })}>
          <option value="">Без контейнера</option>
          {containers.map((container) => <option key={container.id} value={container.id}>{container.name}</option>)}
        </select>
        <input value={newBalance.location} onChange={(event) => setNewBalance({ ...newBalance, location: event.target.value })} placeholder="Новое место" />
        <input min="0" step="0.01" type="number" value={newBalance.quantity} onChange={(event) => setNewBalance({ ...newBalance, quantity: Number(event.target.value) || 0 })} />
        <span>{item.unit}</span>
        <button type="button" disabled={busy || (!newBalance.containerId && !newBalance.location)} onClick={() => run(async () => { await onCreate(newBalance); setNewBalance({ containerId: '', location: '', quantity: 0 }); })} title="Добавить место">
          <Plus size={16} />
        </button>
      </div>

      {item.balances.length >= 2 && (
        <div className="stock-transfer-row">
          <select value={effectiveTransfer.fromBalanceId} onChange={(event) => setTransfer({ ...effectiveTransfer, fromBalanceId: event.target.value })}>
            {item.balances.map((balance) => <option key={balance.id} value={balance.id}>{balanceLabel(balance, containers)} · {formatNumber(balance.quantity)}</option>)}
          </select>
          <ArrowRight size={17} />
          <select value={effectiveTransfer.toBalanceId} onChange={(event) => setTransfer({ ...effectiveTransfer, toBalanceId: event.target.value })}>
            {item.balances.filter((balance) => balance.id !== effectiveTransfer.fromBalanceId).map((balance) => <option key={balance.id} value={balance.id}>{balanceLabel(balance, containers)}</option>)}
          </select>
          <input min="0.01" step="0.01" type="number" value={effectiveTransfer.amount} onChange={(event) => setTransfer({ ...effectiveTransfer, amount: Number(event.target.value) || 0 })} />
          <button type="button" disabled={busy || !effectiveTransfer.fromBalanceId || !effectiveTransfer.toBalanceId || effectiveTransfer.amount <= 0} onClick={() => run(() => onTransfer(effectiveTransfer.fromBalanceId, effectiveTransfer.toBalanceId, effectiveTransfer.amount))}>
            Переместить
          </button>
        </div>
      )}
    </section>
  );
}
