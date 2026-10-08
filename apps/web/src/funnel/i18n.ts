/** UI chrome only. Everything the user answers or reads about the funnel itself comes from the config. */
export interface Strings {
  back: string;
  continue: string;
  stepOf: (index: number, total: number) => string;
  progress: string;
  selectedOf: (count: number, max: number) => string;
  selected: (count: number) => string;
  range: (min: number, max: number) => string;
  /** The config's unit next to the entered value. */
  unit: (unit: string, value: number | null) => string;
  decrease: string;
  increase: string;
  resultLoading: string;
  resultError: string;
  resultErrorHint: string;
  retry: string;
  loadErrorTitle: string;
  loadErrorHint: string;
  loading: string;
  sessionExpired: string;
  progressSynced: string;
  dismiss: string;
}

/** Configs give units in the plural ("hours", "people"); a value of 1 reads "1 hour", "1 person". */
function singular(unit: string): string {
  if (unit === 'people') return 'person';
  if (unit.endsWith('ies')) return `${unit.slice(0, -3)}y`;
  if (/[^s]s$/.test(unit)) return unit.slice(0, -1);
  return unit;
}

const en: Strings = {
  back: 'Back',
  continue: 'Continue',
  stepOf: (index, total) => `Step ${index} of ${total}`,
  progress: 'Progress',
  selectedOf: (count, max) => `${count} of ${max} selected`,
  selected: (count) => `${count} selected`,
  range: (min, max) => `From ${min} to ${max}`,
  unit: (unit, value) => (value === 1 ? singular(unit) : unit),
  decrease: 'Decrease',
  increase: 'Increase',
  resultLoading: 'Preparing your result…',
  resultError: 'We could not prepare your result',
  resultErrorHint: 'Check your connection and try again.',
  retry: 'Try again',
  loadErrorTitle: 'We could not load this page',
  loadErrorHint: 'Check your connection and try again.',
  loading: 'Loading',
  sessionExpired: 'Your previous session expired, so we started a new one.',
  progressSynced: 'Your progress was updated from another tab.',
  dismiss: 'Dismiss',
};

const ru: Strings = {
  back: 'Назад',
  continue: 'Продолжить',
  stepOf: (index, total) => `Шаг ${index} из ${total}`,
  progress: 'Прогресс',
  selectedOf: (count, max) => `Выбрано ${count} из ${max}`,
  selected: (count) => `Выбрано: ${count}`,
  range: (min, max) => `От ${min} до ${max}`,
  unit: (unit) => unit,
  decrease: 'Уменьшить',
  increase: 'Увеличить',
  resultLoading: 'Готовим результат…',
  resultError: 'Не удалось подготовить результат',
  resultErrorHint: 'Проверьте подключение и попробуйте ещё раз.',
  retry: 'Повторить',
  loadErrorTitle: 'Не удалось загрузить страницу',
  loadErrorHint: 'Проверьте подключение и попробуйте ещё раз.',
  loading: 'Загрузка',
  sessionExpired: 'Предыдущая сессия истекла, поэтому мы начали новую.',
  progressSynced: 'Прогресс обновлён из другой вкладки.',
  dismiss: 'Закрыть',
};

const dictionaries: Record<string, Strings> = { en, ru };

/** Exact tag, then its language (`en-AU` → `en`), then English. */
export function getStrings(locale: string | null | undefined): Strings {
  const tag = (locale ?? '').toLowerCase();
  return dictionaries[tag] ?? dictionaries[tag.split('-')[0] ?? ''] ?? en;
}
