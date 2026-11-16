import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CircleCheck, Database, MessageSquareText, RefreshCw, Send, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Legend, planSeries, ShareBars, StackedDaily } from '../components/charts';
import { DateRange, ModelSelect, SourceSelect, useFilters, useMeta } from '../components/Filters';
import { KpiTile } from '../components/Kpi';
import { cx, Empty, ErrorBox, PageHeader, Segmented, Skeleton, Spinner, useToast } from '../components/ui';
import { api, errorText, get, Overview as OverviewData, SourceInfo, Sums } from '../lib/api';
import { addDays, compact, int, modelLabel, relative, timeOf, uiDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Metric = 'tokens' | 'requests' | 'human_messages' | 'cache_read';
const metricOf = (s: Sums, m: Metric) => (m === 'tokens' ? s.input_tokens + s.output_tokens : s[m]);

export default function Overview() {
  const { t } = useI18n();
  const METRICS: { v: Metric; l: string }[] = [
    { v: 'tokens', l: t('توکن', 'Tokens') },
    { v: 'cache_read', l: t('کش خوانده', 'Cache read') },
    { v: 'requests', l: t('درخواست', 'Requests') },
    { v: 'human_messages', l: t('پیام کاربر', 'User messages') },
  ];
  const f = useFilters(7);
  const meta = useMeta();
  const [by, setBy] = useState<'source' | 'model'>('source');
  const [metric, setMetric] = useState<Metric>('tokens');
  const params = { from: f.from, to: f.to, source: f.sp.get('source'), model: f.sp.get('model') };
  const q = useQuery({ queryKey: ['overview', params], queryFn: () => get<OverviewData>('/api/overview', params), refetchInterval: 60_000 });
  const d = q.data;

  const chart = useMemo(() => {
    if (!d) return null;
    const rows = by === 'source' ? d.daily_by_source : d.daily_by_model;
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.key || '—', (totals.get(r.key || '—') ?? 0) + metricOf(r, metric));
    for (const [k, v] of totals) if (!v) totals.delete(k);
    const stable = by === 'source' ? (meta.data?.sources.map((s) => s.label) ?? []) : (meta.data?.models ?? []);
    const plan = planSeries(totals, stable);
    const days: Record<string, Record<string, number | string>> = {};
    for (let day = d.from; day <= d.to; day = addDays(day, 1)) days[day] = { day };
    for (const r of rows) {
      const k = plan.fold(r.key || '—');
      if (!totals.has(r.key || '—')) continue;
      const slot = (days[r.day] ??= { day: r.day });
      slot[k] = Number(slot[k] ?? 0) + metricOf(r, metric);
    }
    return { plan, data: Object.values(days) as { day: string }[], empty: totals.size === 0 };
  }, [d, by, metric, meta.data]);

  const k = d?.kpi;
  const label = by === 'model' ? modelLabel : undefined;
  const cacheHit = k && k.input_tokens + k.cache_read > 0 ? Math.round((k.cache_read / (k.input_tokens + k.cache_read + k.cache_write)) * 100) : null;
  const metricLabel = METRICS.find((m) => m.v === metric)!.l;
  const splitLabel = by === 'source' ? t('منبع', 'source') : t('مدل', 'model');

  return (
    <>
      <PageHeader title={t('نمای کلی', 'Overview')} subtitle={t('مصرف توکن و فعالیت کاربران همه‌ی 9router‌ها', 'Token use and user activity across every 9router')} actions={<SyncAllButton sources={d?.sources} />} />
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <DateRange f={f} />
        <div className="flex gap-2 ms-auto">
          <SourceSelect f={f} />
          <ModelSelect f={f} />
        </div>
      </div>

      {q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : null}

      <SourceStrip sources={d?.sources} loading={q.isLoading} />

      <section aria-label={t('شاخص‌ها', 'Metrics')} className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <KpiTile loading={q.isLoading} label={t('پیام کاربر', 'User messages')} icon={<MessageSquareText size={14} />} value={k?.human_messages} sub={t(`${int(k?.sessions)} گفتگو`, `${int(k?.sessions)} ${k?.sessions === 1 ? 'conversation' : 'conversations'}`)} />
        <KpiTile
          loading={q.isLoading}
          label={t('درخواست', 'Requests')}
          icon={<Send size={14} />}
          value={k?.requests}
          sub={k?.aux_requests ? t(`+${int(k.aux_requests)} کمکی (classifier/عنوان)`, `+${int(k.aux_requests)} auxiliary (classifier/title)`) : t('بدون درخواست کمکی', 'No auxiliary requests')}
        />
        <KpiTile loading={q.isLoading} label={t('توکن ورودی', 'Input tokens')} icon={<ArrowDownToLine size={14} />} value={k?.input_tokens} sub={<span className="num">{int(k?.input_tokens)}</span>} />
        <KpiTile loading={q.isLoading} label={t('توکن خروجی', 'Output tokens')} icon={<ArrowUpFromLine size={14} />} value={k?.output_tokens} sub={<span className="num">{int(k?.output_tokens)}</span>} />
        <KpiTile
          loading={q.isLoading}
          label={t('کش خوانده', 'Cache read')}
          icon={<Database size={14} />}
          value={k?.cache_read}
          sub={cacheHit != null ? t(`${cacheHit}% از ورودی از کش`, `${cacheHit}% of input from cache`) : t(`نوشته: ${compact(k?.cache_write)}`, `Written: ${compact(k?.cache_write)}`)}
        />
        <KpiTile
          loading={q.isLoading}
          label={t('کاربر فعال', 'Active users')}
          icon={<Users size={14} />}
          value={k?.users}
          sub={t(`${int(k?.keys)} کلید · ${int(k?.sessions)} گفتگو`, `${int(k?.keys)} ${k?.keys === 1 ? 'key' : 'keys'} · ${int(k?.sessions)} ${k?.sessions === 1 ? 'conversation' : 'conversations'}`)}
        />
      </section>

      <section className="card p-4 sm:p-5 mb-5" aria-labelledby="daily-title">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 id="daily-title" className="m-0 text-[15px] font-bold">
            {t(`${metricLabel} روزانه به تفکیک ${splitLabel}`, `Daily ${metricLabel.toLowerCase()} by ${splitLabel}`)}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Segmented label={t('شاخص', 'Metric')} value={metric} onChange={setMetric} options={METRICS} />
            <Segmented
              label={t('تفکیک', 'Group by')}
              value={by}
              onChange={setBy}
              options={[
                { v: 'source', l: t('منبع', 'Source') },
                { v: 'model', l: t('مدل', 'Model') },
              ]}
            />
          </div>
        </div>
        {q.isLoading || !chart ? (
          <Skeleton className="h-[260px]" />
        ) : chart.empty ? (
          <Empty title={t('داده‌ای در این بازه نیست', 'No data in this range')} hint={t('بازه را بزرگ‌تر کنید یا منتظر همگام‌سازی بعدی بمانید.', 'Widen the range, or wait for the next sync.')} />
        ) : (
          <>
            <div className="mb-3">
              <Legend keys={chart.plan.keys} color={chart.plan.color} label={label} />
            </div>
            <StackedDaily data={chart.data} plan={chart.plan} unit={metricLabel} label={label} />
          </>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <section className="card overflow-hidden" aria-labelledby="top-title">
          <div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3">
            <h2 id="top-title" className="m-0 text-[15px] font-bold">
              {t('کاربران پرمصرف', 'Top users')}
            </h2>
            <Link to={`/reports?by=client,user&from=${f.from}&to=${f.to}`} className="text-[12.5px] text-accent no-underline hover:underline">
              {t('گزارش کامل', 'Full report')}
            </Link>
          </div>
          {q.isLoading ? (
            <div className="p-4 flex flex-col gap-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : !d?.top_users.length ? (
            <Empty title={t('هنوز کاربری نیست', 'No users yet')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('کاربر', 'User')}</th>
                    <th>{t('کلید', 'Key')}</th>
                    <th>{t('منبع', 'Source')}</th>
                    <th className="n">{t('پیام', 'Messages')}</th>
                    <th className="n">{t('گفتگو', 'Conversations')}</th>
                    <th className="n">{t('ورودی', 'Input')}</th>
                    <th className="n">{t('خروجی', 'Output')}</th>
                    <th className="n">{t('کش', 'Cache')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.top_users.map((u) => (
                    <tr key={`${u.source_id}:${u.name}`}>
                      <td className="whitespace-nowrap">
                        {u.name ? (
                          <Link to={`/explore?client=${encodeURIComponent(u.name)}&source=${u.source_id}&from=${f.from}&to=${f.to}`} className="font-medium text-ink no-underline hover:text-accent ltr">
                            {u.name}
                          </Link>
                        ) : (
                          <span className="text-ink-3" title={t('کاربر این درخواست قابل تشخیص نیست: درخواست سیستمی است یا متن آن قبل از افزایش حد ذخیره‌ی 9router ذخیره نشده بود', 'No identifiable user for this request: it is a system request, or its text was saved before the 9router storage limit was raised')}>—</span>
                        )}
                      </td>
                      <td className="text-ink-2 whitespace-nowrap ltr">{u.keys.join(t('، ', ', '))}</td>
                      <td className="text-ink-2">{u.source}</td>
                      <td className="n num">{int(u.human_messages)}</td>
                      <td className="n num">{int(u.sessions)}</td>
                      <td className="n num" title={int(u.input_tokens)}>
                        {compact(u.input_tokens)}
                      </td>
                      <td className="n num" title={int(u.output_tokens)}>
                        {compact(u.output_tokens)}
                      </td>
                      <td className="n num text-ink-3" title={int(u.cache_read)}>
                        {compact(u.cache_read)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card p-4 sm:p-5" aria-labelledby="models-title">
          <h2 id="models-title" className="m-0 mb-4 text-[15px] font-bold">
            {t('سهم مدل‌ها از توکن', 'Model share of tokens')}
          </h2>
          {q.isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : !d?.models.length ? (
            <Empty title={t('مدلی ثبت نشده', 'No models recorded')} />
          ) : (
            <ShareBars
              rows={d.models
                .filter((m) => m.input_tokens + m.output_tokens > 0)
                .map((m) => ({ key: m.model || '—', label: modelLabel(m.model), value: m.input_tokens + m.output_tokens, hint: t(`${m.model} · ${int(m.requests + m.aux_requests)} درخواست`, `${m.model} · ${int(m.requests + m.aux_requests)} ${m.requests + m.aux_requests === 1 ? 'request' : 'requests'}`) }))}
            />
          )}
        </section>
      </div>
    </>
  );
}

function SourceStrip({ sources, loading }: { sources?: SourceInfo[]; loading: boolean }) {
  const { t } = useI18n();
  if (loading) return <Skeleton className="h-[62px] mb-5" />;
  if (!sources?.length)
    return (
      <div className="card mb-5">
        <Empty title={t('هیچ منبعی پیدا نشد', 'No sources found')} hint={t('پوشه‌ی دیتابیس 9router باید زیر /sources/<name> در کانتینر mount شده باشد. راهنما در README آمده است.', 'The 9router database folder must be mounted at /sources/<name> in the container. See the README.')} />
      </div>
    );
  return (
    <section aria-label={t('وضعیت منبع‌ها', 'Source status')} className="grid gap-3 mb-5 sm:grid-cols-2 xl:grid-cols-4">
      {sources.map((s) => (
        <SourceCard key={s.id} s={s} />
      ))}
    </section>
  );
}

function SourceCard({ s }: { s: SourceInfo }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const sync = useMutation({
    mutationFn: () => api('POST', `/api/sources/${s.id}/sync`),
    onSuccess: () => {
      toast('ok', t(`همگام‌سازی ${s.label} شروع شد`, `Sync started for ${s.label}`));
      setTimeout(() => qc.invalidateQueries(), 2500);
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const state = !s.enabled ? 'off' : s.last_error ? 'err' : s.gap_detected ? 'gap' : s.last_sync_at ? 'ok' : 'never';
  return (
    <div className={cx('card px-4 py-3 flex items-center gap-3', !s.enabled && 'opacity-60')}>
      <div className={cx('size-9 rounded-xl grid place-items-center shrink-0', state === 'ok' ? 'bg-good-soft text-good' : state === 'off' || state === 'never' ? 'bg-surface-2 text-ink-3' : state === 'gap' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
        {state === 'ok' ? <CircleCheck size={18} /> : state === 'off' || state === 'never' ? <Database size={17} /> : <AlertTriangle size={17} />}
      </div>
      <div className="min-w-0 grow">
        <div className="flex items-center gap-2">
          <span className="font-semibold truncate">{s.label}</span>
          {state === 'gap' && <span className="chip chip-warn">{t('شکاف داده', 'Data gap')}</span>}
          {state === 'err' && <span className="chip chip-bad">{t('خطا', 'Error')}</span>}
          {state === 'off' && <span className="chip">{t('غیرفعال', 'Disabled')}</span>}
        </div>
        <div className="text-[11.5px] text-ink-3 truncate" title={s.last_error ?? (s.last_sync_at ? `${uiDate(s.last_sync_at)} ${timeOf(s.last_sync_at, true)}` : '')}>
          {s.last_error ? s.last_error : s.last_sync_at ? t(`آخرین همگام‌سازی ${relative(s.last_sync_at)}`, `Last sync ${relative(s.last_sync_at)}`) : t('هنوز همگام نشده', 'Not synced yet')} · <span className="num">{int(s.total_requests)}</span> {t('درخواست', s.total_requests === 1 ? 'request' : 'requests')}
        </div>
      </div>
      <button className="btn btn-ghost btn-icon btn-sm shrink-0" onClick={() => sync.mutate()} disabled={s.syncing || sync.isPending || !s.enabled} aria-label={t(`همگام‌سازی ${s.label}`, `Sync ${s.label}`)} title={t('همین الان همگام کن', 'Sync now')}>
        {s.syncing || sync.isPending ? <Spinner size={15} /> : <RefreshCw size={15} />}
      </button>
    </div>
  );
}

function SyncAllButton({ sources }: { sources?: SourceInfo[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: async () => {
      const list = (sources ?? []).filter((s) => s.enabled && !s.syncing);
      await Promise.allSettled(list.map((s) => api('POST', `/api/sources/${s.id}/sync`)));
      return list.length;
    },
    onSuccess: (n) => {
      toast('ok', n ? t(`همگام‌سازی ${n} منبع شروع شد`, `Started syncing ${n} ${n === 1 ? 'source' : 'sources'}`) : t('منبع فعالی برای همگام‌سازی نیست', 'No active source to sync'));
      setTimeout(() => qc.invalidateQueries(), 3000);
    },
  });
  return (
    <button className="btn" onClick={() => m.mutate()} disabled={m.isPending || !sources?.length}>
      {m.isPending ? <Spinner size={15} /> : <RefreshCw size={15} />}
      {t('همگام‌سازی همه', 'Sync all')}
    </button>
  );
}
