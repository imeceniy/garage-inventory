import { Boxes, ClipboardCheck, FolderKanban, PackageSearch, ShoppingCart } from 'lucide-react';
import type { AppSection } from '../domain/types';

type AppNavigationProps = {
  active: AppSection;
  lowCount: number;
  onChange: (section: AppSection) => void;
};

const entries = [
  { id: 'stock' as const, label: 'Запасы', icon: PackageSearch },
  { id: 'containers' as const, label: 'Контейнеры', icon: Boxes },
  { id: 'projects' as const, label: 'Проекты', icon: FolderKanban },
  { id: 'inventory' as const, label: 'Проверка', icon: ClipboardCheck },
  { id: 'shopping' as const, label: 'Покупки', icon: ShoppingCart }
];

export function AppNavigation({ active, lowCount, onChange }: AppNavigationProps) {
  return (
    <nav className="app-navigation" aria-label="Разделы склада">
      <div className="navigation-brand">
        <Boxes size={25} />
        <span>
          <strong>Гараж</strong>
          <small>домашний склад</small>
        </span>
      </div>
      <div className="navigation-list">
        {entries.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={active === id ? 'active' : ''}
            aria-current={active === id ? 'page' : undefined}
            onClick={() => onChange(id)}
          >
            <Icon size={19} />
            <span>{label}</span>
            {id === 'shopping' && lowCount > 0 && <b>{lowCount}</b>}
          </button>
        ))}
      </div>
    </nav>
  );
}
