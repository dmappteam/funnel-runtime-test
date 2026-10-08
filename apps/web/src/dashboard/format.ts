// Locale-aware formatting. Percentages always carry one decimal.

const count = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signedPercent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});
const signedDecimal = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});
const pValue = new Intl.NumberFormat(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

export const DASH = '—';

export function formatCount(n: number): string {
  return count.format(n);
}

export function formatPercent(value: number | null): string {
  return value === null ? DASH : percent.format(value);
}

/** Relative change, e.g. "+12.4%". */
export function formatLift(value: number | null): string {
  return value === null ? DASH : signedPercent.format(value);
}

/** A difference of two proportions in percentage points, e.g. "+2.3 p.p.". */
export function formatPp(value: number | null): string {
  return value === null ? DASH : `${signedDecimal.format(value * 100)} p.p.`;
}

export function formatPpRange(low: number | null, high: number | null): string {
  if (low === null || high === null) return DASH;
  return `${signedDecimal.format(low * 100)} to ${signedDecimal.format(high * 100)} p.p.`;
}

export function formatInterval(low: number | null, high: number | null): string {
  return low === null || high === null ? DASH : `${percent.format(low)}–${percent.format(high)}`;
}

export function formatPValue(p: number | null): string {
  if (p === null) return DASH;
  return p < 0.001 ? `< ${pValue.format(0.001)}` : pValue.format(p);
}

export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : DASH;
}

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}
