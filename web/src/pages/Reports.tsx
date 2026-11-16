import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ClientSelect, DateRange, KeySelect, ModelSelect, SourceSelect, useFilters } from '../components/Filters';
import { cx, Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import { DailyRow, get, qs } from '../lib/api';
import { compact, int, modelLabel, uiYmd } from '../lib/format';
import { useI18n } from '../lib/i18n';

// `user` is the 9router key (kept as the URL name), `client` the person behind it
type Dim = 'source' | 'client' | 'user' | 'model';

type SortKey = 'day' | 'source' | 'client' | 'user_name' | 'human_messages' | 'requests' | 'input_tokens' | 'output_tokens' | 'cache_read' | 'cache_write' | 'sessions' | 'avg_latency_ms';

export default function Reports() {
  const { t, lang } = useI18n();
  const DIMS: { v: Dim; l: string }[] = [
    { v: 'source', l: t('منبع', 'Source') },
    { v: 'client', l: t('کاربر', 'User') },
    { v: 'user', l: t('کلید', 'Key') },
    { v: 'model', l: t('مدل', 'Model') },
  ];
  const f = useFilters(7);
  const by = (f.sp.get('by') ?? 'source,client,user').split(',').filter((x): x is Dim => DIMS.some((d) => d.v === x));
  const toggle = (d: Dim) => {
    const n = by.includes(d) ? by.filter((x) => x !== d) : DIMS.map((x) => x.v).filter((x) => x === d || by.includes(x));
    f.set({ by: n.join(',') || null });
  };
  const byParam = by.join(',');
  const params = { from: f.from, to: f.to, source: f.sp.get('source'), user: f.sp.get('user'), client: f.sp.get('client'), model: f.sp.get('model'), by: byParam };
  const q = useQuery({ queryKey: ['daily', params], queryFn: () => get<{ rows: DailyRow[] }>('/api/reports/daily', params), placeholderData: keepPreviousData });

  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'day', dir: -1 });
  const rows = useMemo(() => {
    const r = [...(q.data?.rows ?? [])];
    const val = (x: DailyRow): string | number =>
      sort.k === 'user_name' ? (x.user_name ?? '') : sort.k === 'client' ? (x.client ?? '') : sort.k === 'source' ? (x.source ?? '') : (x as unknown as Record<string, number | string>)[sort.k];
    r.sort((a, b) => {
      const A = val(a);
      const B = val(b);
      const c = typeof A === 'number' && typeof B === 'number' ? A - B : String(A).localeCompare(String(B));
      return c * sort.dir || b.day.localeCompare(a.day);
    });
    return r;
  }, [q.data, sort]);

  const tot = useMemo(() => {
    const t = { human_messages: 0, requests: 0, aux_requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 };
    for (const r of rows) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
    return t;
  }, [rows]);

  const csv = `/api/reports/daily${qs({ ...params, format: 'csv' })}`;
  const th = (k: SortKey, label: string, num = false) => (
    <th className={cx(num && 'n')} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="sortable" onClick={() => setSort((s) => (s.k === k ? { k, dir: (-s.dir) as 1 | -1 } : { k, dir: k === 'day' || k === 'source' || k === 'client' || k === 'user_name' ? 1 : -1 }))}>
        {label}
        {sort.k === k ? sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} className="opacity-40" />}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        title={t('گزارش روزانه', 'Daily report')}
        subtitle={t(
          'مصرف هر روز (به وقت تهران) به تفکیک منبع، کاربر، کلید و مدل. کاربر = حساب سیستمی که از آن استفاده شده؛ کلید = کلید API در 9router',
          'Daily usage (Tehran time) by source, user, key, and model. User = the OS account that was used; Key = the API key in 9router.',
        )}
        actions={
          <a className="btn" href={csv} download>
            <Download size={15} /> {t('خروجی CSV', 'Export CSV')}
          </a>
        }
      />
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <DateRange f={f} />
        <div className="flex flex-wrap items-center gap-2 ms-auto">
          <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3" role="group" aria-label={t('تفکیک', 'Group by')}>
            {t('تفکیک:', 'Group by:')}
            {DIMS.map((d) => (
              <button key={d.v} className={cx('chip cursor-pointer', by.includes(d.v) && 'chip-accent')} aria-pressed={by.includes(d.v)} onClick={() => toggle(d.v)}>
                {d.l}
              </button>
            ))}
          </div>
          <SourceSelect f={f} />
          <ClientSelect f={f} />
          <KeySelect f={f} />
          <ModelSelect f={f} />
        </div>
      </div>

      {q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : null}
      <div className="card overflow-hidden">
        {q.isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : !rows.length ? (
          <Empty title={t('داده‌ای برای این فیلتر نیست', 'No data for this filter')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  {th('day', t('تاریخ', 'Date'))}
                  {by.includes('source') && th('source', t('منبع', 'Source'))}
                  {by.includes('client') && th('client', t('کاربر', 'User'))}
                  {by.includes('user') && th('user_name', t('کلید', 'Key'))}
                  {th('human_messages', t('پیام کاربر', 'User messages'), true)}
                  {th('requests', t('درخواست', 'Requests'), true)}
                  {th('input_tokens', t('ورودی', 'Input'), true)}
                  {th('output_tokens', t('خروجی', 'Output'), true)}
                  {th('cache_read', t('کش خوانده', 'Cache read'), true)}
                  {th('cache_write', t('کش نوشته', 'Cache write'), true)}
                  <th>{t('مدل‌ها', 'Models')}</th>
                  {th('sessions', t('گفتگو', 'Conversations'), true)}
                  {th('avg_latency_ms', t('میانگین تأخیر', 'Avg latency'), true)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap">
                      <span className="font-medium num">{uiYmd(r.day)}</span>{lang === 'fa' && <> <span className="text-[11px] text-ink-3 num">{r.day.slice(5)}</span></>}
                    </td>
                    {by.includes('source') && <td>{r.source}</td>}
                    {by.includes('client') && (
                      <td className="font-medium whitespace-nowrap">
                        <span className="ltr">{r.client || <span className="text-ink-3" title={t('کاربر این درخواست قابل تشخیص نیست: درخواست سیستمی است یا متن آن قبل از افزایش حد ذخیره‌ی 9router ذخیره نشده بود', 'No identifiable user for this request: it is a system request, or its text was saved before the 9router storage limit was raised')}>—</span>}</span>
                      </td>
                    )}
                    {by.includes('user') && (
                      <td className="whitespace-nowrap">
                        <span className="ltr text-ink-2">{r.user_name}</span>
                      </td>
                    )}
                    <td className="n num">{int(r.human_messages)}</td>
                    <td className="n num" title={r.aux_requests ? t(`+${int(r.aux_requests)} کمکی`, `+${int(r.aux_requests)} auxiliary`) : undefined}>
                      {int(r.requests)}
                    </td>
                    <td className="n num" title={int(r.input_tokens)}>
                      {compact(r.input_tokens)}
                    </td>
                    <td className="n num" title={int(r.output_tokens)}>
                      {compact(r.output_tokens)}
                    </td>
                    <td className="n num text-ink-3" title={int(r.cache_read)}>
                      {compact(r.cache_read)}
                    </td>
                    <td className="n num text-ink-3" title={int(r.cache_write)}>
                      {compact(r.cache_write)}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1 ltr justify-end">
                        {(r.models ?? []).filter(Boolean).map((m) => (
                          <span key={m} className="chip" title={m}>
                            {modelLabel(m)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="n num">{int(r.sessions)}</td>
                    <td className="n num text-ink-3">{r.avg_latency_ms ? `${(r.avg_latency_ms / 1000).toFixed(1)}s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={1 + (by.includes('source') ? 1 : 0) + (by.includes('client') ? 1 : 0) + (by.includes('user') ? 1 : 0)}>{t('جمع کل', 'Total')}</td>
                  <td className="n num">{int(tot.human_messages)}</td>
                  <td className="n num">{int(tot.requests)}</td>
                  <td className="n num" title={int(tot.input_tokens)}>
                    {compact(tot.input_tokens)}
                  </td>
                  <td className="n num" title={int(tot.output_tokens)}>
                    {compact(tot.output_tokens)}
                  </td>
                  <td className="n num" title={int(tot.cache_read)}>
                    {compact(tot.cache_read)}
                  </td>
                  <td className="n num" title={int(tot.cache_write)}>
                    {compact(tot.cache_write)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      <p className="text-[12px] text-ink-3 mt-3">
        {t(
          '«درخواست» فقط درخواست‌های اصلی و subagent است؛ درخواست‌های کمکی (classifier و عنوان) جدا شمرده می‌شوند و با نگه‌داشتن موس روی عدد دیده می‌شوند. «پیام کاربر» فقط پیام‌هایی است که انسان واقعاً تایپ کرده.',
          '"Requests" counts only main requests and subagents. Auxiliary requests (classifier and title) are counted separately and show when you hover the number. "User messages" counts only messages a person actually typed.',
        )}
      </p>
    </>
  );
}
