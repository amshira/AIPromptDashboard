import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, Meta } from '../lib/api';
import { DateField } from './DateField';
import { addDays, gregDate, modelLabel, todayYmd, uiYmd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Segmented } from './ui';

export interface Range {
  from: string;
  to: string;
  preset: string;
}

const presetLabel = (v: string, t: (fa: string, en: string) => string) =>
  ({ '1': t('امروز', 'Today'), '7': t('۷ روز', '7 days'), '30': t('۳۰ روز', '30 days'), '90': t('۹۰ روز', '90 days'), custom: t('دلخواه', 'Custom') })[v] ?? v;

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => get<Meta>('/api/meta'), staleTime: 60_000 });
}

/** Filters live in the URL so any view can be shared or bookmarked. */
export function useFilters(defaultDays = 7) {
  const [sp, setSp] = useSearchParams();
  const today = todayYmd();
  const to = sp.get('to') || today;
  const rawFrom = sp.get('from');
  const from = rawFrom || addDays(to, -(defaultDays - 1));
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const preset = !rawFrom && !sp.get('to') ? String(defaultDays) : to === today && [1, 7, 30, 90].includes(span) ? String(span) : 'custom';

  const set = useCallback(
    (patch: Record<string, string | null>) =>
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
          n.delete('offset');
          return n;
        },
        { replace: true },
      ),
    [setSp],
  );
  const setOffset = (n: number) =>
    setSp(
      (prev) => {
        const x = new URLSearchParams(prev);
        n > 0 ? x.set('offset', String(n)) : x.delete('offset');
        return x;
      },
      { replace: true },
    );
  const setPreset = (p: string) => {
    if (p === 'custom') return set({ from, to });
    set({ from: p === String(defaultDays) ? null : addDays(today, -(Number(p) - 1)), to: null });
  };
  return { from, to, preset, sp, set, setOffset, setPreset, range: { from, to, preset } as Range };
}

export function DateRange({ f }: { f: ReturnType<typeof useFilters> }) {
  const { t } = useI18n();
  const presets = ['1', '7', '30', '90', 'custom'].map((v) => ({ v, l: presetLabel(v, t) }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label={t('بازه', 'Range')} value={f.preset} onChange={f.setPreset} options={presets} />
      {f.preset === 'custom' && (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <DateField label={t('از', 'From')} value={f.from} max={f.to} onChange={(from) => f.set({ from })} />
          <span>{t('تا', 'to')}</span>
          <DateField label={t('تا', 'To')} value={f.to} min={f.from} onChange={(to) => f.set({ to })} />
        </div>
      )}
      <span className="text-[12px] text-ink-3 hidden md:inline">
        {uiYmd(f.from)} {t('تا', 'to')} {uiYmd(f.to)}
      </span>
    </div>
  );
}

export function SourceSelect({ f }: { f: ReturnType<typeof useFilters> }) {
  const meta = useMeta();
  const { t } = useI18n();
  return (
    <select aria-label={t('منبع', 'Source')} className="input !w-auto min-w-[140px]" value={f.sp.get('source') ?? ''} onChange={(e) => f.set({ source: e.target.value || null, user: null, client: null })}>
      <option value="">{t('همه‌ی منبع‌ها', 'All sources')}</option>
      {meta.data?.sources.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** 9router api key (`user` in the URL). */
export function KeySelect({ f }: { f: ReturnType<typeof useFilters> }) {
  const meta = useMeta();
  const { t } = useI18n();
  const source = Number(f.sp.get('source')) || null;
  return (
    <select aria-label={t('کلید', 'Key')} className="input !w-auto min-w-[140px] ltr" value={f.sp.get('user') ?? ''} onChange={(e) => f.set({ user: e.target.value || null })}>
      <option value="">{t('همه‌ی کلیدها', 'All keys')}</option>
      {meta.data?.keys
        .filter((k) => !source || k.source_id === source)
        .map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {!source && (meta.data?.sources.length ?? 0) > 1 ? ` (${meta.data?.sources.find((x) => x.id === k.source_id)?.label ?? ''})` : ''}
          </option>
        ))}
    </select>
  );
}

/** The person: OS account behind the keys (`client` in the URL). */
export function ClientSelect({ f }: { f: ReturnType<typeof useFilters> }) {
  const meta = useMeta();
  const { t } = useI18n();
  const source = Number(f.sp.get('source')) || null;
  return (
    <select aria-label={t('کاربر', 'User')} className="input !w-auto min-w-[150px] ltr" value={f.sp.get('client') ?? ''} onChange={(e) => f.set({ client: e.target.value || null })}>
      <option value="">{t('همه‌ی کاربران', 'All users')}</option>
      {meta.data?.clients
        .filter((c) => !source || c.source_ids.includes(source))
        .map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
    </select>
  );
}

export function ModelSelect({ f }: { f: ReturnType<typeof useFilters> }) {
  const meta = useMeta();
  const { t } = useI18n();
  return (
    <select aria-label={t('مدل', 'Model')} className="input !w-auto min-w-[140px] ltr" value={f.sp.get('model') ?? ''} onChange={(e) => f.set({ model: e.target.value || null })}>
      <option value="">{t('همه‌ی مدل‌ها', 'All models')}</option>
      {meta.data?.models.map((m) => (
        <option key={m} value={m}>
          {modelLabel(m)}
        </option>
      ))}
    </select>
  );
}

export { gregDate };
