import clsx from 'clsx';
import { useSyncExternalStore } from 'react';
import { applyLang, getLang, Lang, setLang, subscribeLang } from './lang';

applyLang(getLang());

export function useI18n() {
  const lang = useSyncExternalStore(subscribeLang, getLang, () => 'en' as Lang);
  const t = (fa: string, en: string) => (lang === 'en' ? en : fa);
  return { lang, setLang, t };
}

/** FA / EN. The choice is remembered on this browser. */
export function LangSwitch() {
  const { lang, setLang: set } = useI18n();
  return (
    <div className="inline-flex shrink-0 p-0.5 rounded-lg border border-line bg-surface-2" role="group" aria-label={lang === 'en' ? 'Language' : 'زبان'}>
      {(['fa', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => set(l)}
          className={clsx('h-7 min-w-8 px-2 rounded-md text-[12px] font-semibold border-0 cursor-pointer', lang === l ? 'bg-surface text-ink' : 'bg-transparent text-ink-3')}
        >
          {l === 'fa' ? 'فا' : 'EN'}
        </button>
      ))}
    </div>
  );
}
