import { useId, useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import type { MetaType } from '../domain/types';
import { mergeDelimitedValues, parseDelimitedList } from '../lib/inventory';

type MultiValueFieldProps = {
  label: string;
  values: string[];
  suggestions: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
};

export function MultiValueField({ label, values, suggestions, placeholder, onChange }: MultiValueFieldProps) {
  const [entry, setEntry] = useState('');
  const listId = useId();
  const availableSuggestions = suggestions.filter((suggestion) => !values.includes(suggestion));

  function addValue(value = entry) {
    onChange(mergeDelimitedValues(values, value));
    setEntry('');
  }

  return (
    <label className="multi-value-field">
      {label}
      <span className="chip-input-row">
        <input
          list={listId}
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onBlur={() => addValue()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
              event.preventDefault();
              addValue();
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (parseDelimitedList(pasted).length > 1) {
              event.preventDefault();
              addValue(pasted);
            }
          }}
          placeholder={placeholder}
        />
        <button type="button" onClick={() => addValue()} title="Добавить">
          <Plus size={17} />
        </button>
      </span>
      <datalist id={listId}>
        {availableSuggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      {values.length > 0 && (
        <span className="editable-chip-list">
          {values.map((value) => (
            <button key={value} type="button" onClick={() => onChange(values.filter((entryValue) => entryValue !== value))} title="Удалить">
              {value}
              <X size={14} />
            </button>
          ))}
        </span>
      )}
    </label>
  );
}

type MetaEditorProps = {
  title: string;
  type: MetaType;
  values: string[];
  onRename: (type: MetaType, from: string, to: string) => Promise<void>;
  onDelete: (type: MetaType, value: string) => Promise<void>;
};

export function MetaEditor({ title, type, values, onRename, onDelete }: MetaEditorProps) {
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
    if (!window.confirm(`Удалить "${value}" из всех позиций?`)) return;
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
              <input value={drafts[value] ?? value} onChange={(event) => setDrafts((current) => ({ ...current, [value]: event.target.value }))} />
              <button disabled={busyValue === value || (drafts[value] ?? value) === value} onClick={() => save(value)} title="Сохранить">
                <Check size={16} />
              </button>
              <button disabled={busyValue === value} onClick={() => remove(value)} title="Удалить">
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
