import { useState } from 'react';
import { Check, Plus, QrCode, Trash2 } from 'lucide-react';
import type { Container } from '../domain/types';

type ContainerEditorProps = {
  containers: Container[];
  onSave: (container: Partial<Container>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onQr: (container: Container) => void;
};

export function ContainerEditor({ containers, onSave, onDelete, onQr }: ContainerEditorProps) {
  const [draft, setDraft] = useState<Partial<Container>>({ name: '', location: '', note: '' });
  const [busy, setBusy] = useState(false);

  async function save(container: Partial<Container>) {
    setBusy(true);
    try {
      await onSave(container);
      if (!container.id) setDraft({ name: '', location: '', note: '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="container-editor">
      <div className="container-create">
        <input value={draft.name || ''} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Ящик с крепежом" />
        <input value={draft.location || ''} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} placeholder="Гараж, стеллаж 1" />
        <button className="primary-button" disabled={busy || !draft.name} onClick={() => save(draft)}>
          <Plus size={18} />
          Добавить
        </button>
      </div>
      <div className="container-list">
        {containers.map((container) => (
          <ContainerRow key={container.id} container={container} busy={busy} onSave={save} onDelete={onDelete} onQr={onQr} />
        ))}
      </div>
    </section>
  );
}

type ContainerRowProps = {
  container: Container;
  busy: boolean;
  onSave: (container: Partial<Container>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onQr: (container: Container) => void;
};

function ContainerRow({ container, busy, onSave, onDelete, onQr }: ContainerRowProps) {
  const [draft, setDraft] = useState(container);

  return (
    <div className="container-row">
      <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} />
      <input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Заметка" />
      <div>
        <button disabled={busy} onClick={() => onSave(draft)} title="Сохранить">
          <Check size={16} />
        </button>
        <button onClick={() => onQr(container)} title="QR-код">
          <QrCode size={16} />
        </button>
        <button disabled={busy} onClick={() => onDelete(container.id)} title="Удалить">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
