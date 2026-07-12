export type SearchableItem = {
  searchText: string;
  aliases: string[];
};

const searchAliases: Record<string, string[]> = {
  винт: ['болт', 'шуруп', 'саморез', 'крепеж', 'крепёж'],
  болт: ['винт', 'крепеж', 'крепёж'],
  шуруп: ['саморез', 'винт', 'крепеж', 'крепёж'],
  саморез: ['шуруп', 'винт', 'крепеж', 'крепёж'],
  гайка: ['крепеж', 'крепёж'],
  шайба: ['крепеж', 'крепёж'],
  батарейка: ['аккумулятор', 'элемент', 'питание'],
  аккумулятор: ['батарейка', 'акб', 'питание'],
  провод: ['кабель', 'электрика'],
  кабель: ['провод', 'электрика'],
  изолента: ['лента', 'изоляция', 'электрика'],
  стяжка: ['хомут', 'хомуты'],
  хомут: ['стяжка', 'стяжки'],
  клей: ['герметик', 'химия'],
  сопло: ['nozzle', '3d', 'принтер'],
  филамент: ['пластик', 'pla', 'petg', 'abs', '3d', 'принтер']
};

export function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

export function searchTokens(value: string) {
  return normalizeSearch(value).split(/\s+/).filter(Boolean);
}

export function searchAliasesFor(value: string) {
  return searchTokens(value).flatMap((token) => searchAliases[token] || []);
}

function expandSearchToken(token: string) {
  const normalized = normalizeSearch(token);
  return [normalized, ...(searchAliases[normalized] || [])];
}

function isFuzzyMatch(needle: string, candidate: string) {
  if (needle.length < 4 || candidate.length < 4) return false;
  if (candidate.includes(needle) || needle.includes(candidate)) return true;
  if (Math.abs(needle.length - candidate.length) > 2) return false;

  const limit = needle.length <= 6 ? 1 : 2;
  const previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  for (let i = 1; i <= needle.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= candidate.length; j += 1) {
      const cost = needle[i - 1] === candidate[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return false;
    previous.splice(0, previous.length, ...current);
  }
  return previous[candidate.length] <= limit;
}

export function matchesSearch(queryText: string, target: SearchableItem) {
  const tokens = searchTokens(queryText);
  if (!tokens.length) return true;
  const haystack = normalizeSearch(target.searchText);
  const haystackTokens = searchTokens(`${target.searchText} ${target.aliases.join(' ')}`);

  return tokens.every((token) => {
    const variants = expandSearchToken(token);
    return variants.some(
      (variant) => haystack.includes(variant) || haystackTokens.some((candidate) => isFuzzyMatch(variant, candidate))
    );
  });
}
