import { useQuery } from '@tanstack/react-query';
import { Bell, Bot, BrainCircuit, Eye, EyeOff, Sparkles, ChevronDown, ChevronLeft, Copy, GitBranch, Hand, Image as ImageIcon, Check, KeyRound, Layers, MessagesSquare, RotateCcw, Slash, Terminal, Timer, TriangleAlert, User, Wrench, Zap } from 'lucide-react';
import { memo, ReactNode, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { cx, Empty, ErrorBox, Skeleton, Spinner, useToast } from '../components/ui';
import { get, MessageRow, RequestRow, ResponseBlock, SessionDetail, ThreadKind, ThreadRow } from '../lib/api';
import { bytes, compact, duration, gapText, gregDate, int, modelLabel, timeOf, uiDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

const md = [remarkGfm];
const mdComponents = {
  a: (p: React.ComponentProps<'a'>) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  p: (p: React.ComponentProps<'p'>) => <p dir="auto" {...p} />,
  li: (p: React.ComponentProps<'li'>) => <li dir="auto" {...p} />,
  h1: (p: React.ComponentProps<'h1'>) => <h1 dir="auto" {...p} />,
  h2: (p: React.ComponentProps<'h2'>) => <h2 dir="auto" {...p} />,
  h3: (p: React.ComponentProps<'h3'>) => <h3 dir="auto" {...p} />,
};

interface Toggles {
  /** Claude's side of the chat; off = only what the person wrote, with the cost of each answer */
  claude: boolean;
  tools: boolean;
  reminders: boolean;
  thinking: boolean;
  aux: boolean;
  subagents: boolean;
}

export default function Conversation() {
  const { id } = useParams();
  // polled: when the person comes back to this chat, the new messages show up here by themselves
  const q = useQuery({ queryKey: ['session', id], queryFn: () => get<SessionDetail>(`/api/sessions/${id}`), refetchInterval: 30_000 });
  const [t, setT] = useState<Toggles>(() => {
    try {
      return { ...DEFAULT_TOGGLES, ...JSON.parse(localStorage.getItem('pd-toggles') ?? '{}') };
    } catch {
      return DEFAULT_TOGGLES;
    }
  });
  const set = (k: keyof Toggles) => (v: boolean) => setMany({ [k]: v });
  const setMany = (patch: Partial<Toggles>) =>
    setT((x) => {
      const n = { ...x, ...patch };
      try {
        localStorage.setItem('pd-toggles', JSON.stringify(n));
      } catch {
        /* private mode */
      }
      return n;
    });

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-32" />
        <Skeleton className="h-24" />
      </div>
    );
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const d = q.data!;
  return <Thread d={d} toggles={t} set={set} setMany={setMany} />;
}

const DEFAULT_TOGGLES: Toggles = { claude: true, tools: true, reminders: false, thinking: false, aux: false, subagents: true };

type Item =
  | { t: 'msg'; m: MessageRow; reqs: RequestRow[] }
  | { t: 'resp'; r: RequestRow }
  | { t: 'divider'; kind: ThreadKind; at: string }
  | { t: 'sub'; thread: ThreadRow; msgs: MessageRow[]; reqs: RequestRow[] };

const itemAt = (x: Item) => (x.t === 'msg' ? x.m.created_at : x.t === 'resp' ? x.r.ts : x.t === 'divider' ? x.at : x.thread.first_at);

const group = <T, K>(rows: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

/** Messages of one thread, each request attached to the first assistant message it produced (the one right after its history). */
function threadItems(msgs: MessageRow[], reqs: RequestRow[]): Item[] {
  const assistantSeqs = msgs.filter((m) => m.role === 'assistant').map((m) => m.seq);
  const bySeq = new Map<number, RequestRow[]>();
  const tail: RequestRow[] = [];
  for (const r of reqs) {
    const next = assistantSeqs.find((s) => s > r.history_len);
    if (next === undefined) tail.push(r);
    else bySeq.set(next, [...(bySeq.get(next) ?? []), r]);
  }
  return [...msgs.map((m): Item => ({ t: 'msg', m, reqs: m.role === 'assistant' ? (bySeq.get(m.seq) ?? []) : [] })), ...tail.map((r): Item => ({ t: 'resp', r }))];
}

/** One timeline for the whole conversation: main thread, then continuations / branches; subagents and body-less requests where they happened. */
function buildTimeline(d: SessionDetail): Item[] {
  const msgs = group(d.messages, (m) => m.session_id ?? 0);
  const reqs = group(d.requests, (r) => r.session_id ?? 0);
  const items: Item[] = [];
  d.threads
    .filter((th) => th.kind !== 'subagent')
    .forEach((th, i) => {
      if (i > 0) items.push({ t: 'divider', kind: th.kind, at: th.first_at });
      items.push(...threadItems(msgs.get(th.id) ?? [], reqs.get(th.id) ?? []));
    });
  const insert = (x: Item) => {
    const at = Date.parse(itemAt(x));
    const i = items.findIndex((y) => y.t !== 'divider' && Date.parse(itemAt(y)) > at);
    if (i < 0) items.push(x);
    else items.splice(i, 0, x);
  };
  for (const r of reqs.get(0) ?? []) insert({ t: 'resp', r });
  for (const th of d.threads.filter((x) => x.kind === 'subagent')) insert({ t: 'sub', thread: th, msgs: msgs.get(th.id) ?? [], reqs: reqs.get(th.id) ?? [] });
  return items;
}

function Thread({ d, toggles, set, setMany }: { d: SessionDetail; toggles: Toggles; set: (k: keyof Toggles) => (v: boolean) => void; setMany: (p: Partial<Toggles>) => void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timeline = useMemo(() => buildTimeline(d), [d]);

  const totals = useMemo(() => {
    const s = { in: 0, out: 0, cache: 0, n: d.requests.length, aux: 0, human: 0, visits: 1, models: new Set<string>() };
    let prev = 0;
    for (const r of d.requests) {
      s.in += r.input_tokens;
      s.out += r.output_tokens;
      s.cache += r.cache_read;
      s.human += r.human_count;
      if (r.model) s.models.add(r.model);
      const at = Date.parse(r.ts);
      if (prev && at - prev > 30 * 60_000) s.visits++;
      prev = at;
    }
    for (const r of d.aux) s.aux += r.input_tokens + r.output_tokens;
    return s;
  }, [d]);
  const count = (k: ThreadKind) => d.threads.filter((x) => x.kind === k).length;

  const visible = (m: MessageRow) => {
    if (m.kind === 'tool_use' || m.kind === 'tool_result') return toggles.tools;
    if (m.kind === 'system_reminder') return toggles.reminders || m.meta?.tag === 'scheduled';
    if (m.kind === 'thinking') return toggles.thinking;
    return true;
  };
  // Each message the person sent opens a turn; everything until the next one is Claude's answer to it.
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const turns = useMemo(() => {
    const of = new Map<Item, number | null>();
    const cost = new Map<number, TurnCost>();
    let cur: number | null = null;
    for (const x of timeline) {
      if (x.t === 'msg' && isTurnStart(x.m)) {
        cur = x.m.id;
        cost.set(cur, { requests: 0, subagents: 0, in: 0, out: 0, cache: 0, write: 0, first: '', last: '', end: 0, models: new Set() });
      }
      of.set(x, cur);
      const c = cur == null ? undefined : cost.get(cur);
      if (!c) continue;
      const reqs = x.t === 'msg' ? x.reqs : x.t === 'resp' ? [x.r] : x.t === 'sub' ? x.reqs : [];
      for (const r of reqs) addCost(c, r, x.t === 'sub');
    }
    return { of, cost };
  }, [timeline]);
  const userSide = (x: Item) =>
    x.t === 'divider' || (x.t === 'msg' && x.m.role === 'user' && (USER_KINDS.has(x.m.kind) || x.m.meta?.tag === 'scheduled'));
  const shown = timeline.filter((x) => {
    const base = x.t === 'msg' ? visible(x.m) : x.t === 'sub' ? toggles.subagents : true;
    if (!base) return false;
    if (toggles.claude || userSide(x)) return true;
    const turn = turns.of.get(x);
    return turn != null && opened.has(turn);
  });
  const hidden = d.messages.length - shown.filter((x) => x.t === 'msg').length;
  const n = useMemo(
    () => ({
      claude: d.messages.filter((m) => m.kind === 'assistant_text').length,
      tools: d.messages.filter((m) => m.kind === 'tool_use').length,
      thinking: d.messages.filter((m) => m.kind === 'thinking').length,
      reminders: d.messages.filter((m) => m.kind === 'system_reminder' && m.meta?.tag !== 'scheduled').length,
    }),
    [d],
  );
  const toggleTurn = (id: number) =>
    setOpened((o) => {
      const x = new Set(o);
      if (x.has(id)) x.delete(id);
      else x.add(id);
      return x;
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast('ok', t('لینک کپی شد', 'Link copied'));
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('err', t('کپی انجام نشد', "Couldn't copy"));
    }
  };

  let lastAt = '';
  return (
    <>
      <nav className="text-[12.5px] text-ink-3 mb-3 flex items-center gap-1.5" aria-label={t('مسیر', 'Breadcrumb')}>
        <Link to="/explore" className="text-ink-3 no-underline hover:text-accent">
          {t('گفتگوها', 'Conversations')}
        </Link>
        <ChevronLeft size={13} />
        <span>{d.session.source}</span>
        <ChevronLeft size={13} />
        <Link to={`/explore?user=${d.session.user_id}&from=${gregDate(new Date(Date.parse(d.session.first_at) - 86400000))}`} className="text-ink-3 no-underline hover:text-accent ltr">
          {d.session.user_name}
        </Link>
      </nav>

      <header className="card p-4 sm:p-5 mb-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="m-0 text-[19px] font-extrabold leading-snug msg-text !whitespace-normal" dir="auto">
            {d.session.title || t('(بدون عنوان)', '(Untitled)')}
          </h1>
          <button className="btn btn-sm shrink-0" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {t('کپی لینک', 'Copy link')}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-3">
          <span className="inline-flex items-center gap-1">
            <KeyRound size={13} /> {t('کلید:', 'Key:')} <b className="text-ink-2 font-medium ltr">{d.session.user_name}</b>
          </span>
          {d.session.machine_user && (
            <span className="inline-flex items-center gap-1">
              <User size={13} /> {t('کاربر:', 'User:')} <b className="text-ink-2 font-medium ltr">{d.session.machine_user}</b>
            </span>
          )}
          <span>
            {t('شروع:', 'Started:')} <b className="text-ink-2 font-medium">{uiDate(d.session.first_at)}</b> <span className="num">{timeOf(d.session.first_at)}</span>
            {lang !== 'en' && <span className="num opacity-70"> ({gregDate(d.session.first_at)})</span>}
          </span>
          <span>
            {t('آخرین فعالیت:', 'Last activity:')} <b className="text-ink-2 font-medium">{uiDate(d.session.last_at)}</b> <span className="num">{timeOf(d.session.last_at)}</span>
          </span>
          {[...totals.models].map((m) => (
            <span key={m} className="chip ltr">
              {modelLabel(m)}
            </span>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
          {totals.visits > 1 && (
            <span className="chip chip-accent" title={t('فعالیت‌هایی با فاصله‌ی بیش از ۳۰ دقیقه', 'Activity separated by more than 30 minutes')}>
              <RotateCcw size={11} /> {t(`کاربر ${int(totals.visits - 1)} بار به این گفتگو برگشته`, `The user came back to this conversation ${int(totals.visits - 1)} ${totals.visits - 1 === 1 ? 'time' : 'times'}`)}
            </span>
          )}
          {count('subagent') > 0 && (
            <span className="chip">
              <Bot size={11} /> {int(count('subagent'))} {t('زیرعامل', count('subagent') === 1 ? 'subagent' : 'subagents')}
            </span>
          )}
          {count('continuation') > 0 && (
            <span className="chip">
              <Layers size={11} /> {int(count('continuation'))} {t('فشرده‌سازی context', count('continuation') === 1 ? 'context compaction' : 'context compactions')}
            </span>
          )}
          {count('branch') > 0 && (
            <span className="chip chip-warn">
              <GitBranch size={11} /> {int(count('branch'))} {t('شاخه (بازگشت به عقب / ویرایش)', count('branch') === 1 ? 'branch (rewind / edit)' : 'branches (rewind / edit)')}
            </span>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <Tot l={t('پیام کاربر', 'User messages')} v={int(totals.human)} />
          <Tot l={t('درخواست', 'Requests')} v={int(totals.n)} />
          <Tot l={t('توکن ورودی', 'Input tokens')} v={compact(totals.in)} title={int(totals.in)} />
          <Tot l={t('توکن خروجی', 'Output tokens')} v={compact(totals.out)} title={int(totals.out)} />
          <Tot l={t('کش خوانده', 'Cache read')} v={compact(totals.cache)} title={int(totals.cache)} />
        </div>
      </header>

      <div className="card p-2 mb-4 sticky top-14 lg:top-2 z-20" role="group" aria-label={t('نمایش', 'Display')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-full border border-line p-0.5 bg-surface-2" role="radiogroup" aria-label={t('حالت نمایش', 'View mode')}>
            <ModeButton on={toggles.claude} onClick={() => setMany({ claude: true })} icon={<MessagesSquare size={14} />} label={t('کل گفتگو', 'Full conversation')} />
            <ModeButton
              on={!toggles.claude}
              onClick={() => {
                setOpened(new Set());
                setMany({ claude: false });
              }}
              icon={<User size={14} />}
              label={t('فقط پیام‌های کاربر', 'User messages only')}
            />
          </div>
          <span className="w-px h-6 bg-line mx-1 hidden sm:block" aria-hidden />
          <Pill label={t('ابزارها', 'Tools')} icon={<Wrench size={13} />} count={n.tools} on={toggles.tools} set={set('tools')} off={!toggles.claude} />
          <Pill label={t('زیرعامل‌ها', 'Subagents')} icon={<Bot size={13} />} count={count('subagent')} on={toggles.subagents} set={set('subagents')} off={!toggles.claude} />
          <Pill label={t('تفکر Claude', "Claude's thinking")} icon={<BrainCircuit size={13} />} count={n.thinking} on={toggles.thinking} set={set('thinking')} off={!toggles.claude} />
          <Pill label={t('یادآوری‌های سیستم', 'System reminders')} icon={<Bell size={13} />} count={n.reminders} on={toggles.reminders} set={set('reminders')} off={!toggles.claude} />
          <Pill label={t('درخواست‌های کمکی', 'Auxiliary requests')} icon={<Zap size={13} />} count={d.aux.length} on={toggles.aux} set={set('aux')} />
          {hidden > 0 && (
            <span className="ms-auto text-[11.5px] text-ink-3 px-2 inline-flex items-center gap-1">
              <EyeOff size={12} /> <span className="num">{int(hidden)}</span> {t('مورد پنهان', 'hidden')}
            </span>
          )}
        </div>
        {!toggles.claude && (
          <div className="mt-2 px-2 text-[11.5px] text-ink-3">
            {t('پاسخ‌های Claude پنهان است؛ زیر هر پیام، توکن مصرف‌شده برای پاسخ به آن آمده و با «نمایش پاسخ» همان پاسخ باز می‌شود.', 'Claude’s replies are hidden. Under each message is the token cost of the reply, and “Show reply” opens that reply.')}
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <Empty title={t('پیامی ذخیره نشده', 'No messages saved')} hint={t('درخواست‌های این گفتگو ناقص بوده‌اند یا هنوز همگام نشده‌اند.', 'Requests for this conversation were incomplete, or they have not synced yet.')} />
        </div>
      ) : (
        <ol className="m-0 p-0 list-none flex flex-col gap-3">
          {shown.map((x, i) => {
            const at = itemAt(x);
            const back = lastAt && x.t !== 'divider' && Date.parse(at) - Date.parse(lastAt) > 30 * 60_000 ? lastAt : '';
            if (x.t !== 'divider') lastAt = at;
            const key = x.t === 'msg' ? `m${x.m.id}` : x.t === 'resp' ? `r${x.r.id}` : x.t === 'sub' ? `s${x.thread.id}` : `d${i}`;
            return (
              <li key={key} className="flex flex-col gap-1.5">
                {back && <TimeGap a={back} b={at} />}
                {x.t === 'divider' && <ThreadDivider kind={x.kind} at={x.at} />}
                {x.t === 'msg' && (
                  <>
                    {x.reqs.map((r) => (
                      <RequestBadge key={r.id} r={r} />
                    ))}
                    <Message m={x.m} />
                    {!toggles.claude && turns.cost.has(x.m.id) && <TurnSummary c={turns.cost.get(x.m.id)!} open={opened.has(x.m.id)} toggle={() => toggleTurn(x.m.id)} />}
                  </>
                )}
                {x.t === 'resp' && <ResponseOnly r={x.r} toggles={toggles} />}
                {x.t === 'sub' && <Subagent th={x.thread} msgs={x.msgs} reqs={x.reqs} visible={visible} />}
              </li>
            );
          })}
        </ol>
      )}

      {toggles.aux && d.aux.length > 0 && (
        <section className="mt-6" aria-label={t('درخواست‌های کمکی', 'Auxiliary requests')}>
          <h2 className="text-[14px] font-bold mb-2 text-ink-2">{t('درخواست‌های کمکی (classifier / عنوان / فشرده‌سازی)', 'Auxiliary requests (classifier / title / compaction)')} · {compact(totals.aux)} {t('توکن', 'tokens')}</h2>
          <div className="flex flex-col gap-2">
            {d.aux.map((r) => (
              <div key={r.id} className="card px-3 py-2 text-[12.5px] flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="chip">{auxLabel(r.kind, t)}</span>
                <span className="num text-ink-3">{timeOf(r.ts, true)}</span>
                <span className="chip ltr">{modelLabel(r.model)}</span>
                <TokenLine r={r} />
                {r.response?.[0]?.text && <span className="basis-full text-ink-2 msg-text !whitespace-normal line-clamp-2" dir="auto">{r.response[0].text}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function auxLabel(kind: string, t: (fa: string, en: string) => string) {
  if (kind === 'title') return t('عنوان', 'Title');
  if (kind === 'compact') return t('فشرده‌سازی', 'Compaction');
  return kind;
}

function TimeGap({ a, b }: { a: string; b: string }) {
  const { t } = useI18n();
  const sameDay = gregDate(a) === gregDate(b);
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-ink-3 my-1" role="separator">
      <span className="grow h-px bg-line" />
      <span className="inline-flex items-center gap-1.5">
        <RotateCcw size={12} className="text-accent" />
        {t('بازگشت پس از', 'Back after')} {gapText(Date.parse(b) - Date.parse(a))} ·{sameDay ? '' : ` ${uiDate(b)}`} <span className="num">{timeOf(b)}</span>
      </span>
      <span className="grow h-px bg-line" />
    </div>
  );
}

const DIVIDER_ICON: Record<ThreadKind, ReactNode> = {
  continuation: <Layers size={13} />,
  branch: <GitBranch size={13} />,
  main: <MessagesSquare size={13} />,
  subagent: <Bot size={13} />,
};

function dividerText(kind: ThreadKind, t: (fa: string, en: string) => string) {
  if (kind === 'continuation') return t('context پر شد؛ گفتگو خلاصه شد و ادامه پیدا کرد', 'Context filled up; the conversation was summarized and continued');
  if (kind === 'branch') return t('شاخه‌ی جدید: کاربر به عقب برگشت یا پیامی را ویرایش کرد', 'New branch: the user went back or edited a message');
  if (kind === 'main') return t('ادامه‌ی همین گفتگو در رشته‌ای دیگر', 'This conversation continues in another thread');
  return t('زیرعامل', 'Subagent');
}

function ThreadDivider({ kind, at }: { kind: ThreadKind; at: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 text-[12px] my-2" role="separator">
      <span className="grow h-px bg-line-strong" />
      <span className="inline-flex items-center gap-1.5 text-ink-2 font-medium rounded-full border border-line px-3 py-1 bg-surface">
        {DIVIDER_ICON[kind]} {dividerText(kind, t)} <span className="num text-ink-3 font-normal">{timeOf(at)}</span>
      </span>
      <span className="grow h-px bg-line-strong" />
    </div>
  );
}

/** A request whose body 9router did not keep (too large) or whose answer is not in any later history. */
function ResponseOnly({ r, toggles }: { r: RequestRow; toggles: Toggles }) {
  const { t } = useI18n();
  const blocks = (r.response ?? []).filter((b) => (b.kind === 'tool_use' || b.kind === 'tool_result' ? toggles.tools : b.kind === 'thinking' ? toggles.thinking : true));
  return (
    <>
      <RequestBadge r={r} />
      {r.truncated && (
        <div className="self-center text-[11.5px] text-ink-3 inline-flex items-center gap-1.5 bg-surface-2 rounded-full px-3 py-1">
          <TriangleAlert size={12} /> {t(`متن این درخواست (${bytes(r.original_size)}) بزرگ‌تر از حد ذخیره‌ی 9router بود؛ فقط پاسخ Claude موجود است`, `This request (${bytes(r.original_size)}) was larger than what 9router stores; only Claude's reply is available`)}
        </div>
      )}
      {blocks.map((b, i) => (
        <Message key={i} m={{ id: -1, seq: -1, role: 'assistant', kind: b.kind, text: b.text, len: b.text.length, meta: b.meta ?? null, created_at: r.ts }} />
      ))}
    </>
  );
}

function Subagent({ th, msgs, reqs, visible }: { th: ThreadRow; msgs: MessageRow[]; reqs: RequestRow[]; visible: (m: MessageRow) => boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => threadItems(msgs, reqs), [msgs, reqs]);
  const tok = reqs.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0);
  return (
    <div className="flex justify-end">
      <div className="rounded-xl border border-line bg-[var(--tool-bg)] w-full max-w-[min(100%,860px)] overflow-hidden">
        <button className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] bg-transparent border-0 cursor-pointer text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Bot size={15} className="text-claude shrink-0" />
          <span className="text-ink-3 shrink-0">{t('زیرعامل:', 'Subagent:')}</span>
          <span className="grow truncate font-medium text-ink" dir="auto">
            {th.title || t('(بدون عنوان)', '(Untitled)')}
          </span>
          <span className="num text-ink-3 shrink-0">
            {int(reqs.length)} {t('درخواست', 'requests')} · {compact(tok)} {t('توکن', 'tokens')} · {timeOf(th.first_at)}–{timeOf(th.last_at)}
          </span>
          <ChevronDown size={14} className={cx('transition-transform shrink-0 text-ink-3', open && 'rotate-180')} />
        </button>
        {open && (
          <ol className="m-0 px-3 pb-3 list-none flex flex-col gap-2.5 border-t border-line pt-3">
            {items
              .filter((x) => x.t !== 'msg' || visible(x.m))
              .map((x, i) => (
                <li key={i} className="flex flex-col gap-1.5">
                  {x.t === 'msg' && (
                    <>
                      {x.reqs.map((r) => (
                        <RequestBadge key={r.id} r={r} />
                      ))}
                      <Message m={x.m} />
                    </>
                  )}
                  {x.t === 'resp' && <ResponseOnly r={x.r} toggles={{ ...DEFAULT_TOGGLES, tools: true }} />}
                </li>
              ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Tot({ l, v, title }: { l: string; v: string; title?: string }) {
  return (
    <div className="rounded-[10px] bg-surface-2 px-3 py-2" title={title}>
      <div className="text-[11.5px] text-ink-3">{l}</div>
      <div className="num font-bold text-[17px] leading-tight text-start">{v}</div>
    </div>
  );
}

function ModeButton({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] border-0 cursor-pointer transition-colors',
        on ? 'bg-surface text-ink font-semibold shadow-sm' : 'bg-transparent text-ink-3 hover:text-ink-2',
      )}
    >
      {icon} {label}
    </button>
  );
}

/** A show/hide switch with how many items it covers; dimmed when Claude's side is hidden anyway. */
function Pill({ label, icon, count, on, set, off = false }: { label: string; icon: ReactNode; count: number; on: boolean; set: (v: boolean) => void; off?: boolean }) {
  const { t } = useI18n();
  const empty = count === 0;
  return (
    <button
      aria-pressed={on}
      onClick={() => set(!on)}
      disabled={empty || off}
      title={off ? t('با پاسخ‌های Claude نمایش داده می‌شود', "Shown with Claude's replies") : empty ? t('در این گفتگو موردی نیست', 'Nothing in this conversation') : on ? t('پنهان کردن', 'Hide') : t('نمایش', 'Show')}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors cursor-pointer disabled:cursor-default disabled:opacity-45',
        on && !off ? 'bg-accent-soft border-[var(--accent-soft-border)] text-accent' : 'bg-transparent border-line text-ink-3 hover:bg-surface-2 hover:text-ink-2',
      )}
    >
      {on && !off ? <Eye size={13} /> : <EyeOff size={13} />}
      <span className="opacity-80">{icon}</span>
      {label}
      <span className={cx('num rounded-full px-1.5 text-[10.5px] leading-[18px]', on && !off ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'bg-surface-2 text-ink-3')}>{compact(count)}</span>
    </button>
  );
}

interface TurnCost {
  requests: number;
  subagents: number;
  in: number;
  out: number;
  cache: number;
  write: number;
  first: string;
  last: string;
  /** end of the last answer, ms */
  end: number;
  models: Set<string>;
}

/** What stays on screen when Claude's side is hidden. */
const USER_KINDS = new Set(['human', 'command', 'interrupt', 'image', 'local_output']);

/** What opens a turn: something the person sent (not a /loop run, not tool output). */
const isTurnStart = (m: MessageRow) => m.role === 'user' && (m.kind === 'human' || m.kind === 'command');

function addCost(c: TurnCost, r: RequestRow, sub: boolean) {
  c.requests++;
  if (sub) c.subagents++;
  c.in += r.input_tokens;
  c.out += r.output_tokens;
  c.cache += r.cache_read;
  c.write += r.cache_write;
  if (!c.first || r.ts < c.first) c.first = r.ts;
  if (!c.last || r.ts > c.last) c.last = r.ts;
  c.end = Math.max(c.end, Date.parse(r.ts) + (r.latency_ms ?? 0));
  if (r.model) c.models.add(r.model);
}

/** The cost of Claude's answer to one message, shown while Claude's side is hidden. */
function TurnSummary({ c, open, toggle }: { c: TurnCost; open: boolean; toggle: () => void }) {
  const { t } = useI18n();
  const total = c.in + c.cache + c.write + c.out;
  return (
    <div className="flex justify-end">
      <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[12px] text-ink-3 max-w-[min(100%,820px)]">
        <span className="inline-flex items-center gap-1 text-claude font-semibold">
          <Sparkles size={13} /> {t('پاسخ Claude', "Claude's reply")}
        </span>
        {c.requests === 0 ? (
          <span>{t('بدون درخواست ثبت‌شده', 'No request recorded')}</span>
        ) : (
          <>
            <span className="num font-semibold text-ink-2" title={t(`${int(total)} توکن`, `${int(total)} tokens`)}>
              {compact(total)} {t('توکن', 'tokens')}
            </span>
            <span className="num" title={t('ورودی (بدون کش)', 'Input (excluding cache)')}>
              ↓ {compact(c.in)}
            </span>
            <span className="num" title={t('خروجی', 'Output')}>
              ↑ {compact(c.out)}
            </span>
            <span className="num" title={t('کش خوانده / نوشته', 'Cache read / written')}>
              {t('کش', 'cache')} {compact(c.cache)}/{compact(c.write)}
            </span>
            <span className="num">
              {int(c.requests)} {t('درخواست', 'requests')}{c.subagents ? ` (${int(c.subagents)} ${t('زیرعامل', 'subagents')})` : ''}
            </span>
            {c.first && <span className="num" title={t('از اولین درخواست تا پایان آخرین پاسخ', 'From the first request to the end of the last reply')}>{duration(Math.max(0, c.end - Date.parse(c.first)))}</span>}
            {[...c.models].map((m) => (
              <span key={m} className="chip ltr !py-0">
                {modelLabel(m)}
              </span>
            ))}
          </>
        )}
        <button className="btn btn-ghost btn-sm !h-6 !px-2" onClick={toggle} aria-expanded={open}>
          {open ? <EyeOff size={12} /> : <Eye size={12} />} {open ? t('بستن پاسخ', 'Hide reply') : t('نمایش پاسخ', 'Show reply')}
        </button>
      </div>
    </div>
  );
}

// ---------- per-request badge ----------
function TokenLine({ r }: { r: Pick<RequestRow, 'input_tokens' | 'output_tokens' | 'cache_read' | 'cache_write' | 'latency_ms'> }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 num text-ink-3">
      <span title={t('توکن ورودی', 'Input tokens')}>↓ {int(r.input_tokens)}</span>
      <span title={t('توکن خروجی', 'Output tokens')}>↑ {int(r.output_tokens)}</span>
      {(r.cache_read > 0 || r.cache_write > 0) && (
        <span title={t('کش خوانده / نوشته', 'Cache read / written')}>
          {t('کش', 'cache')} {compact(r.cache_read)}/{compact(r.cache_write)}
        </span>
      )}
      {r.latency_ms != null && <span title={t('زمان پاسخ', 'Response time')}>{duration(r.latency_ms)}</span>}
    </span>
  );
}

function RequestBadge({ r }: { r: RequestRow }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] ps-1 justify-end" aria-label={t('مشخصات درخواست', 'Request details')}>
      {r.status && r.status !== 'success' && r.status !== 'ok' && <span className="chip chip-bad">{r.status}</span>}
      <TokenLine r={r} />
      <span className="chip ltr" title={r.model}>
        {modelLabel(r.model)}
      </span>
      <span className="num text-ink-3">{timeOf(r.ts, true)}</span>
    </div>
  );
}

// ---------- messages ----------
const Message = memo(function Message({ m }: { m: MessageRow }) {
  const { t } = useI18n();
  switch (m.kind) {
    case 'human':
      return <HumanBubble m={m} />;
    case 'agent_prompt':
      return <AgentPrompt m={m} />;
    case 'assistant_text':
      return <ClaudeBubble m={m} />;
    case 'thinking':
      return (
        <Collapsible icon={<BrainCircuit size={14} />} title={t('تفکر Claude', "Claude's thinking")} tone="claude" m={m}>
          {(txt) => <div className="msg-text text-ink-2 text-[13px]" dir="auto">{txt}</div>}
        </Collapsible>
      );
    case 'tool_use':
      return <ToolUse m={m} />;
    case 'tool_result':
      return <ToolResult m={m} />;
    case 'command':
      return (
        <div className="flex justify-start">
          <div className="inline-flex items-center gap-2 rounded-xl border border-accent-soft-border bg-accent-soft px-3 py-2 max-w-[90%]">
            <Slash size={14} className="text-accent shrink-0" />
            <span className="mono text-[13px] text-accent break-all">{m.text}</span>
            <span className="text-[11px] text-ink-3 shrink-0">{t('دستور', 'Command')}</span>
          </div>
        </div>
      );
    case 'system_reminder': {
      if (m.meta?.tag === 'scheduled')
        return (
          <div className="self-center inline-flex items-center gap-1.5 text-[11.5px] text-ink-3 bg-surface-2 rounded-full px-3 py-1" title={t('این دستور را /loop به‌طور خودکار اجرا کرد، نه کاربر', '/loop ran this command automatically, not the user')}>
            <Timer size={12} /> {t('اجرای خودکار', 'Automatic run')} <span className="mono ltr">{m.text}</span> <span className="num">{timeOf(m.created_at)}</span>
          </div>
        );
      const title = reminderTitle((m.meta?.tag as string | undefined) ?? '', t);
      return (
        <Collapsible icon={<Bell size={13} />} title={title} tone="muted" m={m}>
          {(txt) => <div className="mono text-[12px] text-ink-2 whitespace-pre-wrap break-words">{txt}</div>}
        </Collapsible>
      );
    }
    case 'local_output':
      return (
        <Collapsible icon={<Terminal size={13} />} title={t('خروجی دستور محلی', 'Local command output')} tone="muted" m={m}>
          {(txt) => <div className="mono text-[12px] whitespace-pre-wrap break-words">{txt}</div>}
        </Collapsible>
      );
    case 'interrupt':
      return (
        <div className="flex items-center gap-2 justify-center text-[12px] text-warn bg-warn-soft rounded-full py-1 px-3 self-center">
          <Hand size={13} /> {t('کاربر درخواست را متوقف کرد', 'The user stopped the request')}
        </div>
      );
    case 'image':
      return (
        <div className="flex justify-start">
          <span className="chip">
            <ImageIcon size={12} /> {t('تصویر ضمیمه شد', 'Image attached')}
          </span>
        </div>
      );
    default:
      return null;
  }
});

/** What the client injected into a user turn, by `meta.tag` (see server/src/normalize/turns.ts). */
function reminderTitle(tag: string, t: (fa: string, en: string) => string) {
  switch (tag) {
    case 'continuation-summary':
      return t('خلاصه‌ی ادامه‌ی گفتگو (compact)', 'Continuation summary (compact)');
    case 'task-notification':
      return t('اعلان تسک پس‌زمینه', 'Background task notification');
    case 'compact-request':
      return t('درخواست خلاصه‌سازی context', 'Context summary request');
    case 'command-body':
      return t('متن کامل دستور (افزوده‌ی کلاینت)', 'Full command text (added by the client)');
    case 'skill':
      return t('متن skill (افزوده‌ی کلاینت)', 'Skill text (added by the client)');
    case 'budget':
      return t('بودجه‌ی توکن', 'Token budget');
    case 'nudge':
      return t('یادآوری کلاینت', 'Client reminder');
    case 'injected':
      return t('متن افزوده‌ی کلاینت', 'Text added by the client');
    case 'scheduled':
      return t('اجرای خودکار /loop', 'Automatic /loop run');
    case 'hook':
      return t('خروجی hook', 'Hook output');
    case 'environment':
      return t('اطلاعات محیط اجرا', 'Runtime environment');
    case 'mcp':
      return t('دستورالعمل MCP', 'MCP instructions');
    case 'event':
      return t('رویداد کلاینت / IDE', 'Client / IDE event');
    case 'cross-session':
      return t('پیام از session دیگر', 'Message from another session');
    case 'notification':
      return t('اعلان سیستم', 'System notification');
    case 'file-changed':
      return t('تغییر فایل روی دیسک', 'File changed on disk');
    case 'plan-mode':
      return t('حالت plan', 'Plan mode');
    case 'auto-mode':
      return t('حالت auto', 'Auto mode');
    case 'caveat':
      return t('توضیح دستور محلی', 'Local command note');
    case 'memory':
      return 'CLAUDE.md';
    case 'helper':
      return t('متن کمکی', 'Helper text');
    case 'tool-echo':
      return t('تکرار خروجی ابزار', 'Repeated tool output');
    default:
      return t('یادآوری سیستم', 'System reminder');
  }
}

/** Text capped at 12k by the list endpoint; fetches the rest on demand. */
// `len` counts characters as Postgres does (an emoji is one), not UTF-16 units as String.length does
const cut = (m: MessageRow) => m.len > Array.from(m.text).length;
function useFullText(m: MessageRow) {
  const { t } = useI18n();
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const truncated = m.id > 0 && cut(m) && full === null;
  const load = async () => {
    setLoading(true);
    try {
      setFull((await get<{ text: string }>(`/api/messages/${m.id}`)).text);
    } finally {
      setLoading(false);
    }
  };
  const more = truncated ? (
    <button className="btn btn-sm mt-2" onClick={load} disabled={loading}>
      {loading && <Spinner size={13} />} {t(`نمایش متن کامل (${int(m.len)} نویسه)`, `Show full text (${int(m.len)} characters)`)}
    </button>
  ) : null;
  return { text: full ?? m.text, more, load: () => (truncated && !loading ? load() : undefined) };
}

function Bubble({ m, who, children }: { m: MessageRow; who: 'user' | 'claude'; children: ReactNode }) {
  const { t } = useI18n();
  const user = who === 'user';
  return (
    <div className={cx('flex gap-2.5', user ? 'justify-start' : 'justify-start flex-row-reverse')}>
      <div
        className={cx('size-8 rounded-full grid place-items-center shrink-0 text-[12px] font-bold mt-0.5', user ? 'bg-accent text-[var(--accent-ink)]' : 'bg-claude text-white')}
        aria-hidden
      >
        {user ? <User size={15} /> : 'C'}
      </div>
      <div
        className={cx(
          'min-w-0 max-w-[min(100%,820px)] rounded-2xl px-4 py-3 border',
          user ? 'bg-accent-soft border-[var(--accent-soft-border)] rounded-ss-md' : 'bg-surface border-line rounded-se-md relative before:content-[""] before:absolute before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-claude before:end-0',
        )}
      >
        <div className="flex items-center gap-2 text-[11.5px] mb-1 text-ink-3">
          <b className={cx('font-semibold', user ? 'text-accent' : 'text-claude')}>{user ? t('کاربر', 'User') : 'Claude'}</b>
          <span className="num">{timeOf(m.created_at)}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function HumanBubble({ m }: { m: MessageRow }) {
  const { t } = useI18n();
  const { text, more } = useFullText(m);
  const queued = m.meta?.queued === true;
  return (
    <Bubble m={m} who="user">
      {queued && <div className="text-[11px] text-ink-3 mb-1">{t('در حین کار Claude فرستاده شد', 'Sent while Claude was working')}</div>}
      <div className="msg-text text-[14px]" dir="auto">
        {queued ? text.replace(/^\s*The user sent the following message:\s*/i, '').replace(/\s*Please address this message and continue with your tasks\.?\s*$/i, '') : text}
      </div>
      {more}
    </Bubble>
  );
}

/** The task Claude gave a subagent: written by Claude, not by the person. */
function AgentPrompt({ m }: { m: MessageRow }) {
  const { t } = useI18n();
  const { text, more } = useFullText(m);
  return (
    <div className="flex justify-end">
      <div className="rounded-xl border border-claude/30 bg-claude-soft px-3 py-2 max-w-[min(100%,820px)] min-w-0 w-full sm:w-auto">
        <div className="flex items-center gap-2 text-[11.5px] text-claude font-semibold mb-1">
          <Bot size={13} /> {t('دستور Claude به زیرعامل', "Claude's instruction to the subagent")} <span className="num text-ink-3 font-normal">{timeOf(m.created_at)}</span>
        </div>
        <div className="md text-[13px]">
          <Markdown remarkPlugins={md} components={mdComponents}>
            {text}
          </Markdown>
        </div>
        {more}
      </div>
    </div>
  );
}

function ClaudeBubble({ m }: { m: MessageRow }) {
  const { text, more } = useFullText(m);
  return (
    <Bubble m={m} who="claude">
      <div className="md text-[14px]">
        <Markdown remarkPlugins={md} components={mdComponents}>
          {text}
        </Markdown>
      </div>
      {more}
    </Bubble>
  );
}

function Collapsible({ icon, title, tone, m, children, defaultOpen = false }: { icon: ReactNode; title: string; tone: 'claude' | 'muted'; m: MessageRow; children: (text: string) => ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { text, more, load } = useFullText(m);
  return (
    <div className="rounded-xl border border-line bg-[var(--tool-bg)] overflow-hidden max-w-[min(100%,820px)] w-full self-center">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-3 bg-transparent border-0 cursor-pointer text-start"
        onClick={() => {
          if (!open) void load();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <span className={tone === 'claude' ? 'text-claude' : ''}>{icon}</span>
        <span className="grow">{title}</span>
        <span className="num opacity-70">{int(m.len)}</span>
        <ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-3 pb-3 max-h-[480px] overflow-auto">
          {children(text)}
          {more}
        </div>
      )}
    </div>
  );
}

function ToolUse({ m }: { m: MessageRow }) {
  const name = String(m.meta?.name ?? 'tool');
  const isShell = name === 'Bash' || name === 'PowerShell';
  return (
    <div className="flex justify-end">
      <div className="rounded-xl border border-line bg-[var(--tool-bg)] px-3 py-2 max-w-[min(100%,820px)] min-w-0 w-full sm:w-auto" dir="ltr">
        <div className="flex items-center gap-2 text-[12px] text-ink-3">
          <Wrench size={13} className="text-claude shrink-0" />
          <b className="mono font-semibold text-ink-2">{name}</b>
        </div>
        {m.text && (
          <pre className="mono m-0 mt-1 text-[12.5px] whitespace-pre-wrap break-words text-ink max-h-[220px] overflow-auto">
            {isShell && <span className="text-ink-3 select-none">$ </span>}
            {m.text}
          </pre>
        )}
      </div>
    </div>
  );
}

function ToolResult({ m }: { m: MessageRow }) {
  const { t } = useI18n();
  const err = m.meta?.isError === true;
  const lines = m.text.split('\n');
  const [all, setAll] = useState(false);
  const { text, more, load } = useFullText(m);
  const shownText = all ? text : text.split('\n').slice(0, 12).join('\n');
  const long = lines.length > 12 || cut(m);
  return (
    <div className="flex justify-end">
      <div className={cx('rounded-xl border px-3 py-2 max-w-[min(100%,820px)] min-w-0 w-full sm:w-auto', err ? 'border-bad/40 bg-bad-soft' : 'border-line bg-[var(--tool-bg)]')} dir="ltr">
        <div className={cx('flex items-center gap-2 text-[12px]', err ? 'text-bad' : 'text-ink-3')}>
          {err ? <TriangleAlert size={13} /> : <Terminal size={13} />}
          {err ? t('خطای ابزار', 'Tool error') : t('خروجی ابزار', 'Tool output')}
        </div>
        {m.text ? (
          <pre className="mono m-0 mt-1 text-[12px] whitespace-pre-wrap break-words max-h-[360px] overflow-auto">{shownText}</pre>
        ) : (
          <div className="text-[12px] text-ink-3 mt-1">{t('(خالی)', '(empty)')}</div>
        )}
        {long && !all && (
          <button className="btn btn-sm mt-2" onClick={() => {
              setAll(true);
              void load();
            }}
          >
            {t('نمایش همه', 'Show all')}
          </button>
        )}
        {all && more}
      </div>
    </div>
  );
}

export type { ResponseBlock };
