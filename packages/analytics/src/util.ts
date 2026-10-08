/** Locale-independent ascending order, so reports never depend on the runtime's collation. */
export function compare<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders by position in `order`; values missing from it follow, alphabetically. */
export function listOrder(order: readonly string[]): (a: string, b: string) => number {
  const rank = (value: string) => {
    const i = order.indexOf(value);
    return i === -1 ? order.length : i;
  };
  return (a, b) => rank(a) - rank(b) || compare(a, b);
}

/** Groups in first-seen key order. */
export function groupBy<K, T>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
