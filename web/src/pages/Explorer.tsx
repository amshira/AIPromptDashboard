import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, ChevronLeft, ChevronRight, GitBranch, KeyRound, Layers, RotateCcw, Search, User, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClientSelect, DateRange, KeySelect, ModelSelect, SourceSelect, useFilters, useMeta } from '../components/Filters';
import { cx, Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import { ClientRow, get, SessionRow } from '../lib/api';
import { compact, gregDate, int, modelLabel, relative, timeOf, uiDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

const PAGE = 30;

export default function Explorer() {
  const { t } = useI18n();
  const f = useFilters(30);
  const [text, setText] = useState(f.sp.get('q') ?? '');
  // debounce the search box into the URL
  useEffect(() => {
    const timer = setTimeout(() => (f.sp.get('q') ?? '') !== text.trim() && f.set({ q: text.trim() || null }), 350);
    return () => clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = { from: f.from, to: f.to, source: f.sp.get('source'), model: f.sp.get('model') };
  // `user` = 9router key, `client` = the person (OS account) using it
  const key = f.sp.get('user');
  const client = f.sp.get('client');
  const offset = Number(f.sp.get('offset') ?? 0) || 0;

  const meta = useMeta();
  const manySources = (meta.data?.sources.length ?? 0) > 1;
  const keyName = meta.data?.keys.find((k) => String(k.id) === key)?.name;
  const sep = t('، ', ', ');
  // refreshed in the background: a chat the person returns to moves to the top by itself
  const clients = useQuery({
    queryKey: ['clients', base, key],
    queryFn: () => get<{ clients: ClientRow[] }>('/api/clients', { ...base, user: key }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const sessions = useQuery({
    queryKey: ['sessions', base, key, client, f.sp.get('q'), offset],
    queryFn: () => get<{ total: number; sessions: SessionRow[] }>('/api/sessions', { ...base, user: key, client, q: f.sp.get('q'), limit: PAGE, offset }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const total = sessions.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title={t('گفتگوها', 'Conversations')}
        subtitle={t(
          'کاربر = حساب سیستمی که با آن کار شده؛ کلید = کلید API در 9router. هر گفتگو یک session است و وقتی کاربر به آن برمی‌گردد، همان گفتگو ادامه پیدا می‌کند و بالای فهرست می‌آید',
          'User = the OS account that was used; Key = the API key in 9router. Each conversation is a session, and when the user returns to it, that conversation continues and moves to the top of the list.',
        )}
      />
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <DateRange f={f} />
        <div className="flex flex-wrap gap-2 ms-auto">
          <SourceSelect f={f} />
          <ClientSelect f={f} />
          <KeySelect f={f} />
          <ModelSelect f={f} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[290px_1fr] items-start">
        {/* people column */}
        <aside className="card overflow-hidden lg:sticky lg:top-5" aria-label={t('کاربران', 'Users')}>
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <h2 className="m-0 text-[14px] font-bold">{t('کاربران', 'Users')}</h2>
            {client && (
              <button className="btn btn-ghost btn-sm" onClick={() => f.set({ client: null })}>
                <X size={13} /> {t('همه', 'All')}
              </button>
            )}
          </div>
          <div className="max-h-[320px] lg:max-h-[calc(100vh-190px)] overflow-y-auto p-2">
            {clients.isLoading ? (
              Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[52px] mb-1.5" />)
            ) : !clients.data?.clients.some((c) => c.name) ? (
              <Empty title={t('کاربری در این بازه نیست', 'No users in this range')} />
            ) : (
              clients.data.clients
                .filter((c) => c.name)
                .map((c) => (
                  <button
                    key={`${c.source_id}:${c.name}`}
                    onClick={() => f.set({ client: c.name === client ? null : c.name })}
                    aria-pressed={c.name === client}
                    className={cx(
                      'w-full text-start rounded-[10px] px-3 py-2 mb-0.5 border cursor-pointer transition-colors bg-transparent',
                      c.name === client ? 'bg-accent-soft border-accent-soft-border' : 'border-transparent hover:bg-surface-2',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[13px] truncate ltr inline-flex items-center gap-1.5">
                        <User size={12} className="shrink-0 text-ink-3" /> {c.name}
                      </span>
                      <span className="num text-[11.5px] text-ink-3 shrink-0">{compact(c.input_tokens + c.output_tokens)}</span>
                    </div>
                    <div className="text-[11px] text-ink-3 flex items-center gap-1.5 min-w-0 mt-0.5">
                      {manySources && <span className="chip !py-0 !text-[10.5px] shrink-0">{c.source}</span>}
                      <span className="truncate ltr inline-flex items-center gap-1" title={t(`کلید: ${c.keys.join(sep)}`, `API key: ${c.keys.join(sep)}`)}>
                        <KeyRound size={11} className="shrink-0" /> {c.keys.join(sep)}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-ink-3 flex gap-2">
                      <span>{t(`${int(c.sessions)} گفتگو`, `${int(c.sessions)} ${c.sessions === 1 ? 'conversation' : 'conversations'}`)}</span>
                      <span>·</span>
                      <span>{t(`${int(c.human_messages)} پیام`, `${int(c.human_messages)} ${c.human_messages === 1 ? 'message' : 'messages'}`)}</span>
                      <span className="ms-auto">{relative(c.last_at)}</span>
                    </div>
                  </button>
                ))
            )}
          </div>
        </aside>

        {/* sessions column */}
        <section aria-label={t('گفتگوها', 'Conversations')} className="min-w-0">
          <div className="relative mb-3">
            <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-3 pointer-events-none" />
            <input className="input !ps-9 !h-11" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('جستجو در متن پیام‌های کاربر و Claude…', 'Search user and Claude message text…')} aria-label={t('جستجو', 'Search')} />
          </div>
          <div className="flex items-center justify-between text-[12.5px] text-ink-3 mb-2 px-1">
            <span>
              {client && (
                <>
                  {t('کاربر', 'User')} <b className="text-ink ltr">{client}</b> ·{' '}
                </>
              )}
              {keyName && (
                <>
                  {t('کلید', 'Key')} <b className="text-ink ltr">{keyName}</b> ·{' '}
                </>
              )}
              <span className="num">{int(total)}</span> {t('گفتگو', total === 1 ? 'conversation' : 'conversations')}
            </span>
            {sessions.isFetching && <span>{t('در حال بروزرسانی…', 'Updating…')}</span>}
          </div>

          {sessions.error ? <ErrorBox error={sessions.error} retry={() => sessions.refetch()} /> : null}
          {sessions.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-[84px]" />
              ))}
            </div>
          ) : !sessions.data?.sessions.length ? (
            <div className="card">
              <Empty title={t('گفتگویی پیدا نشد', 'No conversations found')} hint={t('فیلترها یا عبارت جستجو را تغییر دهید.', 'Change the filters or the search text.')} />
            </div>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {sessions.data.sessions.map((s) => (
                <SessionItem key={s.id} s={s} showClient={!client} showKey={!key} />
              ))}
            </ul>
          )}

          {total > PAGE && (
            <div className="flex items-center justify-center gap-3 mt-4">
              <button className="btn btn-sm" disabled={offset === 0} onClick={() => f.setOffset(Math.max(0, offset - PAGE))}>
                <ChevronRight size={15} /> {t('قبلی', 'Previous')}
              </button>
              <span className="text-[12.5px] text-ink-3 num">
                {offset + 1}–{Math.min(total, offset + PAGE)} / {total}
              </span>
              <button className="btn btn-sm" disabled={offset + PAGE >= total} onClick={() => f.setOffset(offset + PAGE)}>
                {t('بعدی', 'Next')} <ChevronLeft size={15} />
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function SessionItem({ s, showClient, showKey }: { s: SessionRow; showClient: boolean; showKey: boolean }) {
  const { t, lang } = useI18n();
  const tokens = s.input_tokens + s.output_tokens;
  return (
    <li>
      <Link to={`/sessions/${s.id}`} className="card block no-underline text-ink px-4 py-3 hover:border-line-strong transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[14px] leading-snug msg-text !whitespace-normal line-clamp-2" dir="auto">
              {s.title || t('(بدون عنوان)', '(Untitled)')}
            </div>
            {s.last_human && s.last_human !== s.title && (
              <div className="mt-1 text-[12.5px] text-ink-2 msg-text !whitespace-normal line-clamp-1" dir="auto" title={s.last_human}>
                <span className="text-ink-3">{t('آخرین پیام کاربر: ', 'Last user message: ')}</span>
                {s.last_human}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
              <span className="chip">{s.source}</span>
              {showClient && s.machine_user && (
                <span className="ltr inline-flex items-center gap-1 text-ink-2 font-medium" title={t('کاربر (حساب سیستم‌عامل)', 'User (OS account)')}>
                  <User size={11} /> {s.machine_user}
                </span>
              )}
              {showKey && (
                <span className="ltr inline-flex items-center gap-1" title={t('کلید API در 9router', 'API key in 9router')}>
                  <KeyRound size={11} /> {s.user_name}
                </span>
              )}
              {s.visits > 1 && (
                <span className="chip chip-accent" title={t('کاربر چند بار (با فاصله‌ی بیش از ۳۰ دقیقه) به این گفتگو برگشته است', 'The user returned to this conversation more than once (more than 30 minutes apart)')}>
                  <RotateCcw size={11} /> {t(`${int(s.visits)} بار ادامه`, `${int(s.visits)} ${s.visits === 1 ? 'resume' : 'resumes'}`)}
                </span>
              )}
              {s.subagents > 0 && (
                <span className="chip" title={t('زیرعامل‌هایی که Claude در این گفتگو اجرا کرد', 'Subagents Claude ran in this conversation')}>
                  <Bot size={11} /> {t(`${int(s.subagents)} زیرعامل`, `${int(s.subagents)} ${s.subagents === 1 ? 'subagent' : 'subagents'}`)}
                </span>
              )}
              {s.compactions > 0 && (
                <span className="chip" title={t('context گفتگو خلاصه و فشرده شد و گفتگو ادامه پیدا کرد', 'Conversation context was summarized and compacted, and the conversation continued')}>
                  <Layers size={11} /> {t(`${int(s.compactions)} فشرده‌سازی`, `${int(s.compactions)} ${s.compactions === 1 ? 'compaction' : 'compactions'}`)}
                </span>
              )}
              {s.branches > 0 && (
                <span className="chip chip-warn" title={t('کاربر به عقب برگشت یا پیامی را ویرایش کرد', 'The user went back or edited a message')}>
                  <GitBranch size={11} /> {t(`${int(s.branches)} شاخه`, `${int(s.branches)} ${s.branches === 1 ? 'branch' : 'branches'}`)}
                </span>
              )}
              {s.models.filter(Boolean).slice(0, 3).map((m) => (
                <span key={m} className="chip ltr">
                  {modelLabel(m)}
                </span>
              ))}
            </div>
          </div>
          <div className="text-end shrink-0 text-[12px] text-ink-3 leading-tight">
            <div className="text-ink-2 font-medium">{uiDate(s.last_at)}</div>
            <div className="num">
              {timeOf(s.last_at)}{lang === 'fa' && <> <span className="opacity-70">· {gregDate(s.last_at).slice(5)}</span></>}
            </div>
          </div>
        </div>
        <div className="mt-2.5 pt-2.5 border-t border-line flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
          <Stat l={t('پیام کاربر', 'User messages')} v={int(s.human_messages)} />
          <Stat l={t('درخواست', 'Requests')} v={int(s.requests)} />
          <Stat l={t('ورودی', 'Input')} v={compact(s.input_tokens)} />
          <Stat l={t('خروجی', 'Output')} v={compact(s.output_tokens)} />
          <Stat l={t('کش', 'Cache')} v={compact(s.cache_read)} />
          <span className="ms-auto num font-semibold text-ink-2" title={t(`${int(tokens)} توکن`, `${int(tokens)} ${tokens === 1 ? 'token' : 'tokens'}`)}>
            {compact(tokens)} {t('توکن', tokens === 1 ? 'token' : 'tokens')}
          </span>
        </div>
      </Link>
    </li>
  );
}

const Stat = ({ l, v }: { l: string; v: string }) => (
  <span>
    {l}: <b className="num text-ink-2 font-semibold">{v}</b>
  </span>
);
