import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { daysInUiMonth, gregDate, shiftUiMonth, uiMonthTitle, uiParts, uiYmd, weekdayHeaders, ymdFromUiParts } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { cx } from './ui';

/** Date button + month grid. FA = Jalali, EN = Gregorian. Value stored as Tehran `YYYY-MM-DD`. */
export function DateField({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: string;
  min?: string;
  max?: string;
  onChange: (ymd: string) => void;
  label: string;
}) {
  const { lang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = uiParts(value, lang);
  const [{ y, m }, setMonth] = useState({ y: selected.y, m: selected.m });
  useEffect(() => {
    if (open) setMonth({ y: selected.y, m: selected.m });
  }, [open, selected.y, selected.m]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const heads = weekdayHeaders(lang);
  const firstYmd = ymdFromUiParts(y, m, 1, lang);
  const firstDow = new Date(firstYmd + 'T12:00:00Z').getUTCDay();
  const lead = lang === 'en' ? firstDow : (firstDow + 1) % 7;
  const count = daysInUiMonth(y, m, lang);
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);

  return (
    <div className="relative" ref={root}>
      <button type="button" className="input !w-[158px] num text-start" aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {uiYmd(value)}
      </button>
      {open && (
        <div className="absolute z-30 top-[calc(100%+6px)] start-0 w-[252px] card p-2.5 shadow-lg" role="dialog" aria-label={label}>
          <div className="flex items-center justify-between mb-2">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('ماه قبل', 'Previous month')} onClick={() => setMonth((c) => shiftUiMonth(c.y, c.m, -1))}>
              {lang === 'fa' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
            <div className="text-[13px] font-bold">{uiMonthTitle(y, m, lang)}</div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('ماه بعد', 'Next month')} onClick={() => setMonth((c) => shiftUiMonth(c.y, c.m, 1))}>
              {lang === 'fa' ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10.5px] text-ink-3 mb-1">
            {heads.map((h) => (
              <div key={h.v}>{h.l}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => {
              if (!day) return <div key={i} />;
              const ymd = ymdFromUiParts(y, m, day, lang);
              const disabled = !!(min && ymd < min) || !!(max && ymd > max);
              const on = ymd === value;
              const today = ymd === gregDate(new Date());
              return (
                <button
                  key={ymd}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange(ymd);
                    setOpen(false);
                  }}
                  className={cx(
                    'h-8 rounded-md text-[12.5px] num border-0 cursor-pointer',
                    on ? 'bg-accent text-white font-bold' : today ? 'bg-accent-soft text-accent' : 'bg-transparent text-ink hover:bg-surface-2',
                    disabled && 'opacity-30 cursor-not-allowed hover:bg-transparent',
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
