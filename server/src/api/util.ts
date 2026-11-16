export const TZ = 'Asia/Tehran';

/** Name shown for a user (= a 9router api key): admin-chosen name, else the key's name in 9router. */
export const USER_NAME_SQL = (a: string) =>
  `COALESCE(NULLIF(${a}.display_name,''), NULLIF(${a}.hint,''), CASE WHEN ${a}.fingerprint='source' THEN 'کلید اصلی منبع' ELSE left(${a}.fingerprint, 14) END)`;

/** Tehran calendar day of a timestamptz column. */
export const DAY_SQL = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date`;

/** Helper calls of the client (auto-mode classifier, title, context compaction): not answers to a person. */
export const AUX_KINDS = ['classifier', 'title', 'compact'];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function ymdOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && YMD.test(v) ? v : fallback;
}

export function todayTehran(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d); // YYYY-MM-DD
}

export function intOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Collects positional parameters and WHERE fragments. */
export class Where {
  params: unknown[] = [];
  parts: string[] = [];
  add(sql: string, value: unknown): this {
    this.params.push(value);
    this.parts.push(sql.replace(/\?/g, `$${this.params.length}`));
    return this;
  }
  raw(sql: string): this {
    this.parts.push(sql);
    return this;
  }
  get sql(): string {
    return this.parts.length ? 'WHERE ' + this.parts.join(' AND ') : '';
  }
  /** Tehran-day range [from, to] inclusive on a timestamptz column. */
  range(col: string, from: string, to: string): this {
    this.params.push(from, to);
    const a = this.params.length - 1;
    const b = this.params.length;
    this.parts.push(`${col} >= ($${a}::date::timestamp AT TIME ZONE '${TZ}') AND ${col} < (($${b}::date + 1)::timestamp AT TIME ZONE '${TZ}')`);
    return this;
  }
}

const faDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit' });
/** `2026-10-26` -> `1405/08/04` */
export function shamsi(ymd: string): string {
  return faDay.format(new Date(ymd + 'T12:00:00Z'));
}
