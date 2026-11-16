import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMeta } from '../components/Filters';
import { Confirm, cx, Empty, ErrorBox, Field, Modal, PageHeader, Segmented, Skeleton, Spinner, Switch, useToast } from '../components/ui';
import { api, errorText, get, RunRow, Schedule } from '../lib/api';
import { gregDate, int, relative, timeOf, uiDate, weekdays } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Draft {
  id?: number;
  name: string;
  source_ids: number[];
  mode: 'interval' | 'cron';
  every_min: number;
  cron: string;
  days: number[];
  from_hour: number | '';
  to_hour: number | '';
  enabled: boolean;
}
const blank = (): Draft => ({ name: '', source_ids: [], mode: 'interval', every_min: 5, cron: '*/10 8-20 * * *', days: [], from_hour: '', to_hour: '', enabled: true });
const fromSchedule = (s: Schedule): Draft => ({
  id: s.id,
  name: s.name,
  source_ids: s.source_ids,
  mode: s.mode,
  every_min: s.every_min ?? 5,
  cron: s.cron ?? '*/10 * * * *',
  days: s.days ?? [],
  from_hour: s.from_hour ?? '',
  to_hour: s.to_hour ?? '',
  enabled: s.enabled,
});
const body = (d: Draft) => ({
  name: d.name.trim(),
  source_ids: d.source_ids,
  mode: d.mode,
  every_min: d.mode === 'interval' ? Number(d.every_min) : null,
  cron: d.mode === 'cron' ? d.cron.trim() : null,
  days: d.days.length && d.days.length < 7 ? d.days : null,
  from_hour: d.from_hour === '' ? null : Number(d.from_hour),
  to_hour: d.to_hour === '' ? null : Number(d.to_hour),
  enabled: d.enabled,
});

function describe(s: Schedule, names: Map<number, string>, t: (fa: string, en: string) => string) {
  const when = s.mode === 'interval' ? t(`هر ${int(s.every_min)} دقیقه`, `every ${int(s.every_min)} min`) : `cron: ${s.cron}`;
  const days = s.days?.length && s.days.length < 7 ? weekdays().filter((w) => s.days!.includes(w.v)).map((w) => w.l).join(t('، ', ', ')) : t('همه‌ی روزها', 'all days');
  const hours = s.from_hour != null && s.to_hour != null ? t(`ساعت ${s.from_hour} تا ${s.to_hour}`, `hours ${s.from_hour}–${s.to_hour}`) : t('تمام ساعات', 'all hours');
  const src = s.source_ids.length ? s.source_ids.map((i) => names.get(i) ?? i).join(t('، ', ', ')) : t('همه‌ی منبع‌ها', 'all sources');
  return { when, days, hours, src };
}

export default function Schedules() {
  const { t, lang } = useI18n();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [del, setDel] = useState<Schedule | null>(null);
  const names = new Map((meta.data?.sources ?? []).map((s) => [s.id, s.label]));

  const list = useQuery({ queryKey: ['schedules'], queryFn: () => get<{ schedules: Schedule[] }>('/api/schedules'), refetchInterval: 30_000 });
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => get<{ runs: RunRow[] }>('/api/runs', { limit: 40 }), refetchInterval: 15_000 });

  const toggle = useMutation({
    mutationFn: (s: Schedule) => api('PUT', `/api/schedules/${s.id}`, { ...body(fromSchedule(s)), enabled: !s.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e) => toast('err', errorText(e)),
  });
  const runNow = useMutation({
    mutationFn: (s: Schedule) => api('POST', `/api/schedules/${s.id}/run`),
    onSuccess: () => {
      toast('ok', t('اجرا شروع شد', 'Run started'));
      setTimeout(() => qc.invalidateQueries({ queryKey: ['runs'] }), 2500);
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Schedule) => api('DELETE', `/api/schedules/${s.id}`),
    onSuccess: () => {
      setDel(null);
      toast('ok', t('زمان‌بندی حذف شد', 'Schedule deleted'));
      qc.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });

  return (
    <>
      <PageHeader
        title={t("زمان‌بندی همگام‌سازی", "Sync schedules")}
        subtitle={t("هر زمان‌بندی مشخص می‌کند دیتابیس کدام 9router‌ها، در چه بازه‌ی زمانی و با چه دوره‌ای خوانده شود (وقت تهران)", "Each schedule sets which 9router databases are read, in what time window, and how often (Tehran time)")}
        actions={
          <button className="btn btn-primary" onClick={() => setEdit(blank())}>
            <Plus size={15} /> {t('زمان‌بندی جدید', 'New schedule')}
          </button>
        }
      />

      {list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : null}
      {list.isLoading ? (
        <Skeleton className="h-32" />
      ) : !list.data?.schedules.length ? (
        <div className="card">
          <Empty title={t("زمان‌بندی تعریف نشده", "No schedules yet")} hint={t("بدون زمان‌بندی، هیچ همگام‌سازی خودکاری انجام نمی‌شود. می‌توانید دستی هم از صفحه‌ی نمای کلی همگام کنید.", "Without a schedule, nothing syncs automatically. You can still sync manually from the overview page.")} action={<button className="btn btn-primary mt-2" onClick={() => setEdit(blank())}>{t('ساخت اولین زمان‌بندی', 'Create the first schedule')}</button>} />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.data.schedules.map((s) => {
            const info = describe(s, names, t);
            return (
              <article key={s.id} className={cx('card p-4', !s.enabled && 'opacity-70')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="m-0 text-[15px] font-bold truncate">{s.name}</h3>
                    <div className="mt-0.5 text-[12.5px] text-ink-3">{info.src}</div>
                  </div>
                  <Switch checked={s.enabled} onChange={() => toggle.mutate(s)} label={t(`فعال بودن ${s.name}`, `${s.name} enabled`)} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 my-3 text-[13px]">
                  <dt className="text-ink-3">{t('دوره', 'Frequency')}</dt>
                  <dd className="m-0 font-medium">{info.when}</dd>
                  <dt className="text-ink-3">{t('روزها', 'Days')}</dt>
                  <dd className="m-0">{info.days}</dd>
                  <dt className="text-ink-3">{t('ساعت', 'Hours')}</dt>
                  <dd className="m-0">{info.hours}</dd>
                  <dt className="text-ink-3">{t('آخرین اجرا', 'Last run')}</dt>
                  <dd className="m-0">{s.last_run_at ? relative(s.last_run_at) : '—'}</dd>
                </dl>
                {s.enabled && s.next_runs.length > 0 && (
                  <div className="text-[12px] text-ink-3 border-t border-line pt-2.5">
                    {t('اجراهای بعدی:', 'Next runs:')}{' '}
                    {s.next_runs.slice(0, 3).map((r) => (
                      <span key={r} className="chip me-1 num">
                        {lang === 'en' ? uiDate(r) : uiDate(r).slice(5)} {timeOf(r)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 mt-3">
                  <button className="btn btn-sm" onClick={() => setEdit(fromSchedule(s))}>
                    <Pencil size={13} /> {t('ویرایش', 'Edit')}
                  </button>
                  <button className="btn btn-sm" onClick={() => runNow.mutate(s)} disabled={runNow.isPending}>
                    <Play size={13} /> {t('اجرای دستی', 'Run now')}
                  </button>
                  <button className="btn btn-sm btn-ghost text-bad ms-auto" onClick={() => setDel(s)} aria-label={t(`حذف ${s.name}`, `Delete ${s.name}`)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="card overflow-hidden mt-6" aria-labelledby="runs-title">
        <h2 id="runs-title" className="m-0 px-4 pt-4 pb-3 text-[15px] font-bold">
          {t('تاریخچه‌ی اجراها', 'Run history')}
        </h2>
        {runs.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-24" />
          </div>
        ) : !runs.data?.runs.length ? (
          <Empty title={t("هنوز اجرایی ثبت نشده", "No runs recorded yet")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('زمان', 'Time')}</th>
                  <th>{t('منبع', 'Source')}</th>
                  <th>{t('منشأ', 'Origin')}</th>
                  <th className="n">{t('خوانده', 'Read')}</th>
                  <th className="n">{t('جدید', 'New')}</th>
                  <th>{t('وضعیت', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">
                      {uiDate(r.started_at)} <span className="num">{timeOf(r.started_at, true)}</span>{lang === 'en' ? null : <> <span className="text-[11px] text-ink-3 num">{gregDate(r.started_at).slice(5)}</span></>}
                    </td>
                    <td>{r.source}</td>
                    <td className="text-ink-3">{r.trigger === 'manual' ? t('دستی', 'Manual') : r.schedule ?? t('خودکار', 'Automatic')}</td>
                    <td className="n num">{int(r.rows_read)}</td>
                    <td className="n num">{int(r.rows_new)}</td>
                    <td>
                      {!r.finished_at ? (
                        <span className="chip">{t('در حال اجرا', 'Running')}</span>
                      ) : r.error ? (
                        <span className="chip chip-bad" title={r.error}>
                          {t('خطا', 'Error')}
                        </span>
                      ) : r.gap ? (
                        <span className="chip chip-warn" title={t("9router رکوردهایی را قبل از همگام‌سازی حذف کرده بود", "9router had deleted records before the sync")}>
                          <AlertTriangle size={11} /> {t('شکاف', 'Gap')}
                        </span>
                      ) : (
                        <span className="chip chip-good">{t('موفق', 'Success')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ScheduleModal draft={edit} onClose={() => setEdit(null)} />
      <Confirm open={!!del} title={t("حذف زمان‌بندی", "Delete schedule")} body={<>{t('زمان‌بندی «', 'Delete the “')}{del?.name}{t('» حذف شود؟ داده‌های ذخیره‌شده دست‌نخورده می‌مانند.', '” schedule? Saved data is left untouched.')}</>} confirmLabel={t("حذف", "Delete")} onConfirm={() => del && remove.mutate(del)} onClose={() => setDel(null)} busy={remove.isPending} />
    </>
  );
}

function ScheduleModal({ draft, onClose }: { draft: Draft | null; onClose: () => void }) {
  const { t } = useI18n();
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>(blank());
  const [preview, setPreview] = useState<{ runs: string[]; err: string | null }>({ runs: [], err: null });
  useEffect(() => {
    if (draft) setD(draft);
  }, [draft]);
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // live preview of the next runs, debounced
  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(async () => {
      try {
        const r = await api<{ next_runs: string[] }>('POST', '/api/schedules/preview', body(d));
        setPreview({ runs: r.next_runs, err: null });
      } catch (e) {
        setPreview({ runs: [], err: errorText(e) });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [d, draft]);

  const save = useMutation({
    mutationFn: () => (d.id ? api('PUT', `/api/schedules/${d.id}`, body(d)) : api('POST', '/api/schedules', body(d))),
    onSuccess: () => {
      toast('ok', t('ذخیره شد', 'Saved'));
      qc.invalidateQueries({ queryKey: ['schedules'] });
      onClose();
    },
    onError: (e) => toast('err', errorText(e)),
  });

  const sources = meta.data?.sources ?? [];
  const hoursOk = (d.from_hour === '') === (d.to_hour === '');
  const canSave = d.name.trim().length > 0 && hoursOk && !preview.err;

  return (
    <Modal open={!!draft} onClose={onClose} title={d.id ? t('ویرایش زمان‌بندی', 'Edit schedule') : t('زمان‌بندی جدید', 'New schedule')} width={600}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field label={t("نام", "Name")}>
          <input className="input" value={d.name} onChange={(e) => up({ name: e.target.value })} placeholder={t("مثلاً: ساعات کاری", "e.g. working hours")} autoFocus />
        </Field>

        <Field label={t("منبع‌ها", "Sources")} hint={t("اگر هیچ‌کدام انتخاب نشود، همه‌ی منبع‌ها همگام می‌شوند.", "If none are selected, every source is synced.")}>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => {
              const on = d.source_ids.includes(s.id);
              return (
                <button type="button" key={s.id} className={cx('chip cursor-pointer !h-8 !px-3', on && 'chip-accent')} aria-pressed={on} onClick={() => up({ source_ids: on ? d.source_ids.filter((x) => x !== s.id) : [...d.source_ids, s.id] })}>
                  {s.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label={t("نوع دوره", "Schedule type")}>
          <Segmented
            label={t("نوع دوره", "Schedule type")}
            value={d.mode}
            onChange={(v) => up({ mode: v })}
            options={[
              { v: 'interval', l: t('هر N دقیقه', 'Every N minutes') },
              { v: 'cron', l: t('عبارت cron', 'Cron expression') },
            ]}
          />
        </Field>

        {d.mode === 'interval' ? (
          <Field label={t("فاصله‌ی اجرا (دقیقه)", "Interval (minutes)")}>
            <input className="input !w-32 num" type="number" min={1} max={1440} value={d.every_min} onChange={(e) => up({ every_min: Number(e.target.value) })} />
          </Field>
        ) : (
          <Field label={t("cron (دقیقه ساعت روز-ماه ماه روز-هفته)", "cron (minute hour day-of-month month day-of-week)")} hint={t("مثال: */10 8-20 * * 6-3 یعنی هر ۱۰ دقیقه، ساعت ۸ تا ۲۰", "Example: */10 8-20 * * 6-3 means every 10 minutes, from 8:00 to 20:00")}>
            <input className="input ltr mono" value={d.cron} onChange={(e) => up({ cron: e.target.value })} />
          </Field>
        )}

        <Field label={t("روزهای فعال", "Active days")} hint={t("خالی = همه‌ی روزها", "Empty = all days")}>
          <div className="flex flex-wrap gap-1.5">
            {weekdays().map((w) => {
              const on = d.days.includes(w.v);
              return (
                <button type="button" key={w.v} className={cx('chip cursor-pointer !h-8 !px-3', on && 'chip-accent')} aria-pressed={on} onClick={() => up({ days: on ? d.days.filter((x) => x !== w.v) : [...d.days, w.v] })}>
                  {w.l}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("از ساعت", "From hour")}>
            <HourSelect value={d.from_hour} onChange={(v) => up({ from_hour: v })} />
          </Field>
          <Field label={t("تا ساعت", "To hour")}>
            <HourSelect value={d.to_hour} onChange={(v) => up({ to_hour: v })} />
          </Field>
        </div>
        {!hoursOk && <div className="text-bad text-[12.5px] -mt-2">{t('ساعت شروع و پایان را هر دو تنظیم کنید یا هر دو را خالی بگذارید.', 'Set both the start and end hour, or leave both empty.')}</div>}

        <div className="rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px]">
          <div className="flex items-center gap-1.5 font-semibold text-ink-2 mb-1.5">
            <CalendarClock size={14} /> {t('پنج اجرای بعدی', 'Next five runs')}
          </div>
          {preview.err ? (
            <span className="text-bad">{preview.err}</span>
          ) : preview.runs.length ? (
            <div className="flex flex-wrap gap-1.5">
              {preview.runs.map((r) => (
                <span key={r} className="chip num">
                  {uiDate(r)} {timeOf(r)}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-3">{t('اجرایی در این الگو پیدا نشد.', 'No runs match this pattern.')}</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <label className="inline-flex items-center gap-2 text-[13px]">
            <Switch checked={d.enabled} onChange={(v) => up({ enabled: v })} label={t("فعال", "Enabled")} /> {t('فعال', 'Enabled')}
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={onClose}>
              {t('انصراف', 'Cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSave || save.isPending}>
              {save.isPending && <Spinner size={14} />} {t('ذخیره', 'Save')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function HourSelect({ value, onChange }: { value: number | ''; onChange: (v: number | '') => void }) {
  return (
    <select className="input num" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}>
      <option value="">—</option>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </select>
  );
}
