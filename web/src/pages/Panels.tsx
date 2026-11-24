import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Laptop,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Confirm, cx, Empty, ErrorBox, Field, Modal, PageHeader, Skeleton, Spinner, useToast } from '../components/ui';
import { agentErrorText, api, errorText, get, PanelCheck, PanelInfo, PanelStatus, PcInfo, PcProfile, ServerInfo } from '../lib/api';
import { compact, int, relative } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { addressOf, AgentUpdate, isOnline, StopAgentButton } from './PcSection';
import { AddServerModal } from './Settings';

type Kind = 'gateway' | 'pc' | 'cursor' | 'codex' | 'agent';
type KindFilter = 'all' | Kind | 'windows';
type StatusFilter = 'all' | 'up' | 'down' | 'missing' | 'no_domain' | 'no_password';
type SortKey = 'name' | 'kind' | 'group' | 'status' | 'access' | 'requests' | 'last';

type AccessItem = {
  key: string;
  kind: Kind;
  name: string;
  group: string;
  status: 'up' | 'down' | 'unknown' | 'missing' | 'disabled';
  access: string;
  lastAt: string | null;
  requests: number;
  tokens?: number;
  sourceId?: number | null;
  panel?: PanelInfo;
  pc?: PcInfo;
  profile?: Partial<PcProfile> & { name: string };
  server?: ServerInfo;
};

type Toast = ReturnType<typeof useToast>;

// The dashboard is usually opened over plain http, where navigator.clipboard does not exist.
async function copyText(text: string, toast: Toast, t: (fa: string, en: string) => string, what?: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy');
    }
    toast('ok', what ?? t('کپی شد', 'Copied'));
  } catch {
    toast('err', t('کپی نشد؛ مرورگر اجازه نداد', "Couldn't copy; the browser blocked it"));
  }
}

// 9routers are reached only through their domains: the panel/API domain and the public quota page's domain
const quotaPage = (p: PanelInfo) => (p.quota_domain ? `${p.quota_domain}/quota` : null);
const apiEndpoint = (p: PanelInfo) => (p.panel_domain ? `${p.panel_domain}/v1` : null);

const hostOf = (u: string) => u.replace(/^https?:\/\//, '');

export default function Panels() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['panels'], queryFn: () => get<{ panels: PanelInfo[]; keep_days: number }>('/api/panels'), refetchInterval: 60_000 });
  const status = useQuery({ queryKey: ['panels-status'], queryFn: () => get<PanelStatus>('/api/panels/status'), refetchInterval: 60_000 });
  const pcs = useQuery({ queryKey: ['pcs'], queryFn: () => get<{ pcs: PcInfo[]; agent: { version: string; min: string; minStop?: string } | null }>('/api/pcs'), refetchInterval: 60_000 });
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => get<{ servers: ServerInfo[] }>('/api/servers'), refetchInterval: 60_000 });
  const [sp, setSp] = useSearchParams();
  const patchSp = (next: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    n.delete('tab');
    for (const [k, v] of Object.entries(next)) {
      if (v == null) n.delete(k);
      else n.set(k, v);
    }
    setSp(n, { replace: true });
  };
  const text = sp.get('q') ?? '';
  const org = sp.has('org') ? (sp.get('org') ?? '') : null;
  const kindFilter: KindFilter = (['all', 'gateway', 'windows', 'pc', 'cursor', 'codex', 'agent'].includes(sp.get('kind') ?? '')
    ? sp.get('kind')
    : sp.get('tab') === 'pcs'
      ? 'windows'
      : 'all') as KindFilter;
  const statusFilter = (['all', 'up', 'down', 'missing', 'no_domain', 'no_password'].includes(sp.get('st') ?? '') ? sp.get('st') : 'all') as StatusFilter;
  const [addingPc, setAddingPc] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [editing, setEditing] = useState<PanelInfo | 'new' | null>(null);
  const [removing, setRemoving] = useState<PanelInfo | null>(null);
  const [purging, setPurging] = useState<PanelInfo | null>(null);
  const [delPc, setDelPc] = useState<PcInfo | null>(null);
  const [updatingPc, setUpdatingPc] = useState<number | null>(null);
  const [stopPc, setStopPc] = useState<PcInfo | null>(null);
  const [stoppingPc, setStoppingPc] = useState<number | null>(null);
  const [binOpen, setBinOpen] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['panels'] });
    qc.invalidateQueries({ queryKey: ['panels-status'] });
  };
  const remove = useMutation({
    mutationFn: (p: PanelInfo) => api('DELETE', `/api/panels/${p.id}`),
    onSuccess: (_r, p) => {
      setRemoving(null);
      setEditing(null);
      setBinOpen(true);
      toast('ok', t(`«${p.name}» به حذف‌شده‌ها رفت؛ تا ${int(keepDays)} روز قابل بازیابی است`, `"${p.name}" was moved to deleted items and can be restored for ${int(keepDays)} days`));
      refresh();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const restore = useMutation({
    mutationFn: (p: PanelInfo) => api('POST', `/api/panels/${p.id}/restore`),
    onSuccess: (_r, p) => {
      toast('ok', t(`«${p.name}» برگشت`, `"${p.name}" was restored`));
      refresh();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const purge = useMutation({
    mutationFn: (p: PanelInfo) => api('DELETE', `/api/panels/${p.id}?now=1`),
    onSuccess: (_r, p) => {
      setPurging(null);
      toast('ok', t(`«${p.name}» برای همیشه حذف شد`, `"${p.name}" was deleted permanently`));
      refresh();
    },
    onError: (e) => toast('err', errorText(e)),
  });

  const recheckPcs = useMutation({
    mutationFn: () => api<{ checked: number; reachable: number }>('POST', '/api/pcs/refresh'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['pcs'] });
      toast('ok', t(`${int(r.reachable)} از ${int(r.checked)} کامپیوتر جواب داد`, `${int(r.reachable)} of ${int(r.checked)} computers responded`));
    },
    onError: (e) => toast('err', errorText(e)),
  });

  const detect = useMutation({
    mutationFn: async () => {
      await api('POST', '/api/sources/discover');
      await api('POST', '/api/panels/detect');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['panels'] });
      status.refetch();
      toast('ok', t('پنل‌ها و وضعیت‌شان دوباره بررسی شد', 'Panels and their status were checked again'));
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const updatePc = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; version: string; already?: boolean }>('POST', `/api/pcs/${id}/update-agent`),
    onMutate: (id) => setUpdatingPc(id),
    onSettled: () => setUpdatingPc(null),
    onSuccess: (r, id) => {
      const pc = (pcs.data?.pcs ?? []).find((p) => p.id === id);
      const name = pc?.info?.agent?.host || pc?.label;
      toast('ok', r.already ? t(`${name ?? 'این کامپیوتر'} همین حالا نسخه ${r.version} است.`, `${name ?? 'This computer'} is already on version ${r.version}.`) : t(`نسخه ${r.version} به ${name ?? 'کامپیوتر'} فرستاده شد.`, `Version ${r.version} was sent to ${name ?? 'the computer'}.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const stopPcMut = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean }>('POST', `/api/pcs/${id}/stop-agent`),
    onMutate: (id) => setStoppingPc(id),
    onSettled: () => setStoppingPc(null),
    onSuccess: (_r, id) => {
      const pc = (pcs.data?.pcs ?? []).find((p) => p.id === id);
      const name = pc?.info?.agent?.host || pc?.label;
      setStopPc(null);
      toast('ok', t(`سرویس PD Agent روی «${name ?? ''}» متوقف می‌شود. در Services باید Stopped باشد.`, `PD Agent on “${name ?? ''}” is stopping. In Services it should show Stopped.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const removePc = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/servers/${id}`),
    onSuccess: () => {
      const name = delPc?.info?.agent?.host || delPc?.label;
      setDelPc(null);
      toast('ok', t(`«${name ?? ''}» از داشبورد حذف شد.`, `“${name ?? ''}” was removed from the dashboard.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const checkAll = () => {
    detect.mutate();
    recheckPcs.mutate();
  };

  const all = q.data?.panels ?? [];
  const keepDays = q.data?.keep_days ?? 5;
  const panels = all.filter((p) => !p.deleted_at);
  const deleted = all.filter((p) => p.deleted_at).sort((a, b) => (a.purge_at ?? '').localeCompare(b.purge_at ?? ''));
  const st = status.data?.status ?? {};
  const pcList = pcs.data?.pcs ?? [];
  const remoteAgents = (servers.data?.servers ?? []).filter((s) => s.kind === 'server');
  const items = useMemo(() => buildAccessItems(panels, st, pcList, remoteAgents), [panels, st, pcList, remoteAgents]);
  const groups = useMemo(() => [...new Set(items.map((i) => i.group))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))), [items]);
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return items.filter((i) => {
      if (kindFilter === 'windows' && i.kind !== 'pc' && i.kind !== 'cursor' && i.kind !== 'codex') return false;
      if (kindFilter !== 'all' && kindFilter !== 'windows' && i.kind !== kindFilter) return false;
      if (org !== null && i.group !== org) return false;
      if (statusFilter === 'up' && i.status !== 'up') return false;
      if (statusFilter === 'down' && i.status !== 'down') return false;
      if (statusFilter === 'missing' && i.status !== 'missing') return false;
      if (statusFilter === 'no_domain' && !(i.kind === 'gateway' && i.panel && (!i.panel.panel_domain || !i.panel.quota_domain))) return false;
      if (statusFilter === 'no_password' && !(i.kind === 'gateway' && i.panel && !i.panel.has_password)) return false;
      if (!needle) return true;
      return [i.name, i.group, i.access, i.panel?.container, i.panel?.notes, i.profile?.email, i.profile?.account].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [items, kindFilter, org, statusFilter, text]);
  const filtered = statusFilter !== 'all' || org !== null || kindFilter !== 'all' || !!text.trim();
  const setStatus = (v: StatusFilter) => patchSp({ st: v === 'all' ? null : v });
  const setKind = (v: KindFilter) => patchSp({ kind: v === 'all' ? null : v });
  const up = items.filter((i) => i.status === 'up').length;
  const down = items.filter((i) => i.status === 'down').length;
  const missing = items.filter((i) => i.status === 'missing').length;
  const noDomain = items.filter((i) => i.kind === 'gateway' && i.panel && (!i.panel.panel_domain || !i.panel.quota_domain)).length;
  const noPassword = items.filter((i) => i.kind === 'gateway' && i.panel && !i.panel.has_password).length;
  const nGateway = items.filter((i) => i.kind === 'gateway').length;
  const nWindows = items.filter((i) => i.kind === 'pc' || i.kind === 'cursor' || i.kind === 'codex').length;
  const nAgent = items.filter((i) => i.kind === 'agent').length;
  const loading = q.isLoading || pcs.isLoading;
  const loadError = q.error || pcs.error;

  return (
    <>
      <PageHeader
        title={t('پنل‌ها و دسترسی‌ها', 'Panels and access')}
        subtitle={t('همه‌ی 9routerها، کامپیوترهای ویندوز (Cursor و Codex) و agentهای دیگر در یک جدول. با فیلتر نوع را جدا کنید.', 'Every 9router, Windows PC (Cursor and Codex), and other agent in one table. Use the filters to narrow the kind.')}
        actions={
          <>
            <button className="btn btn-sm" onClick={checkAll} disabled={detect.isPending || recheckPcs.isPending || status.isFetching}>
              {detect.isPending || recheckPcs.isPending || status.isFetching ? <Spinner size={13} /> : <RefreshCw size={14} />} {t('بررسی دوباره', 'Check again')}
            </button>
            <button className="btn btn-sm" onClick={() => setAddingPc(true)} title={t('برای کامپیوتری که agent را خودتان نصب کرده‌اید', 'For a computer where you installed the agent yourself')}>
              <Plus size={14} /> {t('با کد اتصال', 'With a connection code')}
            </button>
            <button className="btn btn-sm" onClick={() => setInstallOpen(true)}>
              <SquareTerminal size={14} /> {t('دستور نصب', 'Install command')}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('پنل دیگر', 'Another panel')}
            </button>
          </>
        }
      />

      {loading ? (
        <div className="card overflow-hidden p-4 flex flex-col gap-2">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : loadError ? (
        <ErrorBox error={loadError} retry={() => { q.refetch(); pcs.refetch(); }} />
      ) : !items.length ? (
        <Empty title={t('هنوز موردی نیست', 'Nothing here yet')} hint={t('9routerها پس از پیدا شدن در «تنظیمات ← منبع‌ها» می‌آیند. کامپیوتر ویندوز را با دستور نصب وصل کنید.', '9routers appear after they are found under Settings → Sources. Connect a Windows PC with the install command.')} />
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
            <Stat icon={<Activity size={15} />} label={t('روشن', 'Up')} value={<>{int(up)} <span className="text-[14px] font-semibold text-ink-3">{t('از', 'of')} {int(items.length)}</span></>} tone={down ? 'bad' : 'good'} hint={down ? t(`${int(down)} جواب نمی‌دهد`, `${int(down)} not responding`) : t('همه جواب می‌دهند', 'All responding')} active={statusFilter === 'up'} onClick={() => setStatus(statusFilter === 'up' ? 'all' : 'up')} />
            <Stat icon={<Server size={15} />} label={t('درگاه 9router', '9router')} value={int(nGateway)} hint={t('دامنه و رمز پنل', 'Panel domain and password')} active={kindFilter === 'gateway'} onClick={() => setKind(kindFilter === 'gateway' ? 'all' : 'gateway')} />
            <Stat icon={<Laptop size={15} />} label={t('ویندوز / Cursor / Codex', 'Windows / Cursor / Codex')} value={int(nWindows)} hint={nAgent ? t(`${int(nAgent)} agent دیگر`, `${int(nAgent)} other agent${nAgent === 1 ? '' : 's'}`) : t('پروفایل‌های خوانده‌شده از PC', 'Profiles read from PCs')} active={kindFilter === 'windows'} onClick={() => setKind(kindFilter === 'windows' ? 'all' : 'windows')} />
            <Stat icon={<Globe size={15} />} label={t('بدون دامنه / رمز', 'No domain / password')} value={int(noDomain + noPassword)} tone={noDomain || noPassword ? 'warn' : 'good'} hint={t(`${int(noDomain)} دامنه · ${int(noPassword)} رمز`, `${int(noDomain)} domain · ${int(noPassword)} password`)} active={statusFilter === 'no_domain' || statusFilter === 'no_password'} onClick={() => setStatus(statusFilter === 'no_domain' ? 'no_password' : statusFilter === 'no_password' ? 'all' : 'no_domain')} />
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative grow max-w-[320px]">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-3 pointer-events-none" />
              <input className="input !ps-9 !h-9" value={text} onChange={(e) => patchSp({ q: e.target.value || null })} placeholder={t('نام، دامنه، کامپیوتر، ایمیل…', 'Name, domain, computer, email…')} aria-label={t('جستجو', 'Search')} />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('نوع', 'Kind')}>
              <OrgChip active={kindFilter === 'all'} onClick={() => setKind('all')} label={t('همه', 'All')} n={items.length} />
              <OrgChip active={kindFilter === 'gateway'} onClick={() => setKind(kindFilter === 'gateway' ? 'all' : 'gateway')} label="9router" n={nGateway} />
              <OrgChip active={kindFilter === 'cursor'} onClick={() => setKind(kindFilter === 'cursor' ? 'all' : 'cursor')} label="Cursor" n={items.filter((i) => i.kind === 'cursor').length} />
              <OrgChip active={kindFilter === 'codex'} onClick={() => setKind(kindFilter === 'codex' ? 'all' : 'codex')} label="Codex" n={items.filter((i) => i.kind === 'codex').length} />
              {nAgent > 0 && <OrgChip active={kindFilter === 'agent'} onClick={() => setKind(kindFilter === 'agent' ? 'all' : 'agent')} label={t('agent دیگر', 'Other agent')} n={nAgent} />}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('گروه', 'Group')}>
              <OrgChip active={org === null} onClick={() => patchSp({ org: null })} label={t('همه گروه‌ها', 'All groups')} n={items.length} />
              {groups.map((o) => (
                <OrgChip key={o || '-'} active={org === o} onClick={() => patchSp({ org: org === o ? null : o })} label={o || t('مستقل', 'Standalone')} n={items.filter((i) => i.group === o).length} />
              ))}
              {down > 0 && (
                <OrgChip active={statusFilter === 'down'} onClick={() => setStatus(statusFilter === 'down' ? 'all' : 'down')} label={t('خاموش', 'Down')} n={down} />
              )}
              {missing > 0 && (
                <OrgChip active={statusFilter === 'missing'} onClick={() => setStatus(statusFilter === 'missing' ? 'all' : 'missing')} label={t('حذف‌شده از سرور', 'Removed from server')} n={missing} />
              )}
            </div>
            {filtered && (
              <button className="btn btn-ghost btn-sm !h-8" onClick={() => patchSp({ q: null, org: null, st: null, kind: null })}>
                <X size={13} /> {t('پاک کردن فیلتر', 'Clear filters')}
              </button>
            )}
            {status.data && <span className="text-[11.5px] text-ink-3 ms-auto">{t('وضعیت:', 'Status:')} {relative(status.data.checked_at)}</span>}
          </div>
          <div className="text-[12px] text-ink-3 mb-2">
            {t(`${int(shown.length)} از ${int(items.length)} مورد`, `${int(shown.length)} of ${int(items.length)} items`)}
          </div>

          {!shown.length ? (
            <Empty title={t('موردی با این فیلتر پیدا نشد', 'Nothing matches these filters')} />
          ) : (
            <AccessTable
              items={shown}
              checks={st}
              checking={status.isFetching}
              latest={pcs.data?.agent ?? null}
              updatingId={updatingPc}
              onEdit={setEditing}
              onDeletePanel={setRemoving}
              onDeletePc={setDelPc}
              onUpdatePc={(id) => updatePc.mutate(id)}
              stoppingId={stoppingPc}
              onStopPc={(pc) => setStopPc(pc)}
            />
          )}

          {deleted.length > 0 && (
            <section className="card mt-2" aria-label={t('حذف‌شده‌ها', 'Deleted')}>
              <button className="w-full flex items-center gap-2 flex-wrap px-4 py-3 text-start bg-transparent border-0 cursor-pointer text-ink" onClick={() => setBinOpen(!binOpen)} aria-expanded={binOpen}>
                <Trash2 size={15} className="text-ink-3" />
                <span className="text-[13px] font-bold">{t('حذف‌شده‌ها', 'Deleted')}</span>
                <span className="chip !py-0 num">{deleted.length}</span>
                <span className="text-[11.5px] text-ink-3">{t(`تا ${int(keepDays)} روز قابل بازیابی‌اند، بعد خودکار برای همیشه حذف می‌شوند`, `Restorable for ${int(keepDays)} days, then deleted permanently`)}</span>
                <span className="ms-auto text-[11.5px] text-accent">{binOpen ? t('بستن', 'Close') : t('نمایش', 'Show')}</span>
              </button>
              {binOpen && (
                <ul className="m-0 p-0 list-none border-t border-line">
                  {deleted.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 flex-wrap px-4 py-2.5 border-b border-line last:border-b-0">
                      <div className="min-w-0 grow">
                        <div className="flex items-center gap-1.5">
                          <b className="ltr text-[13.5px]">{p.name}</b>
                          {p.org && <span className="chip !py-0 !text-[10.5px] ltr">{p.org}</span>}
                        </div>
                        <div className="text-[11.5px] text-ink-3">
                          {t('حذف', 'Deleted')} {relative(p.deleted_at)} · <span className="text-warn">{t('حذف کامل', 'Permanently deleted')} {relative(p.purge_at)}</span>
                        </div>
                      </div>
                      <button className="btn btn-sm" onClick={() => restore.mutate(p)} disabled={restore.isPending}>
                        <RotateCcw size={13} /> {t('بازیابی', 'Restore')}
                      </button>
                      <button className="btn btn-ghost btn-sm text-bad" onClick={() => setPurging(p)}>
                        <Trash2 size={13} /> {t('حذف همیشگی', 'Delete permanently')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <AddServerModal open={addingPc} onClose={() => setAddingPc(false)} only="windows" />
      <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} />
      <EditModal panel={editing} onClose={() => setEditing(null)} onDelete={(p) => setRemoving(p)} />
      <Confirm
        open={!!removing}
        title={t('حذف پنل', 'Delete panel')}
        body={
          <>
            «<b className="ltr">{removing?.name}</b>»
            {t(' به بخش «حذف‌شده‌ها» می‌رود و ', ' goes to Deleted and stays there for ')}
            {int(keepDays)}
            {t(' روز آنجا می‌ماند تا اگر خواستید برش گردانید؛ بعد دامنه‌ها، رمز و یادداشتش برای همیشه پاک می‌شود. به خود 9router کاری ندارد.', ' days so you can restore it; then its domains, password, and notes are erased for good. The 9router itself is left alone.')}
          </>
        }
        confirmLabel={t('حذف', 'Delete')}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => setRemoving(null)}
        busy={remove.isPending}
      />
      <Confirm
        open={!!purging}
        title={t('حذف همیشگی', 'Delete permanently')}
        body={<>«<b className="ltr">{purging?.name}</b>» {t('همین حالا با دامنه‌ها و رمزش برای همیشه حذف می‌شود و دیگر برنمی‌گردد.', 'is deleted now, with its domains and password, and cannot be restored.')}</>}
        confirmLabel={t('حذف همیشگی', 'Delete permanently')}
        onConfirm={() => purging && purge.mutate(purging)}
        onClose={() => setPurging(null)}
        busy={purge.isPending}
      />
      <Confirm
        open={!!delPc}
        title={t('حذف کامپیوتر', 'Remove computer')}
        body={t(
          `«${delPc?.info?.agent?.host || delPc?.label || ''}» از داشبورد برداشته می‌شود. agent روی خود کامپیوتر می‌ماند؛ گفتگوهایی که از این اتصال خوانده شده‌اند هم پاک می‌شوند.`,
          `“${delPc?.info?.agent?.host || delPc?.label || ''}” is removed from the dashboard. The agent on the computer stays; conversations already read from this pairing are deleted.`,
        )}
        confirmLabel={t('حذف', 'Delete')}
        onConfirm={() => delPc && removePc.mutate(delPc.id)}
        onClose={() => setDelPc(null)}
        busy={removePc.isPending}
      />
      <Confirm
        open={!!stopPc}
        title={t('توقف سرویس agent', 'Stop the agent service')}
        body={t(
          `سرویس PD Agent روی «${stopPc?.info?.agent?.host || stopPc?.label || ''}» Stop می‌شود تا Cursor بتواند فایل‌هایش را آزاد کند. در Services ویندوز باید Stopped بماند. برای روشن کردن دوباره، Services را با Run as administrator باز کنید و Start بزنید.`,
          `PD Agent on “${stopPc?.info?.agent?.host || stopPc?.label || ''}” will Stop so Cursor can release its files. In Windows Services it should stay Stopped. To start it again, open Services as administrator and click Start.`,
        )}
        confirmLabel={t('توقف سرویس', 'Stop service')}
        onConfirm={() => stopPc && stopPcMut.mutate(stopPc.id)}
        onClose={() => setStopPc(null)}
        busy={stopPcMut.isPending}
      />
    </>
  );
}

function kindLabel(kind: Kind, t: (fa: string, en: string) => string) {
  if (kind === 'gateway') return '9router';
  if (kind === 'cursor') return 'Cursor';
  if (kind === 'codex') return 'Codex';
  if (kind === 'agent') return t('agent', 'agent');
  return t('ویندوز', 'Windows');
}

function pcStatus(pc: PcInfo): AccessItem['status'] {
  if (!pc.enabled) return 'disabled';
  if (pc.last_error) return 'down';
  if (isOnline(pc)) return 'up';
  return pc.last_seen_at ? 'down' : 'unknown';
}

function buildAccessItems(panels: PanelInfo[], checks: PanelStatus['status'], pcs: PcInfo[], agents: ServerInfo[]): AccessItem[] {
  const out: AccessItem[] = [];
  for (const p of panels) {
    const r = checks[p.id]?.router;
    const status: AccessItem['status'] = p.missing_since ? 'missing' : !r ? 'unknown' : r.ok ? 'up' : 'down';
    out.push({
      key: `g-${p.id}`,
      kind: 'gateway',
      name: p.name,
      group: p.org,
      status,
      access: p.panel_domain ? hostOf(p.panel_domain) : '',
      lastAt: p.last_request_at,
      requests: p.requests_today ?? 0,
      tokens: p.tokens_today,
      sourceId: p.source_id,
      panel: p,
    });
  }
  for (const pc of pcs) {
    const host = pc.info?.agent?.host || pc.label;
    const { host: ip, port } = addressOf(pc.url);
    const addr = ip ? `${ip}${port ? `:${port}` : ''}` : '';
    const profiles: Array<Partial<PcProfile> & { name: string; profile: string }> = pc.info?.sources?.length
      ? pc.info.sources
      : pc.sources.map((s) => ({ name: s.remote_name, profile: s.remote_name.replace(/^(cursor|codex)-/, '') }));
    if (!profiles.length) {
      out.push({
        key: `pc-${pc.id}`,
        kind: 'pc',
        name: host,
        group: host,
        status: pcStatus(pc),
        access: addr,
        lastAt: pc.last_seen_at,
        requests: pc.sources.reduce((n, s) => n + Number(s.requests), 0),
        pc,
      });
      continue;
    }
    for (const profile of profiles) {
      const ingested = pc.sources.find((s) => s.remote_name === profile.name);
      const codex = profile.kind === 'codex' || profile.name.startsWith('codex-');
      out.push({
        key: `pc-${pc.id}-${profile.name}`,
        kind: codex ? 'codex' : 'cursor',
        name: profile.account || profile.profile,
        group: host,
        status: pcStatus(pc),
        access: profile.email || addr,
        lastAt: ingested?.last_at ?? profile.last_used ?? pc.last_seen_at,
        requests: ingested?.requests ?? 0,
        sourceId: ingested?.id,
        pc,
        profile,
      });
    }
  }
  for (const s of agents) {
    let host = s.url;
    try {
      host = new URL(s.url).host;
    } catch {
      /* keep */
    }
    out.push({
      key: `ag-${s.id}`,
      kind: 'agent',
      name: s.label || s.name,
      group: s.name,
      status: !s.enabled ? 'disabled' : s.last_error ? 'down' : s.last_seen_at ? 'up' : 'unknown',
      access: host,
      lastAt: s.last_seen_at,
      requests: s.source_count,
      server: s,
    });
  }
  return out;
}

function Stat({ icon, label, value, hint, tone, onClick, active }: { icon: ReactNode; label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'bad'; onClick?: () => void; active?: boolean }) {
  const inner = (
    <>
      <div className="text-[12px] text-ink-3 flex items-center gap-1.5">
        <span className={cx(tone === 'good' && 'text-good', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{icon}</span>
        {label}
      </div>
      <div className="text-[20px] font-extrabold mt-0.5">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-3 truncate">{hint}</div>}
    </>
  );
  const cls = cx('card px-4 py-3 w-full text-start', active && 'ring-1 ring-accent');
  if (!onClick) return <div className={cls}>{inner}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={!!active} className={cx(cls, 'cursor-pointer hover:bg-surface-2 font-sans text-ink')}>
      {inner}
    </button>
  );
}

interface InstallLink {
  id: number;
  created_at: string;
  expires_at: string;
  uses: number;
  last_used_at: string | null;
}

/** One PowerShell line that installs the agent on a PC and pairs it here by itself. */
function InstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const [made, setMade] = useState<{ command: string; expires_at: string } | null>(null);
  const links = useQuery({
    queryKey: ['install-links'],
    queryFn: () => get<{ links: InstallLink[]; ready: boolean; exe: { size: number; sha256: string } | null; allow: string }>('/api/pcs/install-links'),
    enabled: open,
    // while it is open, PCs that ran the command show up on their own
    refetchInterval: open ? 10_000 : false,
  });
  useEffect(() => {
    if (open) setMade(null);
  }, [open]);
  useEffect(() => {
    if (open) qc.invalidateQueries({ queryKey: ['pcs'] });
  }, [open, links.dataUpdatedAt, qc]);
  const create = useMutation({
    mutationFn: () => api<{ command: string; expires_at: string }>('POST', '/api/pcs/install-links', { hours, origin: location.origin }),
    onSuccess: (r) => {
      setMade(r);
      links.refetch();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/pcs/install-links/${id}`),
    onSuccess: () => {
      toast('ok', t('لینک نصب باطل شد', 'Install link revoked'));
      links.refetch();
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const d = links.data;
  return (
    <Modal open={open} onClose={onClose} title={t('نصب agent با یک دستور', 'Install the agent with one command')} width={620}>
      <div className="flex flex-col gap-4">
        <ol className="m-0 ps-5 text-[12.5px] text-ink-2 leading-6 flex flex-col gap-1">
          <li>{t('دستور را بسازید و کپی کنید. با همان یک دستور می‌شود چند کامپیوتر را نصب کرد، تا وقتی اعتبارش تمام نشده.', 'Build the command and copy it. The same command can install several computers until it expires.')}</li>
          <li>{t('روی هر کامپیوتر ویندوزی آن را در PowerShell بچسبانید. اگر دسترسی Administrator نباشد، ویندوز برای ثبت سرویس اجازه می‌خواهد.', 'On each Windows computer, paste it into PowerShell. If you are not an Administrator, Windows asks permission to register the service.')}</li>
          <li>{t('یک زیپ دانلود و در Program Files باز می‌شود. سرویس با sc.exe ساخته می‌شود؛ خود برنامه برای نصب اجرا نمی‌شود.', 'A zip is downloaded and extracted into Program Files. The service is created with sc.exe; the program itself is not run to install.')}</li>
        </ol>

        {d && !d.ready && (
          <div className="text-[12.5px] text-warn bg-surface-2 rounded-md px-3 py-2">
            {!d.exe ? t('فایل pd-agent.exe روی سرور داشبورد نیست؛ ', 'pd-agent.exe is not on the dashboard server; ') : ''}
            {!d.allow ? t('PC_AGENT_ALLOW روی سرور داشبورد تنظیم نشده؛ ', 'PC_AGENT_ALLOW is not set on the dashboard server; ') : ''}
            {t('تا درست نشود دستور نصب ساخته نمی‌شود.', 'The install command cannot be built until this is fixed.')}
          </div>
        )}

        <div className="flex items-end gap-2 flex-wrap">
          <Field label={t('اعتبار دستور', 'Command lifetime')}>
            <select className="input !h-9 !w-auto" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={1}>{t('۱ ساعت', '1 hour')}</option>
              <option value={8}>{t('۸ ساعت', '8 hours')}</option>
              <option value={24}>{t('۱ روز', '1 day')}</option>
              <option value={72}>{t('۳ روز', '3 days')}</option>
              <option value={168}>{t('۷ روز', '7 days')}</option>
            </select>
          </Field>
          <button className="btn btn-primary btn-sm !h-9" onClick={() => create.mutate()} disabled={create.isPending || (d && !d.ready)}>
            {create.isPending ? <Spinner size={13} /> : <SquareTerminal size={14} />} {t('ساخت دستور', 'Build command')}
          </button>
        </div>

        {made && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11.5px] text-ink-3">{t(`دستور، تا ${relative(made.expires_at)} معتبر است. فقط همین یک بار نشان داده می‌شود:`, `The command is valid until ${relative(made.expires_at)}. It is shown only this once:`)}</div>
            <div className="flex items-start gap-1.5">
              <code className="grow min-w-0 ltr text-start text-[11.5px] bg-surface-2 rounded-md px-2.5 py-2 whitespace-pre-wrap break-all select-all">{made.command}</code>
              <button className="btn btn-sm" onClick={() => copyText(made.command, toast, t, t('دستور نصب کپی شد', 'Install command copied'))}>
                <Copy size={14} /> {t('کپی', 'Copy')}
              </button>
            </div>
            <div className="text-[11.5px] text-ink-3">{t('این دستور اجازه‌ی نصب agent و وصل شدن به داشبورد را می‌دهد؛ فقط به کسی که باید نصب کند بدهید.', 'This command allows installing the agent and connecting it to the dashboard. Give it only to the person who should install it.')}</div>
          </div>
        )}

        <div>
          <div className="text-[12px] font-bold text-ink-2 mb-1.5">{t('دستورهای معتبر', 'Active commands')}</div>
          {!d?.links.length ? (
            <div className="text-[12px] text-ink-3">{t('دستور معتبری نیست.', 'No active command.')}</div>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col">
              {d.links.map((l) => (
                <li key={l.id} className="flex items-center gap-3 flex-wrap py-1.5 border-b border-line last:border-b-0 text-[12px]">
                  <span className="text-ink-2">{t('ساخته‌شده', 'Created')} {relative(l.created_at)}</span>
                  <span className="text-ink-3">{t('پایان', 'Expires')} {relative(l.expires_at)}</span>
                  <span className="text-ink-3">
                    <b className="num text-ink-2">{int(l.uses)}</b> {t('کامپیوتر نصب شد', l.uses === 1 ? 'computer installed' : 'computers installed')}{l.last_used_at ? ` · ${t(`آخرین ${relative(l.last_used_at)}`, `last ${relative(l.last_used_at)}`)}` : ''}
                  </span>
                  <button className="btn btn-ghost btn-sm !h-7 ms-auto text-bad" onClick={() => revoke.mutate(l.id)} disabled={revoke.isPending}>
                    <X size={13} /> {t('باطل کردن', 'Revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function OrgChip({ active, onClick, label, n }: { active: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx('btn btn-sm !rounded-full !h-8', active ? '!bg-accent-soft !border-accent-soft-border !text-accent font-semibold' : 'btn-ghost')}
    >
      <span className="ltr">{label}</span> <span className="num text-[11px] opacity-70">{n}</span>
    </button>
  );
}

// ---------- one panel ----------

function Dot({ c, checking, what = '' }: { c: PanelCheck | null | undefined; checking?: boolean; what?: string }) {
  const { t } = useI18n();
  const title = (what ? `${what}: ` : '') + (!c ? (checking ? t('در حال بررسی…', 'Checking…') : t('بررسی نشده', 'Not checked')) : c.ok ? `${t('در دسترس', 'Reachable')}${c.ms != null ? ` · ${c.ms}ms` : ''}${c.code ? ` · HTTP ${c.code}` : ''}` : `${t('در دسترس نیست', 'Unreachable')} (${c.error ?? `HTTP ${c.code}`})`);
  return (
    <span title={title} aria-label={title} className="relative inline-flex size-2.5 shrink-0">
      {c?.ok && <span className="absolute inset-0 rounded-full bg-good opacity-40 animate-ping [animation-duration:2.5s]" />}
      <span className={cx('relative inline-flex size-2.5 rounded-full', !c ? 'bg-line' : c.ok ? 'bg-good' : 'bg-bad')} />
    </span>
  );
}

function AccessTable({
  items,
  checks,
  checking,
  latest,
  updatingId,
  onEdit,
  onDeletePanel,
  onDeletePc,
  onUpdatePc,
  stoppingId,
  onStopPc,
}: {
  items: AccessItem[];
  checks: PanelStatus['status'];
  checking: boolean;
  latest: { version: string; min: string; minStop?: string } | null;
  updatingId: number | null;
  onEdit: (p: PanelInfo) => void;
  onDeletePanel: (p: PanelInfo) => void;
  onDeletePc: (p: PcInfo) => void;
  onUpdatePc: (id: number) => void;
  stoppingId: number | null;
  onStopPc: (p: PcInfo) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'last', dir: -1 });
  const rows = useMemo(() => {
    const list = [...items];
    const rank = (s: AccessItem['status']) => (s === 'down' ? 0 : s === 'missing' || s === 'disabled' ? 1 : s === 'unknown' ? 2 : 3);
    list.sort((a, b) => {
      let c = 0;
      if (sort.k === 'status') c = rank(a.status) - rank(b.status);
      else if (sort.k === 'kind') c = a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
      else if (sort.k === 'group') c = a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
      else if (sort.k === 'access') c = a.access.localeCompare(b.access);
      else if (sort.k === 'requests') c = a.requests - b.requests;
      else if (sort.k === 'last') c = (a.lastAt ?? '').localeCompare(b.lastAt ?? '');
      else c = a.name.localeCompare(b.name);
      return (c || a.name.localeCompare(b.name)) * sort.dir;
    });
    return list;
  }, [items, sort]);

  const th = (k: SortKey, label: string, num = false) => (
    <th className={cx(num && 'n', k === 'name' && 'pin')} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="sortable inline-flex items-center gap-1 bg-transparent border-0 p-0 text-inherit font-inherit cursor-pointer"
        onClick={() => setSort((s) => (s.k === k ? { k, dir: (-s.dir) as 1 | -1 } : { k, dir: k === 'requests' || k === 'last' ? -1 : 1 }))}
      >
        {label}
        {sort.k === k ? sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} className="opacity-40" />}
      </button>
    </th>
  );

  const statusText = (s: AccessItem['status']) =>
    s === 'up' ? t('روشن', 'Up') : s === 'down' ? t('خاموش', 'Down') : s === 'missing' ? t('نیست', 'Gone') : s === 'disabled' ? t('غیرفعال', 'Off') : '—';

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="tbl tbl-dense min-w-[1100px]">
          <thead>
            <tr>
              {th('status', t('وضعیت', 'Status'))}
              {th('name', t('نام', 'Name'))}
              {th('kind', t('نوع', 'Kind'))}
              {th('group', t('گروه / کامپیوتر', 'Group / PC'))}
              {th('access', t('دسترسی', 'Access'))}
              <th>{t('رمز / agent', 'Password / agent')}</th>
              {th('requests', t('فعالیت', 'Activity'), true)}
              {th('last', t('آخرین', 'Last'))}
              <th className="n">{t('کار', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const p = row.panel;
              const pc = row.pc;
              const check = p ? checks[p.id] : undefined;
              const endpoint = p ? apiEndpoint(p) : null;
              const quota = p ? quotaPage(p) : null;
              const handoff = p
                ? [
                    t('سلام، اطلاعات دسترسی شما به 9router:', 'Hello, your 9router access details:'),
                    quota && `${t('صفحه‌ی سهمیه:', 'Quota page:')} ${quota}`,
                    endpoint && `API endpoint: ${endpoint}`,
                    t('کلید API را جداگانه دریافت می‌کنید.', 'You will receive the API key separately.'),
                  ]
                    .filter(Boolean)
                    .join('\n')
                : '';
              return (
                <tr key={row.key} className={cx((row.status === 'missing' || row.status === 'disabled') && 'opacity-70')}>
                  <td>
                    <div className="flex items-center gap-1.5">
                      {p ? (
                        <Dot c={check?.router} checking={checking} what="9router" />
                      ) : (
                        <span className={cx('inline-flex size-2.5 rounded-full', row.status === 'up' ? 'bg-good' : row.status === 'down' ? 'bg-bad' : 'bg-line')} />
                      )}
                      <span className="text-[12px] text-ink-3 whitespace-nowrap">{statusText(row.status)}</span>
                    </div>
                  </td>
                  <td className="pin">
                    <div className="flex flex-col min-w-[140px] max-w-[220px]">
                      {p ? (
                        <button type="button" className="bg-transparent border-0 p-0 text-start font-bold ltr truncate text-[13px] text-ink cursor-pointer hover:text-accent" onClick={() => onEdit(p)}>
                          {row.name}
                        </button>
                      ) : (
                        <span className="font-bold ltr truncate text-[13px]">{row.name}</span>
                      )}
                      <span className="text-[11px] text-ink-3 ltr truncate">
                        {p?.container || row.profile?.plan || (pc?.info?.agent?.version ? `agent ${pc.info.agent.version}` : '') || ''}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="chip !py-0 !text-[10.5px] ltr">{kindLabel(row.kind, t)}</span>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="ltr">{row.group || t('مستقل', 'Standalone')}</span>
                  </td>
                  <td>
                    {p ? (
                      <div className="flex flex-col gap-1 min-w-[160px]">
                        <DomainCell domain={p.panel_domain} check={check?.panel_domain} checking={checking} onAdd={() => onEdit(p)} />
                        <DomainCell domain={p.quota_domain} suffix="/quota" check={check?.quota_domain} checking={checking} onAdd={() => onEdit(p)} />
                      </div>
                    ) : row.access ? (
                      <span className="ltr text-[12.5px] truncate block max-w-[240px]" title={row.access}>
                        {row.access}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td>
                    {p ? (
                      <SecretCell p={p} onEdit={() => onEdit(p)} />
                    ) : pc ? (
                      <AgentUpdate
                        pc={pc}
                        latest={latest}
                        busy={updatingId === pc.id}
                        onUpdate={() => onUpdatePc(pc.id)}
                      />
                    ) : row.server?.last_error ? (
                      <span className="text-[11.5px] text-bad">{agentErrorText(row.server.last_error)}</span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="n whitespace-nowrap">
                    <div className="flex flex-col items-end leading-tight">
                      <span>
                        <b className="num">{int(row.requests)}</b>
                        <span className="text-[11px] text-ink-3"> {row.kind === 'gateway' ? t('درخواست', 'req') : t('نوبت', 'turns')}</span>
                      </span>
                      {row.tokens != null && row.kind === 'gateway' && (
                        <span className="text-[11px] text-ink-3">
                          <span className="num">{compact(row.tokens)}</span> {t('توکن', 'tok')}
                          {p?.keys != null && (
                            <>
                              {' · '}
                              <KeyRound size={10} className="inline -mt-px" /> {int(p.keys)}
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-[12px] text-ink-3">{row.lastAt ? relative(row.lastAt) : '—'}</td>
                  <td>
                    <div className="flex items-center justify-end gap-0.5">
                      {row.sourceId && (
                        <Link to={`/explore?source=${row.sourceId}`} className="btn btn-ghost btn-icon btn-sm" title={t('گفتگوها', 'Conversations')}>
                          <MessagesSquare size={14} />
                        </Link>
                      )}
                      {p && (quota || endpoint) && (
                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => copyText(handoff, toast, t, t('متن برای کاربر کپی شد', 'Message for the user copied'))} title={t('کپی متن برای کاربر', 'Copy message for the user')}>
                          <Send size={14} />
                        </button>
                      )}
                      {p && (
                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => onEdit(p)} title={t('ویرایش', 'Edit')}>
                          <Pencil size={14} />
                        </button>
                      )}
                      {p && (
                        <button className="btn btn-ghost btn-icon btn-sm hover:!text-bad" onClick={() => onDeletePanel(p)} title={t('حذف', 'Delete')}>
                          <Trash2 size={14} />
                        </button>
                      )}
                      {pc && (
                        <>
                          <StopAgentButton pc={pc} latest={latest} stopping={stoppingId === pc.id} onStop={() => onStopPc(pc)} iconOnly />
                          <button className="btn btn-ghost btn-icon btn-sm hover:!text-bad" onClick={() => onDeletePc(pc)} title={t('حذف کامپیوتر', 'Remove computer')}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DomainCell({ domain, suffix = '', check, checking, onAdd }: { domain: string | null; suffix?: string; check?: PanelCheck | null; checking: boolean; onAdd: () => void }) {
  const { t } = useI18n();
  if (!domain) {
    return (
      <button type="button" className="text-[12px] text-ink-3 bg-transparent border-0 p-0 cursor-pointer hover:text-accent" onClick={onAdd}>
        {t('افزودن', 'Add')}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 min-w-[140px] max-w-[240px]">
      <Dot c={check} checking={checking} what={t('دامنه', 'Domain')} />
      <a href={domain + suffix} target="_blank" rel="noopener noreferrer" className="grow min-w-0 truncate ltr text-start text-[12.5px] font-medium text-ink no-underline hover:text-accent" title={hostOf(domain)}>
        {hostOf(domain)}
      </a>
      <a className="btn btn-ghost btn-icon btn-sm !size-7" href={domain + suffix} target="_blank" rel="noopener noreferrer" aria-label={t('باز کردن', 'Open')} title={t('باز کردن', 'Open')}>
        <ExternalLink size={13} />
      </a>
    </div>
  );
}

function SecretCell({ p, onEdit }: { p: PanelInfo; onEdit: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setShown(null), [p.password_at]);
  useEffect(() => {
    if (shown == null) return;
    const id = setTimeout(() => setShown(null), 30_000);
    return () => clearTimeout(id);
  }, [shown]);
  const fetchPw = async () => {
    setBusy(true);
    try {
      return (await get<{ password: string | null }>(`/api/panels/${p.id}/password`)).password ?? '';
    } catch (e) {
      toast('err', errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (!p.has_password) {
    return (
      <button type="button" className="text-[12px] text-warn bg-transparent border-0 p-0 cursor-pointer hover:underline" onClick={onEdit}>
        {t('ثبت نشده', 'Not set')}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1 min-w-[120px]">
      <code className={cx('grow min-w-0 truncate ltr text-start text-[12px]', shown == null && 'tracking-[0.18em] text-ink-3')}>{shown ?? '••••••••'}</code>
      <button
        className="btn btn-ghost btn-icon btn-sm !size-7"
        disabled={busy}
        onClick={async () => (shown != null ? setShown(null) : setShown(await fetchPw()))}
        aria-label={shown != null ? t('پنهان کردن رمز', 'Hide password') : t('نمایش رمز', 'Show password')}
        title={shown != null ? t('پنهان', 'Hide') : t('نمایش', 'Show')}
      >
        {busy ? <Spinner size={12} /> : shown != null ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        className="btn btn-ghost btn-icon btn-sm !size-7"
        disabled={busy}
        onClick={async () => {
          const pw = shown ?? (await fetchPw());
          if (pw) copyText(pw, toast, t, t('رمز کپی شد', 'Password copied'));
        }}
        aria-label={t('کپی رمز', 'Copy password')}
        title={t('کپی رمز', 'Copy password')}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

// ---------- edit / add ----------

interface Form {
  name: string;
  org: string;
  panel_domain: string;
  quota_domain: string;
  notes: string;
  password: string;
  clearPassword: boolean;
}

function EditModal({ panel, onClose, onDelete }: { panel: PanelInfo | 'new' | null; onClose: () => void; onDelete: (p: PanelInfo) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = panel === 'new';
  const p = panel && panel !== 'new' ? panel : null;
  const [f, setF] = useState<Form | null>(null);
  const [showPw, setShowPw] = useState(false);
  useEffect(() => {
    if (!panel) return setF(null);
    setShowPw(false);
    setF({
      name: p?.name ?? '',
      org: p?.org ?? '',
      panel_domain: p?.panel_domain ? hostOf(p.panel_domain) : '',
      quota_domain: p?.quota_domain ? hostOf(p.quota_domain) : '',
      notes: p?.notes ?? '',
      password: '',
      clearPassword: false,
    });
  }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => (isNew ? api('POST', '/api/panels', b) : api('PATCH', `/api/panels/${p!.id}`, b)),
    onSuccess: () => {
      toast('ok', isNew ? t('پنل اضافه شد', 'Panel added') : t('ذخیره شد', 'Saved'));
      qc.invalidateQueries({ queryKey: ['panels'] });
      qc.invalidateQueries({ queryKey: ['panels-status'] });
      onClose();
    },
    onError: (e) => toast('err', errorText(e)),
  });

  if (!f) return null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b: Record<string, unknown> = {
      name: f.name.trim(),
      org: f.org.trim(),
      panel_domain: f.panel_domain.trim() || null,
      quota_domain: f.quota_domain.trim() || null,
      notes: f.notes,
    };
    if (f.clearPassword) b.password = null;
    else if (f.password) b.password = f.password;
    save.mutate(b);
  };

  return (
    <Modal open={!!panel} onClose={onClose} title={isNew ? t('افزودن پنل', 'Add panel') : t(`ویرایش ${p?.name}`, `Edit ${p?.name}`)} width={560}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('نام', 'Name')}>
            <input className="input ltr" value={f.name} onChange={(e) => set('name', e.target.value)} required maxLength={80} />
          </Field>
          <Field label={t('گروه / سازمان', 'Group / organization')} hint={t('مثل acme؛ خالی = مستقل', 'e.g. acme; empty = standalone')}>
            <input className="input ltr" value={f.org} onChange={(e) => set('org', e.target.value)} maxLength={40} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('دامنه‌ی پنل و API', 'Panel and API domain')} hint={t('بدون http:// یعنی https', 'Without http:// this means https')}>
            <input className="input ltr" value={f.panel_domain} onChange={(e) => set('panel_domain', e.target.value)} placeholder="api.user.example.org" />
          </Field>
          <Field label={t('دامنه‌ی صفحه‌ی سهمیه', 'Quota page domain')} hint={t('صفحه‌ی /quota بدون ورود', 'The /quota page, no login')}>
            <input className="input ltr" value={f.quota_domain} onChange={(e) => set('quota_domain', e.target.value)} placeholder="user.example.org" />
          </Field>
        </div>
        <Field label={t('رمز ورود پنل', 'Panel password')} hint={p?.has_password ? t('خالی بگذارید تا همان رمز قبلی بماند', 'Leave blank to keep the current password') : undefined}>
          <div className="flex gap-1.5">
            <input
              className="input ltr grow"
              type={showPw ? 'text' : 'password'}
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value, clearPassword: false })}
              placeholder={p?.has_password ? '••••••••' : ''}
              autoComplete="new-password"
              disabled={f.clearPassword}
            />
            <button type="button" className="btn btn-icon" onClick={() => setShowPw(!showPw)} aria-label={showPw ? t('پنهان کردن', 'Hide') : t('نمایش', 'Show')}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {p?.has_password && (
            <label className="flex items-center gap-1.5 text-[12px] text-ink-3 mt-1.5 cursor-pointer">
              <input type="checkbox" checked={f.clearPassword} onChange={(e) => setF({ ...f, clearPassword: e.target.checked, password: '' })} /> {t('پاک کردن رمز ذخیره‌شده', 'Clear the saved password')}
            </label>
          )}
        </Field>
        <Field label={t('یادداشت', 'Notes')}>
          <textarea className="input !h-auto py-2" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
        </Field>
        <div className="flex items-center gap-2 mt-1">
          <button className="btn btn-primary" type="submit" disabled={save.isPending || !f.name.trim()}>
            {save.isPending && <Spinner size={14} />} {isNew ? t('افزودن', 'Add') : t('ذخیره', 'Save')}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            {t('انصراف', 'Cancel')}
          </button>
          {p && (
            <button className="btn btn-ghost ms-auto text-bad" type="button" onClick={() => onDelete(p)}>
              <Trash2 size={14} /> {t('حذف', 'Delete')}
            </button>
          )}
        </div>
        <p className="m-0 text-[11.5px] text-ink-3">{t('رمزها رمزنگاری‌شده در پایگاه داده‌ی داشبورد ذخیره می‌شوند و فقط با «نمایش» یا «کپی» خوانده می‌شوند. به خود 9router چیزی نوشته نمی‌شود.', 'Passwords are stored encrypted in the dashboard database and are only read with Show or Copy. Nothing is written to the 9router itself.')}</p>
      </form>
    </Modal>
  );
}
