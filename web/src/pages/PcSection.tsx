import { useMutation, UseQueryResult, useQueryClient } from '@tanstack/react-query';
import { Download, Laptop, Mail, MessagesSquare, Plus, Square, Trash2, UserRound } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Confirm, cx, Empty, ErrorBox, Skeleton, Spinner, useToast } from '../components/ui';
import { agentErrorText, api, errorText, PcInfo, PcProfile } from '../lib/api';
import { int, relative } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** IP or name of a PC, from the agent URL https://<host>:<port>/<secret path>. The path is never shown. */
export const addressOf = (url: string) => {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port };
  } catch {
    return { host: '', port: '' };
  }
};

// a PC counts as on when the agent answered within the last two schedule rounds or so
const ONLINE_MS = 20 * 60_000;

export const isOnline = (pc: PcInfo) => !!pc.enabled && !pc.last_error && !!pc.last_seen_at && Date.now() - Date.parse(pc.last_seen_at) < ONLINE_MS;

type Pcs = { pcs: PcInfo[]; agent: { version: string; min: string; minStop?: string } | null };

const cmpVersion = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Paired Windows PCs: which computer, which Windows accounts and Cursor accounts are on it, and what was read. */
export function PcSection({ q, onAdd }: { q: UseQueryResult<Pcs>; onAdd: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean; version: string; already?: boolean }>('POST', `/api/pcs/${id}/update-agent`),
    onSuccess: (r, id) => {
      const name = (q.data?.pcs ?? []).find((p) => p.id === id)?.info?.agent?.host || (q.data?.pcs ?? []).find((p) => p.id === id)?.label;
      toast('ok', r.already ? t(`${name ?? 'این کامپیوتر'} همین حالا نسخه ${r.version} است.`, `${name ?? 'This computer'} is already on version ${r.version}.`) : t(`نسخه ${r.version} به ${name ?? 'کامپیوتر'} فرستاده شد. سرویس ویندوز چند ثانیه دیگر فایل را جایگزین و دوباره اجرا می‌کند؛ بعد «بررسی دوباره» را بزنید.`, `Version ${r.version} was sent to ${name ?? 'the computer'}. The Windows service replaces the file and restarts in a few seconds; then click “Check again”.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const [del, setDel] = useState<PcInfo | null>(null);
  const [stopPc, setStopPc] = useState<PcInfo | null>(null);
  const stop = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean }>('POST', `/api/pcs/${id}/stop-agent`),
    onSuccess: () => {
      const name = stopPc?.info?.agent?.host || stopPc?.label;
      setStopPc(null);
      toast('ok', t(`سرویس PD Agent روی «${name ?? ''}» متوقف می‌شود. در Services باید Stopped باشد.`, `PD Agent on “${name ?? ''}” is stopping. In Services it should show Stopped.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/servers/${id}`),
    onSuccess: () => {
      const name = del?.info?.agent?.host || del?.label;
      setDel(null);
      toast('ok', t(`«${name ?? ''}» از داشبورد حذف شد.`, `“${name ?? ''}” was removed from the dashboard.`));
      qc.invalidateQueries({ queryKey: ['pcs'] });
    },
    onError: (e) => toast('err', errorText(e)),
  });
  const [text, setText] = useState('');
  const pcs = q.data?.pcs ?? [];
  if (q.isLoading)
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-[200px]" />
        ))}
      </div>
    );
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  if (!pcs.length)
    return (
      <div className="card px-5 py-6 flex flex-col items-center gap-3 text-center">
        <Laptop size={28} className="text-ink-3" />
        <div className="text-[14px] font-bold">{t('هنوز کامپیوتری وصل نشده', 'No computer is connected yet')}</div>
        <div className="text-[12.5px] text-ink-3 max-w-[520px] leading-6">
          {t('یک «دستور نصب» بسازید و روی هر کامپیوتر ویندوزی در PowerShell بچسبانید. زیپ در Program Files باز می‌شود و سرویس PD Agent با دستورات ویندوز ثبت می‌شود.', 'Create an “install command” and paste it into PowerShell on each Windows computer. The zip is extracted into Program Files and the PD Agent service is registered with Windows.')}
        </div>
        <button className="btn btn-primary btn-sm" onClick={onAdd}>
          <Plus size={14} /> {t('دستور نصب', 'Install command')}
        </button>
      </div>
    );

  const people = pcs.flatMap((pc) => pc.info?.sources ?? []);
  const online = pcs.filter(isOnline).length;
  const turns = pcs.reduce((n, pc) => n + pc.sources.reduce((m, s) => m + Number(s.requests), 0), 0);
  const query = text.trim().toLowerCase();
  const shown = !query
    ? pcs
    : pcs.filter((pc) =>
        [pc.label, pc.name, pc.url && addressOf(pc.url).host, pc.info?.agent?.host, ...(pc.info?.sources ?? []).flatMap((p) => [p.profile, p.account, p.email])].some((v) =>
          v?.toLowerCase().includes(query),
        ),
      );
  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat label={t("کامپیوتر وصل‌شده", "Connected computers")} value={int(pcs.length)} />
        <Stat label={t("روشن", "Online")} value={<>{int(online)} <span className="text-[14px] font-semibold text-ink-3">{t('از ', 'of ')}{int(pcs.length)}</span></>} tone={online < pcs.length ? 'warn' : 'good'} hint={online < pcs.length ? t(`${int(pcs.length - online)} کامپیوتر جواب نمی‌دهد`, `${int(pcs.length - online)} ${pcs.length - online === 1 ? 'computer is not responding' : 'computers are not responding'}`) : t('همه جواب می‌دهند', 'All are responding')} />
        <Stat label={t("پروفایل Cursor و Codex", "Cursor and Codex profiles")} value={int(people.length)} hint={t(`${int(people.filter((p) => p.email).length)} با حساب Cursor`, `${int(people.filter((p) => p.email).length)} with a Cursor account`)} />
        <Stat label={t("نوبت خوانده‌شده", "Turns read")} value={int(turns)} hint={t("همه‌ی گفتگوهای این کامپیوترها", "Every conversation on these computers")} />
      </div>
      <div className="relative max-w-[360px] mb-4">
        <input className="input !h-9" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("نام کامپیوتر، IP، کاربر، ایمیل…", "Computer name, IP, user, email…")} aria-label={t("جستجو در کامپیوترها", "Search computers")} />
      </div>
      {!shown.length ? (
        <Empty title={t("کامپیوتری با این جستجو پیدا نشد", "No computer matches this search")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 items-start">
          {shown.map((pc) => (
            <PcCard
              key={pc.id}
              pc={pc}
              latest={q.data?.agent ?? null}
              busy={update.isPending && update.variables === pc.id}
              onUpdate={() => update.mutate(pc.id)}
              onStop={() => setStopPc(pc)}
              stopping={stop.isPending && stop.variables === pc.id}
              onDelete={() => setDel(pc)}
            />
          ))}
        </div>
      )}
      <Confirm
        open={!!stopPc}
        title={t('توقف سرویس agent', 'Stop the agent service')}
        body={t(
          `سرویس PD Agent روی «${stopPc?.info?.agent?.host || stopPc?.label || ''}» Stop می‌شود تا Cursor بتواند فایل‌هایش را آزاد کند. در Services ویندوز باید Stopped بماند. برای روشن کردن دوباره، Services را با Run as administrator باز کنید و Start بزنید.`,
          `PD Agent on “${stopPc?.info?.agent?.host || stopPc?.label || ''}” will Stop so Cursor can release its files. In Windows Services it should stay Stopped. To start it again, open Services as administrator and click Start.`,
        )}
        confirmLabel={t('توقف سرویس', 'Stop service')}
        onConfirm={() => stopPc && stop.mutate(stopPc.id)}
        onClose={() => setStopPc(null)}
        busy={stop.isPending}
      />
      <Confirm
        open={!!del}
        title={t('حذف کامپیوتر', 'Remove computer')}
        body={t(
          `«${del?.info?.agent?.host || del?.label || ''}» از داشبورد برداشته می‌شود. agent روی خود کامپیوتر می‌ماند؛ گفتگوهایی که از این اتصال خوانده شده‌اند هم پاک می‌شوند.`,
          `“${del?.info?.agent?.host || del?.label || ''}” is removed from the dashboard. The agent on the computer stays; conversations already read from this pairing are deleted.`,
        )}
        confirmLabel={t('حذف', 'Delete')}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
        busy={remove.isPending}
      />
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="card px-4 py-3">
      <div className={cx('text-[12px] text-ink-3', tone === 'good' && '!text-good', tone === 'warn' && '!text-warn')}>{label}</div>
      <div className="text-[20px] font-extrabold mt-0.5">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-3 truncate">{hint}</div>}
    </div>
  );
}

function PcCard({
  pc,
  latest,
  busy,
  onUpdate,
  onStop,
  stopping,
  onDelete,
}: {
  pc: PcInfo;
  latest: { version: string; min: string; minStop?: string } | null;
  busy: boolean;
  onUpdate: () => void;
  onStop: () => void;
  stopping: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { host, port } = addressOf(pc.url);
  const online = isOnline(pc);
  const computer = pc.info?.agent?.host;
  const profiles = pc.info?.sources ?? [];
  const read = new Map(pc.sources.map((s) => [s.remote_name, s]));
  // profiles as the agent last described them; before its first answer, just what was read
  const list: (Partial<PcProfile> & { name: string; profile: string })[] = profiles.length
    ? profiles
    : pc.sources.map((s) => ({ name: s.remote_name, profile: s.remote_name.replace(/^(cursor|codex)-/, '') }));
  const state = !pc.enabled ? t('غیرفعال', 'Disabled') : pc.last_error ? agentErrorText(pc.last_error) : online ? t(`روشن · ${relative(pc.last_seen_at)}`, `Online · ${relative(pc.last_seen_at)}`) : pc.last_seen_at ? t(`آخرین بار ${relative(pc.last_seen_at)}`, `Last seen ${relative(pc.last_seen_at)}`) : t('هنوز جواب نداده', 'No reply yet');

  return (
    <article className={cx('card p-4 flex flex-col gap-3', !pc.enabled && 'opacity-70')} aria-label={computer || pc.label}>
      <header className="flex items-start gap-2.5">
        <span className={cx('mt-1.5 inline-flex size-2.5 shrink-0 rounded-full', online ? 'bg-good' : pc.last_error ? 'bg-bad' : 'bg-line')} title={state} />
        <div className="min-w-0 grow">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="m-0 text-[15px] font-bold ltr truncate">{computer || pc.label}</h3>
            {pc.info?.agent?.version && <span className="chip !py-0 !text-[10.5px] ltr">agent {pc.info.agent.version}</span>}
          </div>
          <div className="text-[11.5px] text-ink-3 ltr text-start mono" title={t("IP و پورت agent", "Agent IP and port")}>
            {host}
            {port && `:${port}`}
          </div>
          {computer && pc.label !== computer && <div className="text-[11.5px] text-ink-3">{pc.label}</div>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <StopAgentButton pc={pc} latest={latest} stopping={stopping} onStop={onStop} iconOnly />
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onDelete} aria-label={t(`حذف ${computer || pc.label}`, `Remove ${computer || pc.label}`)} title={t('حذف از داشبورد', 'Remove from dashboard')}>
            <Trash2 size={14} />
          </button>
        </div>
      </header>
      <div className={cx('text-[12px]', pc.last_error ? 'text-bad' : 'text-ink-3')}>{state}</div>

      {profiles.length === 0 && pc.sources.length === 0 ? (
        <div className="text-[12px] text-ink-3">{t('پروفایلی با Cursor یا Codex روی این کامپیوتر پیدا نشد.', 'No Cursor or Codex profile was found on this computer.')}</div>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {list.map((p) => {
            const s = read.get(p.name);
            const codex = p.kind === 'codex' || p.name.startsWith('codex-');
            return (
              <li key={p.name} className="bg-surface-2 rounded-md px-2.5 py-2 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <UserRound size={13} className="text-ink-3 shrink-0" />
                  <b className="ltr text-[13px] truncate" title={t("حساب ویندوز", "Windows account")}>
                    {p.account || p.profile}
                  </b>
                  <span className="chip !py-0 !text-[10.5px] ltr">{codex ? 'Codex' : 'Cursor'}</span>
                  {p.plan && <span className="chip !py-0 !text-[10.5px] ltr">{p.plan}</span>}
                </div>
                {!codex && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3 min-w-0">
                  <Mail size={12} className="shrink-0" />
                  {p.email ? <span className="ltr truncate" title={t("حساب Cursor", "Cursor account")}>{p.email}</span> : <span>{t('بدون حساب Cursor', 'No Cursor account')}</span>}
                </div>
                )}
                <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11.5px] text-ink-3">
                  {p.chats != null && <span><b className="num text-ink-2">{int(p.chats)}</b>{t(' گفتگو روی کامپیوتر', ' conversations on this computer')}</span>}
                  {s && <span><b className="num text-ink-2">{int(s.requests)}</b>{t(' نوبت خوانده‌شده', ' turns read')}</span>}
                  {s?.last_at && <span>{t('آخرین: ', 'Last: ')}{relative(s.last_at)}</span>}
                  {s?.last_error && <span className="text-bad">{s.last_error}</span>}
                  {p.error && <span className="text-bad">{p.error}</span>}
                  {s && (
                    <Link to={`/explore?source=${s.id}`} className="ms-auto inline-flex items-center gap-1 text-accent no-underline hover:underline">
                      <MessagesSquare size={12} /> {t('گفتگوها', 'Conversations')}
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AgentUpdate pc={pc} latest={latest} busy={busy} onUpdate={onUpdate} />
    </article>
  );
}

export function StopAgentButton({
  pc,
  latest,
  stopping,
  onStop,
  iconOnly,
}: {
  pc: PcInfo;
  latest: { version: string; min: string; minStop?: string } | null;
  stopping?: boolean;
  onStop: () => void;
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const running = pc.info?.agent?.version;
  const minStop = latest?.minStop ?? '1.7.4';
  const canStop = !!running && cmpVersion(running, minStop) >= 0 && pc.enabled && !stopping;
  return (
    <button
      className={iconOnly ? 'btn btn-ghost btn-icon btn-sm hover:!text-bad' : 'btn btn-sm self-start'}
      onClick={onStop}
      disabled={!canStop}
      aria-label={t('توقف سرویس', 'Stop service')}
      title={
        !running
          ? t('نسخه agent هنوز خوانده نشده.', 'The agent version has not been read yet.')
          : cmpVersion(running, minStop) < 0
            ? t('اول agent را به‌روز کنید، بعد می‌توانید از داشبورد متوقفش کنید.', 'Update the agent first, then you can stop it from the dashboard.')
            : t('سرویس PD Agent را روی این کامپیوتر Stop می‌کند', 'Stops the PD Agent service on this computer')
      }
    >
      {stopping ? <Spinner size={13} /> : <Square size={13} />}
      {!iconOnly && t(' توقف سرویس', ' Stop service')}
    </button>
  );
}

export function AgentUpdate({
  pc,
  latest,
  busy,
  onUpdate,
}: {
  pc: PcInfo;
  latest: { version: string; min: string; minStop?: string } | null;
  busy: boolean;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  const running = pc.info?.agent?.version;
  if (!latest) return null;
  if (!running) return <p className="m-0 text-[12px] text-ink-3 leading-5">{t('نسخه agent هنوز خوانده نشده. «بررسی دوباره» را بزنید.', 'The agent version has not been read yet. Click “Check again”.')}</p>;
  if (cmpVersion(running, latest.min) < 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <button className="btn btn-sm self-start" disabled>
          <Download size={13} />{t(' به‌روزرسانی agent', ' Update agent')}
        </button>
        <p className="m-0 text-[11.5px] text-ink-3 leading-5">{t(`نسخه ${running} این کار را بلد نیست. یک بار دستور نصب را روی همین کامپیوتر دوباره اجرا کنید تا به ${latest.min} برسد؛ بعد از آن همین دکمه فایل جدید را می‌فرستد و سرویس را دوباره اجرا می‌کند.`, `Version ${running} cannot be updated from this button. Run the install command once on this computer to reach ${latest.min}; after that, this button sends the new file and restarts the service.`)}</p>
      </div>
    );
  }
  if (cmpVersion(latest.version, running) <= 0)
    return <p className="m-0 text-[12px] text-good">{t(`agent به‌روز است (${running})`, `agent is up to date (${running})`)}</p>;
  return (
    <button className="btn btn-primary btn-sm self-start" onClick={onUpdate} disabled={busy || !pc.enabled}>
      {busy ? <Spinner size={13} /> : <Download size={13} />}{t(` به‌روزرسانی به ${latest.version}`, ` Update to ${latest.version}`)}
    </button>
  );
}
