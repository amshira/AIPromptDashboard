import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compact, int, shortUiYmd, uiYmd } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** Categorical slots in the fixed validated order. A 9th entity folds into "Other". */
export const SERIES_VARS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'];
export const OTHER = 'سایر';
const MAX_SERIES = SERIES_VARS.length;

export interface SeriesPlan {
  keys: string[]; // legend order == color order
  color: (key: string) => string;
  fold: (key: string) => string;
}

/**
 * Pick the biggest entities, then give them colors by *name order* so a color follows the entity
 * (not its rank) when the filter changes which ones are on screen.
 */
export function planSeries(totals: Map<string, number>, stable: string[] = []): SeriesPlan {
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const hasOther = ranked.length > MAX_SERIES;
  const top = new Set(hasOther ? ranked.slice(0, MAX_SERIES - 1) : ranked);
  // `stable` is the global entity order (e.g. sources by id): its slot is the entity's color.
  const slot = new Map<string, number>();
  stable.forEach((k, i) => i < MAX_SERIES && slot.set(k, i));
  const used = new Set(slot.values());
  let free = 0;
  for (const k of [...top].sort((a, b) => a.localeCompare(b))) {
    if (slot.has(k)) continue;
    while (used.has(free)) free++;
    slot.set(k, free % MAX_SERIES);
    used.add(free);
  }
  const keys = [...top].sort((a, b) => slot.get(a)! - slot.get(b)!);
  if (hasOther) keys.push(OTHER);
  return {
    keys,
    color: (k) => (k === OTHER || !slot.has(k) ? 'var(--ink-3)' : `var(${SERIES_VARS[slot.get(k)!]})`),
    fold: (k) => (top.has(k) ? k : OTHER),
  };
}

export function Legend({ keys, color, label }: { keys: string[]; color: (k: string) => string; label?: (k: string) => string }) {
  const { t } = useI18n();
  const name = (k: string) => (k === OTHER ? t('سایر', 'Other') : label ? label(k) : k);
  if (keys.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 m-0 p-0 list-none text-[12.5px] text-ink-2" aria-label={t('راهنما', 'Legend')}>
      {keys.map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[3px]" style={{ background: color(k) }} />
          <span className="ltr">{name(k)}</span>
        </li>
      ))}
    </ul>
  );
}

interface DayDatum {
  day: string;
  [k: string]: number | string;
}

/** Stacked daily bars. `rows` are already folded to the plan's keys. */
export function StackedDaily({ data, plan, unit, label }: { data: DayDatum[]; plan: SeriesPlan; unit: string; label?: (k: string) => string }) {
  const { t } = useI18n();
  const name = (k: string) => (k === OTHER ? t('سایر', 'Other') : label ? label(k) : k);
  const ticks = useMemo(() => {
    const step = Math.ceil(data.length / 8);
    return data.filter((_, i) => i % step === 0).map((d) => d.day);
  }, [data]);
  return (
    <div className="ltr" style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis dataKey="day" ticks={ticks} tickFormatter={(d: string) => shortUiYmd(d)} tickLine={false} axisLine={{ stroke: 'var(--axis)' }} interval={0} />
          <YAxis tickFormatter={(v: number) => compact(v)} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload, label: day }) => {
              if (!active || !payload?.length) return null;
              const rows = payload.filter((p) => Number(p.value) > 0).reverse();
              const total = rows.reduce((s, p) => s + Number(p.value), 0);
              return (
                <div className="card px-3 py-2 text-[12.5px] min-w-[190px]">
                  <div className="font-semibold mb-1">
                    {uiYmd(String(day))} <span className="text-ink-3 font-normal text-[11px] num">{String(day)}</span>
                  </div>
                  {rows.map((p) => (
                    <div key={String(p.dataKey)} className="flex items-center gap-2 py-[1px]">
                      <span className="inline-block size-2.5 rounded-[3px]" style={{ background: p.color }} />
                      <span className="grow ltr text-ink-2">{name(String(p.dataKey))}</span>
                      <span className="num">{int(Number(p.value))}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-line mt-1 pt-1 font-semibold">
                    <span>{t('جمع', 'Total')} ({unit})</span>
                    <span className="num">{int(total)}</span>
                  </div>
                </div>
              );
            }}
          />
          {plan.keys.map((k) => (
            <Bar key={k} dataKey={k} stackId="a" fill={plan.color(k)} stroke="var(--surface)" strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Single-hue horizontal share bars (one series, so no legend; value labels at the end). */
export function ShareBars({ rows, color = 'var(--s1)' }: { rows: { key: string; label: string; value: number; hint?: string }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.key} title={r.hint}>
          <div className="flex items-baseline justify-between gap-3 text-[12.5px] mb-1">
            <span className="ltr font-medium truncate">{r.label}</span>
            <span className="num text-ink-2 shrink-0">
              {compact(r.value)} <span className="text-ink-3">· {Math.round((r.value / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden" dir="ltr">
            <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
