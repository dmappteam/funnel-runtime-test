import type { Messages } from './en';
import type { Lang } from './i18n';

// Numbers and dates follow the interface language. Percentages carry one decimal.

const LOCALES: Record<Lang, string> = { en: 'en-AU', ru: 'ru-RU' };

export const DASH = '—';

export function createFormat(lang: Lang, t: Messages) {
  const locale = LOCALES[lang];
  const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const signedPercent = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  const signedDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const pValue = new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'medium' });

  return {
    count: (n: number) => count.format(n),
    percent: (value: number | null) => (value === null ? DASH : percent.format(value)),
    /** Relative change, e.g. "+12.4%". */
    lift: (value: number | null) => (value === null ? DASH : signedPercent.format(value)),
    /** A difference of two proportions in percentage points, e.g. "+2.3 p.p.". */
    pp: (value: number | null) => (value === null ? DASH : `${signedDecimal.format(value * 100)} ${t.units.pp}`),
    ppRange: (low: number | null, high: number | null) =>
      low === null || high === null ? DASH : t.units.ppRange(signedDecimal.format(low * 100), signedDecimal.format(high * 100)),
    interval: (low: number | null, high: number | null) =>
      low === null || high === null ? DASH : `${percent.format(low)}–${percent.format(high)}`,
    pValue: (p: number | null) => {
      if (p === null) return DASH;
      return p < 0.001 ? `< ${pValue.format(0.001)}` : pValue.format(p);
    },
    dateTime: (iso: string | null) => {
      if (!iso) return DASH;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
    },
    time: (iso: string) => time.format(new Date(iso)),
    /** Rough duration: whole days, else whole hours. */
    duration: (days: number) => {
      if (days >= 1) return t.units.days(Math.max(1, Math.round(days)));
      const hours = Math.round(days * 24);
      return hours >= 1 ? t.units.hours(hours) : t.units.underAnHour;
    },
  };
}

export type Format = ReturnType<typeof createFormat>;
