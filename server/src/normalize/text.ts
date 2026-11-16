// Text clean-up shared by the whole ingest pipeline: encoding repair, Persian
// normalisation and a "search fold" used for the full-text/ILIKE index.

const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

// UTF-8 lead bytes of Arabic/Persian (D8-DB) or of general punctuation (E2) /
// Latin-1 supplement (C3, C2) seen through a latin1/cp1252 lens.
const MOJIBAKE_RE = /[ØÙÚÛÃÂâ][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Undo "UTF-8 bytes decoded as latin1/cp1252" (e.g. `Ø³Ù„Ø§Ù…` -> `سلام`). */
export function fixMojibake(s: string): string {
  if (!MOJIBAKE_RE.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x100) bytes.push(cp);
    else if (CP1252_EXTRA[cp] !== undefined) bytes.push(CP1252_EXTRA[cp]);
    else return s; // contains a real non-latin character -> text is not mojibake
  }
  try {
    const out = decoder.decode(Uint8Array.from(bytes));
    return out.length < s.length ? out : s;
  } catch {
    return s;
  }
}

/** Decode literal `\uXXXX` sequences that survived a double JSON encoding. */
export function decodeEscapes(s: string): string {
  const matches = s.match(/\\u[0-9a-fA-F]{4}/g);
  if (!matches || matches.length < 2) return s;
  // Only when the text has no real non-ASCII chars, otherwise it is probably a code sample.
  if (/[^\x00-\x7f]/.test(s)) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩﻿]/g;

/** Persian-safe normalisation that keeps digits and ZWNJ intact. */
export function normalizePersian(s: string): string {
  return s
    .replace(/ي/g, 'ی') // ي -> ی
    .replace(/ك/g, 'ک') // ك -> ک
    .replace(/ى/g, 'ی') // ى -> ی
    .replace(/ـ/g, ''); // tatweel
}

export function cleanText(input: string): string {
  let s = input;
  s = decodeEscapes(s);
  s = fixMojibake(s);
  s = s.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  s = normalizePersian(s);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore */
  }
  return s;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Folding used for search: ASCII digits, no ZWNJ, lower-case, single spaces. */
export function searchFold(input: string): string {
  let s = normalizePersian(input).toLowerCase();
  s = s.replace(/[۰-۹٠-٩]/g, (d) => {
    const i = FA_DIGITS.indexOf(d);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(d));
  });
  s = s.replace(/[‌‍]/g, '').replace(/[ً-ْ]/g, '').replace(/\s+/g, ' ');
  return s.trim();
}

/** Dominant text direction of a string, used for server-side hints and tests. */
export function detectDir(s: string): 'rtl' | 'ltr' {
  for (const ch of s) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(ch)) return 'rtl';
    if (/[A-Za-z]/.test(ch)) return 'ltr';
  }
  return 'ltr';
}
