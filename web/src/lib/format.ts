// Dates: Shamsi (Tehran) in Persian, Gregorian in English. Numbers stay Latin so columns align.

import { getLang } from './lang';

const TZ = 'Asia/Tehran';
const faDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const faLong = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const faTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const faTimeSec = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const enDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const enLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const enWeekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

const d = (v: string | Date) => (v instanceof Date ? v : new Date(v));

export const shamsiDate = (v: string | Date) => faDate.format(d(v));
export const gregDate = (v: string | Date) => enDate.format(d(v));
export const timeOf = (v: string | Date, sec = false) => (sec ? faTimeSec : faTime).format(d(v));
export const longDay = (v: string | Date) => (getLang() === 'en' ? enWeekday : faLong).format(d(v));
/** The date the current language shows: Shamsi in Persian, Gregorian in English. */
export const uiDate = (v: string | Date) => (getLang() === 'en' ? enLong.format(d(v)) : shamsiDate(v));
/** `2026-10-26` (a Tehran calendar day) -> shamsi */
export const shamsiYmd = (ymd: string) => faDate.format(new Date(ymd + 'T12:00:00Z'));
export const uiYmd = (ymd: string) => (getLang() === 'en' ? ymd : shamsiYmd(ymd));
export const shortShamsiYmd = (ymd: string) => shamsiYmd(ymd).slice(5);
export const shortUiYmd = (ymd: string) => (getLang() === 'en' ? ymd.slice(5) : shortShamsiYmd(ymd));

const rtfFa = new Intl.RelativeTimeFormat('fa-u-nu-latn', { numeric: 'auto' });
const rtfEn = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relative(v: string | Date | null): string {
  if (!v) return '—';
  const s = (d(v).getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  const en = getLang() === 'en';
  if (a < 45) return en ? 'just now' : 'همین الان';
  const rtf = en ? rtfEn : rtfFa;
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

const nf = new Intl.NumberFormat('en-US');
export const int = (n: number | null | undefined) => (n == null ? '—' : nf.format(Math.round(n)));
export function compact(n: number | null | undefined): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}
export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** A gap between two moments in words: `۲ روز` / `2 days`. */
export function gapText(ms: number): string {
  const en = getLang() === 'en';
  const m = Math.round(ms / 60_000);
  if (m < 60) return en ? `${m} min` : `${m} دقیقه`;
  const h = Math.round(m / 60);
  if (h < 24) return en ? `${h} h` : `${h} ساعت`;
  const days = Math.round(h / 24);
  return en ? `${days} day${days === 1 ? '' : 's'}` : `${days} روز`;
}

export const totalTokens = (s: { input_tokens: number; output_tokens: number }) => s.input_tokens + s.output_tokens;

const WEEKDAYS_FA = [
  { v: 6, l: 'شنبه' },
  { v: 0, l: 'یکشنبه' },
  { v: 1, l: 'دوشنبه' },
  { v: 2, l: 'سه‌شنبه' },
  { v: 3, l: 'چهارشنبه' },
  { v: 4, l: 'پنجشنبه' },
  { v: 5, l: 'جمعه' },
];
const WEEKDAYS_EN = [
  { v: 6, l: 'Sat' },
  { v: 0, l: 'Sun' },
  { v: 1, l: 'Mon' },
  { v: 2, l: 'Tue' },
  { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' },
];
/** Saturday-first, matching the Iran week the schedules use. */
export const weekdays = () => (getLang() === 'en' ? WEEKDAYS_EN : WEEKDAYS_FA);
export const WEEKDAYS = WEEKDAYS_FA;

/** Short model label: `claude-opus-5-5` -> `Opus 5.5`. Unknown names pass through. */
export function modelLabel(m: string): string {
  const x = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(m);
  if (!x) return m || '—';
  const name = x[1][0].toUpperCase() + x[1].slice(1);
  return `${name} ${x[2]}${x[3] ? '.' + x[3] : ''}`;
}

export const todayYmd = () => gregDate(new Date());
export function addDays(ymd: string, n: number): string {
  const t = new Date(ymd + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const MONTHS_FA = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type CalParts = { y: number; m: number; d: number };

function calFmt(persian: boolean) {
  return new Intl.DateTimeFormat(persian ? 'en-u-ca-persian-nu-latn' : 'en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' });
}

/** Year/month/day in the calendar the UI language uses (Jalali in FA, Gregorian in EN). */
export function uiParts(v: string | Date, lang = getLang()): CalParts {
  const f = calFmt(lang !== 'en');
  const o: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of f.formatToParts(d(v instanceof Date ? v : v.includes('T') ? v : v + 'T12:00:00Z'))) {
    if (p.type !== 'literal') o[p.type] = p.value;
  }
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day) };
}

export function uiMonthTitle(y: number, m: number, lang = getLang()) {
  return `${(lang === 'en' ? MONTHS_EN : MONTHS_FA)[m - 1]} ${y}`;
}

const WEEKDAYS_EN_SUN = [
  { v: 0, l: 'Sun' },
  { v: 1, l: 'Mon' },
  { v: 2, l: 'Tue' },
  { v: 3, l: 'Wed' },
  { v: 4, l: 'Thu' },
  { v: 5, l: 'Fri' },
  { v: 6, l: 'Sat' },
];

export function weekdayHeaders(lang = getLang()) {
  return lang === 'en' ? WEEKDAYS_EN_SUN : WEEKDAYS_FA;
}

/** Gregorian `YYYY-MM-DD` (Tehran day) for a Jalali or Gregorian Y/M/D. */
export function ymdFromUiParts(y: number, m: number, day: number, lang = getLang()): string {
  const persian = lang !== 'en';
  let t = Date.parse(`${(persian ? y + 621 : y).toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(day, 28)).padStart(2, '0')}T12:00:00Z`);
  for (let i = 0; i < 10; i++) {
    const p = uiParts(new Date(t), lang);
    const delta = (y - p.y) * 400 + (m - p.m) * 32 + (day - p.d);
    if (delta === 0) return gregDate(new Date(t));
    t += delta * 86_400_000;
  }
  return gregDate(new Date(t));
}

export function daysInUiMonth(y: number, m: number, lang = getLang()) {
  const next = m === 12 ? ymdFromUiParts(y + 1, 1, 1, lang) : ymdFromUiParts(y, m + 1, 1, lang);
  return uiParts(addDays(next, -1), lang).d;
}

export function shiftUiMonth(y: number, m: number, delta: number) {
  let mm = m + delta;
  let yy = y;
  while (mm < 1) {
    mm += 12;
    yy -= 1;
  }
  while (mm > 12) {
    mm -= 12;
    yy += 1;
  }
  return { y: yy, m: mm };
}
