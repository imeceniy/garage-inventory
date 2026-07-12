import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeSearch, searchAliasesFor } from './search';

const target = (searchText: string, aliases: string[] = []) => ({ searchText, aliases });

describe('inventory search', () => {
  it('normalizes punctuation and the Russian letter yo', () => {
    expect(normalizeSearch('Крепёж: M4×20')).toBe('крепеж m4 20');
  });

  it('matches direct text across multiple query tokens', () => {
    expect(matchesSearch('винт m4', target('Винт M4x20, нержавейка'))).toBe(true);
  });

  it('matches known household synonyms', () => {
    expect(matchesSearch('шуруп', target('Саморез универсальный'))).toBe(true);
    expect(searchAliasesFor('кабель')).toContain('провод');
  });

  it('tolerates a small typo but rejects unrelated words', () => {
    expect(matchesSearch('батарека', target('Батарейка AA'))).toBe(true);
    expect(matchesSearch('гайка', target('Батарейка AA'))).toBe(false);
  });

  it('matches an empty query', () => {
    expect(matchesSearch('', target('Любая позиция'))).toBe(true);
  });
});
