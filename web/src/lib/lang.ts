export type Lang = 'fa' | 'en';

const KEY = 'pd-lang';

export function readLang(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'fa' || s === 'en') return s;
  } catch {
    /* private mode */
  }
  return 'en';
}

let current: Lang = readLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function subscribeLang(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const title = (l: Lang) => (l === 'fa' ? 'داشبورد پرامپت' : 'Prompt Dashboard');

export function applyLang(l: Lang) {
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr';
  document.title = title(l);
}

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  applyLang(l);
  listeners.forEach((fn) => fn());
}
