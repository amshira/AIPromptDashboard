import { getLang } from './lang';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

export const qs = (p?: Params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p ?? {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized?.();
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, code);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const get = <T,>(url: string, p?: Params) => api<T>('GET', url + qs(p));

const ERRORS: Record<string, { fa: string; en: string }> = {
  bad_password: { fa: 'رمز عبور نادرست است.', en: 'Wrong password.' },
  locked: { fa: 'تعداد تلاش‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کنید.', en: 'Too many attempts. Try again in a few minutes.' },
  password_too_short: { fa: 'رمز جدید باید دست‌کم ۸ نویسه باشد.', en: 'The new password must be at least 8 characters.' },
  invalid: { fa: 'ورودی نامعتبر است.', en: 'That input is not valid.' },
  every_min_required: { fa: 'فاصله‌ی اجرا (دقیقه) را وارد کنید.', en: 'Enter how many minutes between runs.' },
  cron_required: { fa: 'عبارت cron را وارد کنید.', en: 'Enter a cron expression.' },
  hours_pair: { fa: 'ساعت شروع و پایان باید با هم تنظیم شوند.', en: 'Start and end time must both be set.' },
  already_running: { fa: 'همگام‌سازی همین الان در حال اجراست.', en: 'A sync is already running.' },
  bad_retention: { fa: 'عدد نگهداری باید بین ۱ تا ۳۶۵۰ روز باشد.', en: 'Retention must be between 1 and 3650 days.' },
  different_source: { fa: 'فقط کاربران یک منبع را می‌توان ادغام کرد.', en: 'Only users from the same source can be merged.' },
  not_found: { fa: 'مورد پیدا نشد.', en: 'Not found.' },
  no_agent_exe: { fa: 'فایل pd-agent.exe روی سرور داشبورد نیست (پوشه‌ی agent-bin).', en: 'pd-agent.exe is not on the dashboard server (agent-bin folder).' },
  agent_too_old: { fa: 'این agent قدیمی‌تر از نسخه‌ای است که از سرور به‌روز می‌شود. یک بار دستور نصب را روی همان کامپیوتر دوباره اجرا کنید.', en: 'This agent is older than the version that can be updated from the server. Run the install command once on that computer.' },
  agent_version_unknown: { fa: 'نسخه agent هنوز خوانده نشده. اول «بررسی دوباره» را بزنید.', en: 'The agent version has not been read yet. Click Check again first.' },
  not_a_windows_agent: { fa: 'این مورد یک agent ویندوزی نیست.', en: 'This is not a Windows agent.' },
  no_pc_allow: { fa: 'PC_AGENT_ALLOW در تنظیمات سرور داشبورد خالی است.', en: 'PC_AGENT_ALLOW is empty in the dashboard server settings.' },
  bad_origin: { fa: 'نشانی داشبورد معتبر نیست.', en: 'The dashboard address is not valid.' },
  bad_url: { fa: 'نشانی باید با http:// یا https:// شروع شود.', en: 'The address must start with http:// or https://.' },
  bad_name: { fa: 'نام کوتاه فقط حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط می‌تواند باشد.', en: 'The short name can only use letters, digits, dots, hyphens and underscores.' },
  name_taken: { fa: 'سروری با این نام کوتاه قبلاً اضافه شده است.', en: 'A server with this short name already exists.' },
  not_deleted: { fa: 'این پنل هنوز حذف نشده است.', en: 'This panel is not deleted.' },
  password_unreadable: { fa: 'این رمز با کلید قبلی داشبورد ذخیره شده و دیگر خوانده نمی‌شود؛ دوباره واردش کنید.', en: 'This password was saved with an older dashboard key and can no longer be read. Enter it again.' },
  detected_panel: { fa: 'پنل 9routerهای شناسایی‌شده حذف نمی‌شود؛ با حذف منبع از تنظیمات برداشته می‌شود.', en: 'A detected 9router panel is removed by deleting its source in Settings.' },
};
const msg = (pair: { fa: string; en: string }) => (getLang() === 'en' ? pair.en : pair.fa);
export function errorText(e: unknown): string {
  const en = getLang() === 'en';
  if (e instanceof ApiError) {
    if (e.code.startsWith('bad_cron')) return en ? 'The cron expression is not valid.' : 'عبارت cron معتبر نیست.';
    if (e.status === 429) return msg(ERRORS.locked);
    // the agent's own message (unreachable, wrong token…) is passed through
    if (e.status === 422 || e.status === 502) return agentErrorText(e.code);
    return ERRORS[e.code] ? msg(ERRORS[e.code]) : en ? `Error (${e.code})` : `خطا (${e.code})`;
  }
  return en ? 'Could not reach the server.' : 'ارتباط با سرور برقرار نشد.';
}
/** Text for the agent errors produced by server/src/ingest/reader.ts. */
export function agentErrorText(raw: string): string {
  const en = getLang() === 'en';
  if (raw.startsWith('cannot reach')) return en ? `The agent is unreachable. Check the address, port and firewall. (${raw})` : `agent در دسترس نیست؛ نشانی، پورت و فایروال را بررسی کنید. (${raw})`;
  if (raw === 'agent rejected the token') return en ? 'The agent rejected the token. It must match AGENT_TOKEN on that server.' : 'agent توکن را نپذیرفت؛ باید با AGENT_TOKEN روی آن سرور یکی باشد.';
  if (raw.startsWith('certificate mismatch')) return en ? 'The certificate does not match the pairing code: the address is wrong, or the agent was reinstalled and needs a new pairing code.' : 'گواهی این نشانی با کد اتصال نمی‌خواند: یا نشانی اشتباه است یا agent دوباره نصب شده و کد اتصال تازه لازم است.';
  if (raw.startsWith('agent answered 404 (wrong pairing'))
    return en ? 'The agent rejected the request: the pairing code is wrong, or this server and that computer disagree by more than two minutes.' : 'agent درخواست را نپذیرفت: کد اتصال درست نیست یا ساعت این سرور و آن کامپیوتر بیش از دو دقیقه اختلاف دارد.';
  if (raw === 'bad_pairing') return en ? 'The pairing code is not valid.' : 'کد اتصال معتبر نیست.';
  return en ? `Could not connect: ${raw}` : `اتصال به سرور برقرار نشد: ${raw}`;
}

// ---------- types ----------
export interface Meta {
  sources: { id: number; name: string; label: string; enabled: boolean }[];
  models: string[];
  /** 9router api keys */
  keys: { id: number; source_id: number; name: string }[];
  /** people: OS accounts seen in the prompts */
  clients: { name: string; source_ids: number[] }[];
  today: string;
}
export interface Sums {
  requests: number;
  aux_requests: number;
  human_messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  aux_tokens: number;
}
export interface SourceInfo {
  id: number;
  name: string;
  label: string;
  enabled: boolean;
  retention_days: number | null;
  last_sync_at: string | null;
  last_error: string | null;
  gap_detected: boolean;
  last_cursor_ts: string | null;
  total_requests: number;
  total_sessions?: number;
  syncing: boolean;
  server_id: number | null;
  path: string | null;
  missing_since: string | null;
}
export interface ServerInfo {
  id: number;
  name: string;
  label: string;
  url: string;
  /** server: 9routers through agent.ts; windows: a paired Windows PC (Cursor) */
  kind: 'server' | 'windows';
  enabled: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  source_count: number;
}
/** A profile on a Windows PC, as its agent last described it. */
export interface PcProfile {
  name: string;
  profile: string;
  /** cursor | codex — which local app this source is */
  kind?: string;
  /** DOMAIN\user */
  account?: string;
  /** Cursor account signed in on that profile */
  email?: string;
  plan?: string;
  chats: number;
  last_used?: string;
  error?: string;
}
export interface PcInfo {
  id: number;
  name: string;
  label: string;
  url: string;
  enabled: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  info: { agent: { host: string; version: string } | null; sources: PcProfile[] } | null;
  /** what the dashboard read from each profile */
  sources: { id: number; remote_name: string; last_sync_at: string | null; last_error: string | null; requests: number; last_at: string | null }[];
}
export interface Overview {
  from: string;
  to: string;
  kpi: Sums & { users: number; keys: number; sessions: number };
  daily_by_source: (Sums & { day: string; key: string })[];
  daily_by_model: (Sums & { day: string; key: string })[];
  top_users: (Sums & { name: string; source: string; source_id: number; keys: string[]; sessions: number })[];
  models: (Sums & { model: string })[];
  sources: SourceInfo[];
}
/** A person = one 9router api key (`hint` is the key's name in 9router). */
export interface UserRow extends Sums {
  id: number;
  source_id: number;
  source?: string;
  name: string;
  display_name: string | null;
  hint: string;
  fingerprint: string;
  sessions: number;
  last_at: string;
  /** OS accounts this key was used from */
  machines?: string[] | null;
}
/** A person: the OS account behind one or more keys. */
export interface ClientRow extends Sums {
  name: string;
  source_id: number;
  source: string;
  sessions: number;
  last_at: string;
  keys: string[];
}

/** One conversation: every thread of a chat (main, after compaction, rewinds, subagents). */
export interface SessionRow extends Sums {
  id: number;
  source_id: number;
  source: string;
  user_id: number;
  user_name: string;
  title: string;
  first_at: string;
  last_at: string;
  machine_user: string;
  models: string[];
  subagents: number;
  branches: number;
  compactions: number;
  /** activity bursts more than 30 minutes apart: how often the person came back */
  visits: number;
  last_human: string | null;
  last_human_at: string | null;
  total: number;
}
export interface MessageRow {
  id: number;
  session_id?: number;
  seq: number;
  role: 'user' | 'assistant';
  kind: string;
  text: string;
  len: number;
  meta: Record<string, unknown> | null;
  created_at: string;
}
export interface ResponseBlock {
  kind: string;
  role: string;
  text: string;
  meta?: Record<string, unknown>;
}
export interface RequestRow {
  id: string;
  session_id?: number | null;
  ts: string;
  model: string;
  provider: string;
  status: string;
  kind: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  truncated: boolean;
  original_size: number | null;
  preview: string | null;
  msg_from_seq: number | null;
  msg_to_seq: number | null;
  history_len: number;
  response: ResponseBlock[] | null;
  human_count: number;
}
export type ThreadKind = 'main' | 'continuation' | 'branch' | 'subagent';
export interface ThreadRow {
  id: number;
  kind: ThreadKind;
  title: string;
  first_at: string;
  last_at: string;
  skip_seq: number;
}
export interface SessionDetail {
  session: { id: number; source_id: number; source: string; user_id: number; user_name: string; title: string; first_at: string; last_at: string; external_session_id: string | null; machine_user: string };
  threads: ThreadRow[];
  /** messages of every thread; a branch only sends what is new in it */
  messages: MessageRow[];
  requests: RequestRow[];
  aux: RequestRow[];
}
export interface DailyRow extends Sums {
  day: string;
  day_shamsi: string;
  source?: string;
  client?: string;
  user_id?: number;
  user_name?: string;
  model?: string;
  models: string[];
  sessions: number;
  avg_latency_ms: number;
}
export interface Schedule {
  id: number;
  name: string;
  source_ids: number[];
  mode: 'interval' | 'cron';
  every_min: number | null;
  cron: string | null;
  days: number[] | null;
  from_hour: number | null;
  to_hour: number | null;
  enabled: boolean;
  last_run_at: string | null;
  next_runs: string[];
}
export interface RunRow {
  id: number;
  source: string;
  schedule: string | null;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  rows_read: number;
  rows_new: number;
  gap: boolean;
  error: string | null;
}
export interface SettingsInfo {
  retention_days: number | null;
  retention_last: { at: string; requests: number; sessions: number } | null;
  db_bytes: number;
  tables: { name: string; bytes: number; rows: number }[];
  disk: { total: number; free: number } | null;
  version: string;
}

export interface PanelInfo {
  id: number;
  source_id: number | null;
  name: string;
  org: string;
  container: string | null;
  quota_port: number | null;
  panel_domain: string | null;
  quota_domain: string | null;
  notes: string;
  has_password: boolean;
  password_from: string | null;
  password_at: string | null;
  source_name: string | null;
  source_label: string | null;
  missing_since: string | null;
  /** set while the card waits in the deleted list; purged for good at purge_at */
  deleted_at: string | null;
  purge_at: string | null;
  requests_today: number | null;
  tokens_today: number;
  requests_30d: number | null;
  last_request_at: string | null;
  clients: number | null;
  keys: number | null;
}
export interface PanelCheck {
  ok: boolean;
  code?: number;
  ms?: number;
  error?: string;
}
export type PanelTarget = 'router' | 'panel_domain' | 'quota_domain';
export interface PanelStatus {
  status: Record<number, Record<PanelTarget, PanelCheck | null>>;
  checked_at: string;
}
