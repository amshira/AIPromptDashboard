import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, EyeOff, GitMerge, HardDrive, KeyRound, Pencil, Play, Plus, RefreshCw, Server, Timer, Trash2, Users } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Confirm, cx, Empty, ErrorBox, Field, Modal, PageHeader, Skeleton, Spinner, Switch, useToast } from '../components/ui';
import { agentErrorText, api, errorText, get, ServerInfo, SettingsInfo, SourceInfo, UserRow } from '../lib/api';
import { bytes, int, relative, timeOf, todayYmd, uiDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Settings() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('تنظیمات', 'Settings')} subtitle={t('نگهداری داده، منبع‌ها، کاربران و رمز عبور', 'Data retention, sources, users, and password')} />
      <div className="grid gap-5 xl:grid-cols-2 items-start">
        <div className="flex flex-col gap-5">
          <RetentionCard />
          <SourcesCard />
          <ServersCard />
          <PasswordCard />
        </div>
        <div className="flex flex-col gap-5">
          <UsersCard />
          <StorageCard />
        </div>
      </div>
    </>
  );
}

function Card({ title, icon, children, actions }: { title: string; icon: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-5" aria-label={title}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="m-0 text-[15px] font-bold flex items-center gap-2">
          <span className="text-ink-3">{icon}</span>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsInfo>('/api/settings') });

// ---------- retention ----------
function RetentionCard() {
  const { t } = useI18n();
  const s = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [keepAll, setKeepAll] = useState(true);
  const [days, setDays] = useState(30);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!s.data) return;
    setKeepAll(s.data.retention_days == null);
    if (s.data.retention_days) setDays(s.data.retention_days);
  }, [s.data]);

  const save = useMutation({
    mutationFn: () => api('PUT', '/api/settings/retention', { days: keepAll ? null : days }),
    onSuccess: () => {
      toast('ok', t('ذخیره شد', 'Saved'));
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const run = useMutation({
    mutationFn: () => api<{ requests: number; sessions: number }>('POST', '/api/settings/retention/run'),
    onSuccess: (r) => {
      setConfirm(false);
      toast('ok', t(`${int(r?.requests)} درخواست و ${int(r?.sessions)} گفتگو حذف شد`, `${int(r?.requests)} requests and ${int(r?.sessions)} conversations were deleted`));
      qc.invalidateQueries();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const dirty = s.data && (keepAll ? s.data.retention_days != null : s.data.retention_days !== days);
  const last = s.data?.retention_last;

  return (
    <Card title={t('نگهداری داده', 'Data retention')} icon={<Timer size={16} />}>
      {s.isLoading ? (
        <Skeleton className="h-28" />
      ) : s.error ? (
        <ErrorBox error={s.error} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2.5 text-[13.5px] cursor-pointer">
              <input type="radio" name="ret" className="size-4 accent-[var(--accent)]" checked={keepAll} onChange={() => setKeepAll(true)} />
              {t('همه‌چیز نگه داشته شود', 'Keep everything')}
            </label>
            <label className="flex flex-wrap items-center gap-2.5 text-[13.5px] cursor-pointer">
              <input type="radio" name="ret" className="size-4 accent-[var(--accent)]" checked={!keepAll} onChange={() => setKeepAll(false)} />
              {t('فقط', 'Keep only the last')}
              <input type="number" min={1} max={3650} className="input !w-24 num !h-8" value={days} disabled={keepAll} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('تعداد روز', 'Number of days')} />
              {t('روز آخر نگه داشته شود', 'days')}
            </label>
            <p className="m-0 text-[12.5px] text-ink-3">{t('پاک‌سازی هر شب ساعت ۳ بامداد (تهران) اجرا می‌شود. برای هر منبع می‌توانید در بخش منبع‌ها مقدار جداگانه بگذارید.', 'Cleanup runs every night at 3:00 a.m. (Tehran). You can set a separate value for each source in the Sources section.')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner size={14} />} {t('ذخیره', 'Save')}
            </button>
            <button className="btn" onClick={() => setConfirm(true)}>
              <Play size={14} /> {t('اجرای پاک‌سازی همین الان', 'Run cleanup now')}
            </button>
            {last && (
              <span className="text-[12px] text-ink-3 ms-auto">
                {t('آخرین اجرا', 'Last run')} {relative(last.at)}: <span className="num">{int(last.requests)}</span> {t('درخواست حذف شد', 'requests deleted')}
              </span>
            )}
          </div>
        </>
      )}
      <Confirm
        open={confirm}
        title={t('اجرای پاک‌سازی', 'Run cleanup')}
        body={t('داده‌های قدیمی‌تر از دوره‌ی نگهداری (سراسری یا مخصوص هر منبع) برای همیشه حذف می‌شوند. ادامه می‌دهید؟', 'Data older than the retention period (global or per source) is deleted permanently. Continue?')}
        confirmLabel={t('پاک‌سازی', 'Clean up')}
        onConfirm={() => run.mutate()}
        onClose={() => setConfirm(false)}
        busy={run.isPending}
      />
    </Card>
  );
}

// ---------- sources ----------
function SourcesCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sources'], queryFn: () => get<{ sources: SourceInfo[] }>('/api/sources'), refetchInterval: 30_000 });
  const [del, setDel] = useState<SourceInfo | null>(null);
  const scan = useMutation({
    mutationFn: () => api<{ added: number; total: number; missing: number }>('POST', '/api/sources/discover'),
    onSuccess: (r) => {
      toast('ok', r?.added ? t(`${int(r.added)} 9router تازه پیدا شد؛ همگام‌سازی شروع شد`, `${int(r.added)} new 9routers found; sync started`) : t('9router تازه‌ای پیدا نشد', 'No new 9router found'));
      qc.invalidateQueries();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/sources/${id}`),
    onSuccess: () => {
      setDel(null);
      toast('ok', t('منبع و داده‌هایش حذف شد', 'The source and its data were deleted'));
      qc.invalidateQueries();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  // removed 9routers last, so the live ones stay on top
  const list = [...(q.data?.sources ?? [])].sort((a, b) => Number(!!a.missing_since) - Number(!!b.missing_since));
  return (
    <Card
      title={t('منبع‌ها (9router)', 'Sources (9router)')}
      icon={<HardDrive size={16} />}
      actions={
        <button className="btn btn-sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? <Spinner size={13} /> : <RefreshCw size={13} />} {t('جستجوی 9router تازه', 'Look for new 9routers')}
        </button>
      }
    >
      <p className="text-[12.5px] text-ink-3 mt-0 mb-3">
        {t('هر 9router زیر پوشه‌های mount‌شده (مثل ', 'Every 9router under a mounted folder (such as ')}<span className="ltr mono">/opt/9router-users</span>{t(') خودکار پیدا می‌شود؛ کاربری که با', ') is found automatically. A user created with')}{' '}<span className="ltr mono">add-user.sh</span>{t(' ساخته شود حداکثر یک دقیقه بعد اینجا می‌آید. داشبورد فایل‌ها را فقط می‌خواند.', ' shows up here within a minute. The dashboard only reads the files.')}
      </p>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !list.length ? (
        <Empty title={t('منبعی پیدا نشد', 'No source found')} hint={t('پوشه‌ی 9router‌ها را در compose زیر /sources mount کنید.', 'Mount the 9router folders under /sources in compose.')} />
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {list.map((s) => (
            <SourceRow key={s.id} s={s} onDelete={() => setDel(s)} />
          ))}
        </div>
      )}
      <Confirm
        open={!!del}
        title={t('حذف منبع', 'Delete source')}
        body={t(`9router «${del?.label ?? ''}» دیگر روی سرور نیست. با حذف آن، همه‌ی درخواست‌ها، کلیدها و گفتگوهای ذخیره‌شده از آن هم برای همیشه پاک می‌شوند. ادامه می‌دهید؟`, `9router “${del?.label ?? ''}” is no longer on the server. Deleting it permanently removes every stored request, key, and conversation from it. Continue?`)}
        confirmLabel={t('حذف', 'Delete')}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
        busy={remove.isPending}
      />
    </Card>
  );
}

function SourceRow({ s, onDelete }: { s: SourceInfo; onDelete: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState(s.label);
  const [ret, setRet] = useState<string>(s.retention_days ? String(s.retention_days) : '');
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api('PATCH', `/api/sources/${s.id}`, b),
    onSuccess: () => {
      toast('ok', t('ذخیره شد', 'Saved'));
      qc.invalidateQueries();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const dirty = label.trim() !== s.label || ret !== (s.retention_days ? String(s.retention_days) : '');
  return (
    <div className={cx('py-3 first:pt-0 last:pb-0', s.missing_since && 'opacity-75')}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-[12.5px] text-ink-3 ltr">{s.name}</span>
            {s.server_id != null && <span className="chip">{t('سرور دیگر', 'Another server')}</span>}
            {s.missing_since ? (
              <span className="chip !text-warn" title={t(`از ${relative(s.missing_since)} پوشه‌ی آن پیدا نمی‌شود؛ داده‌های قبلی نگه داشته شده`, `Its folder has not been found since ${relative(s.missing_since)}; previous data is kept`)}>
                {t('حذف‌شده از سرور', 'Removed from server')}
              </span>
            ) : (
              !s.enabled && <span className="chip">{t('غیرفعال', 'Disabled')}</span>
            )}
            {s.syncing && <Spinner size={12} />}
          </div>
          <div className="text-[12px] text-ink-3">
            <span className="num">{int(s.total_requests)}</span> {t('درخواست', 'requests')} · <span className="num">{int(s.total_sessions)}</span> {t('گفتگو', 'conversations')}
            {s.last_sync_at && <> · {t('همگام', 'synced')} {relative(s.last_sync_at)}</>}
          </div>
          {s.path && s.path !== s.name && <div className="text-[11px] text-ink-3 mono ltr truncate text-start">/sources/{s.path}</div>}
        </div>
        {s.missing_since ? (
          <button className="btn btn-ghost btn-sm" onClick={onDelete} aria-label={t(`حذف ${s.label}`, `Delete ${s.label}`)} title={t('حذف منبع و داده‌هایش', 'Delete the source and its data')}>
            <Trash2 size={14} />
          </button>
        ) : (
          <Switch checked={s.enabled} onChange={(v) => patch.mutate({ enabled: v })} label={t(`فعال بودن ${s.label}`, `${s.label} enabled`)} />
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2 mt-2 items-end">
        <Field label={t('نام نمایشی', 'Display name')}>
          <input className="input !h-9" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={t('نگهداری (روز)', 'Retention (days)')}>
          <input className="input !h-9 !w-28 num" type="number" min={1} max={3650} placeholder={t('سراسری', 'Global')} value={ret} onChange={(e) => setRet(e.target.value)} />
        </Field>
        <button
          className="btn !h-9"
          disabled={!dirty || patch.isPending || !label.trim()}
          onClick={() => patch.mutate({ label: label.trim(), retention_days: ret === '' ? null : Number(ret) })}
          aria-label={t(`ذخیره‌ی ${s.label}`, `Save ${s.label}`)}
        >
          {patch.isPending ? <Spinner size={14} /> : <Check size={15} />}
        </button>
      </div>
    </div>
  );
}

// ---------- remote servers ----------
function ServersCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['servers'], queryFn: () => get<{ servers: ServerInfo[] }>('/api/servers') });
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<ServerInfo | null>(null);
  const refresh = useMutation({
    mutationFn: (id: number) => api<{ sources: number }>('POST', `/api/servers/${id}/refresh`),
    onSuccess: (r) => {
      toast('ok', t(`${int(r?.sources)} منبع پیدا شد؛ همگام‌سازی شروع شد`, `${int(r?.sources)} sources found; sync started`));
      qc.invalidateQueries();
    },
    onError: (e) => {
      toast('err', errorText(e));
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: number; enabled: boolean }) => api('PATCH', `/api/servers/${v.id}`, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
    onError: (e) => toast('err', errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/servers/${id}`),
    onSuccess: () => {
      setDel(null);
      toast('ok', t('سرور و داده‌هایش حذف شد', 'The server and its data were deleted'));
      qc.invalidateQueries();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  return (
    <Card
      title={t('سرورهای دیگر', 'Other servers')}
      icon={<Server size={16} />}
      actions={
        <button className="btn btn-sm" onClick={() => setAdding(true)}>
          <Plus size={14} /> {t('افزودن سرور', 'Add server')}
        </button>
      }
    >
      <p className="m-0 mb-3 text-[12.5px] text-ink-3">
        {t('9router‌های یک ماشین دیگر، یا گفتگوهای Cursor روی کامپیوتر ویندوزی افراد را هم با همین نمودارها ببینید. روی آن ماشین یک «agent» فقط‌خواندنی نصب می‌شود و داشبورد خودش هر چند دقیقه از آن می‌خواند.', 'See 9routers on another machine, or Cursor conversations on people’s Windows computers, in the same charts. A read-only agent is installed on that machine, and the dashboard reads from it every few minutes.')}
      </p>
      {q.isLoading ? (
        <Skeleton className="h-20" />
      ) : q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.servers.length ? (
        <Empty title={t('هنوز سرور دیگری اضافه نشده', 'No other server has been added yet')} hint={t('راهنمای نصب: docs/servers.md (سرور 9router) و docs/windows-agent.html (کامپیوتر ویندوزی).', 'Setup guide: docs/servers.md (9router server) and docs/windows-agent.html (Windows computer).')} />
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {q.data.servers.map((v) => (
            <div key={v.id} className="py-3 first:pt-0 last:pb-0 flex items-center gap-3">
              <div className="min-w-0 grow">
                <div className="flex items-center gap-2">
                  <b className="text-[13.5px]">{v.label}</b>
                  <span className="mono text-[12px] text-ink-3">{v.name}</span>
                  {v.kind === 'windows' && <span className="chip">{t('ویندوز · Cursor', 'Windows · Cursor')}</span>}
                  {!v.enabled && <span className="chip">{t('غیرفعال', 'Disabled')}</span>}
                </div>
                <div className="mono text-[11.5px] text-ink-3 truncate" title={v.url}>
                  {v.url}
                </div>
                <div className={cx('text-[12px]', v.last_error ? 'text-bad' : 'text-ink-3')}>
                  {v.last_error ? agentErrorText(v.last_error) : v.last_seen_at ? <>{t('در دسترس', 'Available')} · {relative(v.last_seen_at)}</> : t('هنوز بررسی نشده', 'Not checked yet')}
                  {' · '}
                  <span className="num">{int(v.source_count)}</span> {t('منبع', 'sources')}
                </div>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => refresh.mutate(v.id)} disabled={refresh.isPending} aria-label={t(`بررسی دوباره‌ی ${v.label}`, `Check ${v.label} again`)} title={t('بررسی دوباره و همگام‌سازی', 'Check again and sync')}>
                {refresh.isPending && refresh.variables === v.id ? <Spinner size={14} /> : <RefreshCw size={14} />}
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setDel(v)} aria-label={t(`حذف ${v.label}`, `Delete ${v.label}`)} title={t('حذف سرور', 'Delete server')}>
                <Trash2 size={14} />
              </button>
              <Switch checked={v.enabled} onChange={(on) => toggle.mutate({ id: v.id, enabled: on })} label={t(`فعال بودن ${v.label}`, `${v.label} enabled`)} />
            </div>
          ))}
        </div>
      )}
      <AddServerModal open={adding} onClose={() => setAdding(false)} />
      <Confirm
        open={!!del}
        title={t('حذف سرور', 'Delete server')}
        body={t(`سرور «${del?.label ?? ''}» با همه‌ی منبع‌ها، کاربران و گفتگوهای ذخیره‌شده از آن برای همیشه حذف می‌شود. ادامه می‌دهید؟`, `Server “${del?.label ?? ''}” and all of its sources, users, and stored conversations are deleted permanently. Continue?`)}
        confirmLabel={t('حذف', 'Delete')}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
        busy={remove.isPending}
      />
    </Card>
  );
}

/** `pd-agent install` prints this: port, secret path, HMAC key and certificate hash of a Windows agent. */
interface Pairing {
  host: string;
  port: number;
  prefix: string;
  secret: string;
  cert: string;
}
function readPairing(code: string): Pairing | null {
  const m = /^pda1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) return null;
  try {
    const p = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))) as Pairing;
    return p.port && p.prefix && /^[0-9a-f]{64,}$/.test(p.secret) && /^[0-9a-f]{64}$/.test(p.cert) ? p : null;
  } catch {
    return null;
  }
}
const shortName = (host: string) =>
  host
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function AddServerModal({ open, onClose, only }: { open: boolean; onClose: () => void; only?: 'windows' }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'windows' | 'server'>('windows');
  const [f, setF] = useState({ name: '', label: '', url: '', token: '', code: '', address: '' });
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (open) {
      setF({ name: '', label: '', url: '', token: '', code: '', address: '' });
      setProbe(null);
    }
  }, [open]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = { ...f, [k]: e.target.value };
    if (k === 'code') {
      const p = readPairing(e.target.value);
      if (p) {
        next.name ||= shortName(p.host);
        next.label ||= p.host;
      }
    }
    setF(next);
    setProbe(null);
  };
  const pairing = readPairing(f.code);
  const address = f.address.trim();
  // what goes to the API: a Windows PC is reached at https://<address>:<port>/<secret path> with a pinned certificate
  const conn =
    kind === 'windows'
      ? pairing && address
        ? { url: `https://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${pairing.port}/${pairing.prefix}`, token: pairing.secret, cert: pairing.cert }
        : null
      : f.url.trim() && f.token.trim().length >= 16
        ? { url: f.url, token: f.token }
        : null;
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; sources?: string[]; error?: string }>('POST', '/api/servers/probe', conn),
    onSuccess: (r) => setProbe(r?.ok ? { ok: true, text: t(`وصل شد؛ ${int(r.sources?.length)} منبع: ${r.sources?.join('، ')}`, `Connected; ${int(r.sources?.length)} sources: ${r.sources?.join(', ')}`) } : { ok: false, text: agentErrorText(r?.error ?? t('ناموفق', 'failed')) }),
    onError: (e) => setProbe({ ok: false, text: errorText(e) }),
  });
  const save = useMutation({
    mutationFn: () => api<{ sources: number }>('POST', '/api/servers', { name: f.name, label: f.label || undefined, ...conn }),
    onSuccess: (r) => {
      toast('ok', t(`سرور اضافه شد؛ ${int(r?.sources)} منبع پیدا شد و همگام‌سازی شروع شد`, `Server added; ${int(r?.sources)} sources found and sync started`));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => setProbe({ ok: false, text: errorText(e) }),
  });
  const ready = f.name.trim() && conn;
  return (
    <Modal open={open} onClose={onClose} title={only ? t('افزودن کامپیوتر ویندوزی', 'Add a Windows computer') : t('افزودن سرور', 'Add a server')} width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <div className={cx('flex gap-1', only && 'hidden')} role="tablist" aria-label={t('نوع', 'Type')}>
          {(
            [
              ['windows', t('کامپیوتر ویندوزی (Cursor)', 'Windows computer (Cursor)')],
              ['server', t('سرور 9router', '9router server')],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={cx('btn btn-sm', kind === k ? 'btn-primary' : 'btn-ghost')} onClick={() => (setKind(k), setProbe(null))}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'windows' ? (
          <>
            <Field label={t('کد اتصال', 'Pairing code')} hint={t('خروجی «pd-agent install» روی آن کامپیوتر (با pda1. شروع می‌شود). کلید agent در آن است: جای دیگری نگذارید.', 'Output of “pd-agent install” on that computer (it starts with pda1.). The agent key is inside it: do not put it anywhere else.')}>
              <textarea className="input ltr mono text-[11.5px] min-h-[72px]" value={f.code} onChange={set('code')} spellCheck={false} autoComplete="off" autoFocus />
            </Field>
            {f.code.trim() && !pairing && <div className="text-[12.5px] text-bad">{t('کد اتصال معتبر نیست.', 'The pairing code is not valid.')}</div>}
            <Field label={t('نشانی آن کامپیوتر', 'Address of that computer')} hint={pairing ? t(`IP یا نام آن کامپیوتر در شبکه؛ پورت ${pairing.port} از کد اتصال برداشته می‌شود.`, `IP or name of that computer on the network; port ${pairing.port} is taken from the pairing code.`) : t('IP یا نام آن کامپیوتر در شبکه.', 'IP or name of that computer on the network.')}>
              <input className="input ltr" value={f.address} onChange={set('address')} placeholder="192.168.1.50" />
            </Field>
            <Field label={t('نام کوتاه', 'Short name')} hint={t('فقط حروف انگلیسی و عدد؛ پیشوند منبع‌ها می‌شود. بعداً تغییر نمی‌کند.', 'Letters and digits only; it becomes the source prefix. It cannot be changed later.')}>
              <input className="input ltr" value={f.name} onChange={set('name')} placeholder="pc-sahebi" />
            </Field>
            <Field label={t('نام نمایشی (اختیاری)', 'Display name (optional)')}>
              <input className="input" value={f.label} onChange={set('label')} />
            </Field>
          </>
        ) : (
          <>
            <Field label={t('نام کوتاه', 'Short name')} hint={t('فقط حروف انگلیسی و عدد؛ پیشوند منبع‌ها می‌شود، مثلاً office/sales. بعداً تغییر نمی‌کند.', 'Letters and digits only; it becomes the source prefix, for example office/sales. It cannot be changed later.')}>
              <input className="input ltr" value={f.name} onChange={set('name')} placeholder="office" autoFocus />
            </Field>
            <Field label={t('نام نمایشی (اختیاری)', 'Display name (optional)')}>
              <input className="input" value={f.label} onChange={set('label')} />
            </Field>
            <Field label={t('نشانی agent', 'Agent address')}>
              <input className="input ltr" value={f.url} onChange={set('url')} placeholder="http://192.168.1.100:9011" />
            </Field>
            <Field label={t('توکن', 'Token')} hint={t('همان AGENT_TOKEN روی سرور مقصد (دست‌کم ۱۶ نویسه).', 'The AGENT_TOKEN on the destination server (at least 16 characters).')}>
              <input className="input ltr" type="password" autoComplete="off" value={f.token} onChange={set('token')} />
            </Field>
          </>
        )}
        {probe && (
          <div role="status" className={cx('text-[12.5px] rounded-lg px-3 py-2', probe.ok ? 'bg-surface-2 text-ink-2' : 'bg-surface-2 text-bad')}>
            {probe.ok && <Check size={14} className="inline me-1" />}
            {probe.text}
          </div>
        )}
        <div className="flex gap-2 mt-1">
          <button className="btn btn-primary" disabled={!ready || save.isPending}>
            {save.isPending && <Spinner size={14} />} {t('افزودن', 'Add')}
          </button>
          <button type="button" className="btn" disabled={!conn || test.isPending} onClick={() => test.mutate()}>
            {test.isPending && <Spinner size={14} />} {t('آزمایش اتصال', 'Test connection')}
          </button>
          <button type="button" className="btn btn-ghost ms-auto" onClick={onClose}>
            {t('انصراف', 'Cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- users ----------
function UsersCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['users-all'], queryFn: () => get<{ users: UserRow[] }>('/api/users', { from: '2000-01-01', to: todayYmd() }) });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => get<{ sources: SourceInfo[] }>('/api/sources') });
  const srcName = new Map((sources.data?.sources ?? []).map((s) => [s.id, s.label]));
  const [rename, setRename] = useState<UserRow | null>(null);
  const [merge, setMerge] = useState<UserRow | null>(null);
  const [filter, setFilter] = useState('');

  const users = (q.data?.users ?? []).filter((u) => !filter || `${u.name} ${u.hint} ${u.fingerprint}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card title={t('کلیدهای API', 'API keys')} icon={<Users size={16} />}>
      <p className="m-0 mb-3 text-[12.5px] text-ink-3">
        {t('هر کلید API در 9router با نام خودش نمایش داده می‌شود (خود کلید ذخیره نمی‌شود). کاربرانی که از هر کلید استفاده کرده‌اند (حساب سیستم‌عامل) زیر نام کلید آمده‌اند. می‌توانید برای کلید نام نمایشی بگذارید یا دو کلید را ادغام کنید.', 'Each API key in 9router is shown under its own name (the key itself is not stored). People who used a key (operating-system accounts) are listed under that name. You can set a display name for a key or merge two keys.')}
      </p>
      <input className="input mb-3" placeholder={t('جستجوی کاربر…', 'Search users…')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('جستجوی کاربر', 'Search users')} />
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !users.length ? (
        <Empty title={t('کاربری نیست', 'No users')} />
      ) : (
        <div className="max-h-[520px] overflow-y-auto -mx-1 px-1">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('کاربر', 'User')}</th>
                <th>{t('منبع', 'Source')}</th>
                <th className="n">{t('گفتگو', 'Conversations')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="font-medium ltr text-start">{u.name}</div>
                    {u.hint && u.hint !== u.name && <div className="text-[11px] text-ink-3 mono truncate max-w-[220px]">{u.hint}</div>}
                    {!!u.machines?.length && (
                      <div className="text-[11px] text-ink-3 truncate max-w-[260px]" title={u.machines.join(t('، ', ', '))}>
                        {t('کاربران:', 'Users:')} <span className="ltr">{u.machines.join(t('، ', ', '))}</span>
                      </div>
                    )}
                  </td>
                  <td className="text-ink-2">{srcName.get(u.source_id) ?? u.source_id}</td>
                  <td className="n num">{int(u.sessions)}</td>
                  <td className="whitespace-nowrap text-end">
                    <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setRename(u)} aria-label={t(`تغییر نام ${u.name}`, `Rename ${u.name}`)} title={t('تغییر نام', 'Rename')}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setMerge(u)} aria-label={t(`ادغام ${u.name}`, `Merge ${u.name}`)} title={t('ادغام با کاربر دیگر', 'Merge with another user')}>
                      <GitMerge size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RenameModal user={rename} onClose={() => setRename(null)} onDone={() => qc.invalidateQueries()} toast={toast} />
      <MergeModal user={merge} all={q.data?.users ?? []} onClose={() => setMerge(null)} onDone={() => qc.invalidateQueries()} toast={toast} />
    </Card>
  );
}

type ToastFn = ReturnType<typeof useToast>;

function RenameModal({ user, onClose, onDone, toast }: { user: UserRow | null; onClose: () => void; onDone: () => void; toast: ToastFn }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  useEffect(() => setName(user?.display_name ?? ''), [user]);
  const m = useMutation({
    mutationFn: () => api('PATCH', `/api/users/${user!.id}`, { display_name: name.trim() || null }),
    onSuccess: () => {
      toast('ok', t('نام ذخیره شد', 'Name saved'));
      onDone();
      onClose();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  return (
    <Modal open={!!user} onClose={onClose} title={t('تغییر نام نمایشی', 'Change display name')} width={440}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label={t('نام نمایشی', 'Display name')} hint={t(`شناسه‌ی اصلی: ${user?.hint || user?.fingerprint || ''} — خالی بگذارید تا همان نمایش داده شود.`, `Original id: ${user?.hint || user?.fingerprint || ''} — leave empty to show that.`)}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={m.isPending}>
            {m.isPending && <Spinner size={14} />} {t('ذخیره', 'Save')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('انصراف', 'Cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MergeModal({ user, all, onClose, onDone, toast }: { user: UserRow | null; all: UserRow[]; onClose: () => void; onDone: () => void; toast: ToastFn }) {
  const { t } = useI18n();
  const [into, setInto] = useState<number | ''>('');
  useEffect(() => setInto(''), [user]);
  const candidates = all.filter((u) => user && u.id !== user.id && u.source_id === user.source_id);
  const m = useMutation({
    mutationFn: () => api('POST', `/api/users/${user!.id}/merge`, { into }),
    onSuccess: () => {
      toast('ok', t('ادغام انجام شد', 'Merged'));
      onDone();
      onClose();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  return (
    <Modal open={!!user} onClose={onClose} title={t('ادغام کاربر', 'Merge user')} width={460}>
      <p className="m-0 mb-4 text-[13px] text-ink-2">
        {t('همه‌ی گفتگوها و درخواست‌های ', 'All conversations and requests for ')}<b className="ltr">{user?.name}</b>{t(' به کاربر انتخابی منتقل می‌شود و رکوردهای بعدی هم به همان کاربر می‌رسند. این کار برگشت‌پذیر نیست.', ' are moved to the selected user, and later records go to that user too. This cannot be undone.')}
      </p>
      {candidates.length === 0 ? (
        <div className="text-[13px] text-ink-3 mb-4">{t('کاربر دیگری در همین منبع وجود ندارد.', 'There is no other user in this source.')}</div>
      ) : (
        <Field label={t('ادغام در', 'Merge into')}>
          <select className="input" value={into} onChange={(e) => setInto(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('انتخاب کنید…', 'Select…')}</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({int(u.sessions)} {t('گفتگو', 'conversations')})
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex gap-2 mt-5">
        <button className="btn btn-primary btn-danger" disabled={!into || m.isPending} onClick={() => m.mutate()}>
          {m.isPending && <Spinner size={14} />} {t('ادغام', 'Merge')}
        </button>
        <button className="btn" onClick={onClose}>
          {t('انصراف', 'Cancel')}
        </button>
      </div>
    </Modal>
  );
}

// ---------- password ----------
function PasswordCard() {
  const { t } = useI18n();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [rep, setRep] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api('POST', '/api/auth/password', { current: cur, next }),
    onSuccess: () => {
      toast('ok', t('رمز عبور تغییر کرد', 'Password changed'));
      setCur('');
      setNext('');
      setRep('');
      setErr(null);
    },
    onError: (e) => setErr(errorText(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setErr(t('رمز جدید باید دست‌کم ۸ نویسه باشد.', 'The new password must be at least 8 characters.'));
    if (next !== rep) return setErr(t('تکرار رمز جدید یکسان نیست.', 'The new passwords do not match.'));
    setErr(null);
    m.mutate();
  };
  const type = show ? 'text' : 'password';
  return (
    <Card
      title={t('تغییر رمز عبور', 'Change password')}
      icon={<KeyRound size={16} />}
      actions={
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setShow(!show)} aria-label={show ? t('پنهان کردن رمز', 'Hide password') : t('نمایش رمز', 'Show password')}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      }
    >
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Field label={t('رمز فعلی', 'Current password')}>
          <input className="input ltr" type={type} autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label={t('رمز جدید', 'New password')}>
          <input className="input ltr" type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t('تکرار رمز جدید', 'Repeat new password')}>
          <input className="input ltr" type={type} autoComplete="new-password" value={rep} onChange={(e) => setRep(e.target.value)} />
        </Field>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button className="btn btn-primary" disabled={!cur || !next || m.isPending}>
            {m.isPending && <Spinner size={14} />} {t('تغییر رمز', 'Change password')}
          </button>
          {err && (
            <span role="alert" className="text-bad text-[12.5px]">
              {err}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------- storage ----------
function StorageCard() {
  const { t } = useI18n();
  const s = useSettings();
  const d = s.data;
  const usedPct = d?.disk ? Math.round(((d.disk.total - d.disk.free) / d.disk.total) * 100) : null;
  return (
    <Card title={t('فضای ذخیره‌سازی', 'Storage')} icon={<HardDrive size={16} />}>
      {s.isLoading ? (
        <Skeleton className="h-40" />
      ) : s.error ? (
        <ErrorBox error={s.error} retry={() => s.refetch()} />
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-xl bg-surface-2 px-3.5 py-3">
              <div className="text-[12px] text-ink-3">{t('حجم دیتابیس', 'Database size')}</div>
              <div className="num text-[22px] font-bold text-start">{bytes(d.db_bytes)}</div>
            </div>
            <div className="rounded-xl bg-surface-2 px-3.5 py-3">
              <div className="text-[12px] text-ink-3">{t('فضای آزاد دیسک', 'Free disk space')}</div>
              <div className="num text-[22px] font-bold text-start">{d.disk ? bytes(d.disk.free) : '—'}</div>
              {d.disk && usedPct != null && (
                <div className="mt-1.5">
                  <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden" role="meter" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100} aria-label={t('درصد استفاده از دیسک', 'Disk usage percent')}>
                    <div className={cx('h-full rounded-full', usedPct > 90 ? 'bg-bad' : usedPct > 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${usedPct}%` }} />
                  </div>
                  <div className="text-[11px] text-ink-3 mt-1">
                    <span className="num">{usedPct}%</span> {t('از', 'of')} <span className="num">{bytes(d.disk.total)}</span> {t('پر است', 'is used')}
                  </div>
                </div>
              )}
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('جدول', 'Table')}</th>
                <th className="n">{t('ردیف (تقریبی)', 'Rows (approx.)')}</th>
                <th className="n">{t('حجم', 'Size')}</th>
              </tr>
            </thead>
            <tbody>
              {d.tables.map((row) => (
                <tr key={row.name}>
                  <td className="mono text-[12.5px]">{row.name}</td>
                  <td className="n num">{row.rows < 0 ? '—' : int(row.rows)}</td>
                  <td className="n num">{bytes(row.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11.5px] text-ink-3 mt-3 flex justify-between">
            <span>
              {t('نسخه', 'Version')} <span className="num">{d.version}</span>
            </span>
            {d.retention_last && (
              <span>
                {t('آخرین پاک‌سازی:', 'Last cleanup:')} {uiDate(d.retention_last.at)} <span className="num">{timeOf(d.retention_last.at)}</span>
              </span>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}
