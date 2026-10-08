import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Messages } from './en';
import { createFormat, type Format } from './format';
import { ru } from './ru';

// Language of the internal pages (admin, dashboard). The funnel itself follows its config's locale.

export type Lang = 'en' | 'ru';

const MESSAGES: Record<Lang, Messages> = { en, ru };
const STORAGE_KEY = 'funnel-runtime:internal-lang';

function readLang(): Lang {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Messages;
  f: Format;
}

const LangContext = createContext<LangState>({ lang: 'en', setLang: () => {}, t: en, f: createFormat('en', en) });

/** English by default; the choice is remembered in this browser. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode): the choice then lasts for this page only.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang, t: MESSAGES[lang], f: createFormat(lang, MESSAGES[lang]) }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/** Messages, formatters and the current language. */
export function useI18n(): LangState {
  return useContext(LangContext);
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t.nav.language}>
      {(['en', 'ru'] as const).map((option) => (
        <button key={option} type="button" aria-pressed={lang === option} onClick={() => setLang(option)}>
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** Links between the internal pages and the language switch. */
export function InternalNav({ current }: { current: 'admin' | 'dashboard' }) {
  const { t } = useI18n();
  return (
    <nav className="internal-nav" aria-label={t.nav.label}>
      <span className="internal-brand">Funnel Runtime</span>
      <a href="/admin" aria-current={current === 'admin' ? 'page' : undefined}>
        {t.nav.admin}
      </a>
      <a href="/dashboard" aria-current={current === 'dashboard' ? 'page' : undefined}>
        {t.nav.dashboard}
      </a>
      <LangSwitch />
    </nav>
  );
}
