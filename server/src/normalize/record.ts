import { createHash } from 'node:crypto';
import { Block, messageToBlocks, titleFromBlocks } from './blocks.js';
import { cleanText } from './text.js';
import { firstPrompt, firstTurn, identityOf, refineKinds } from './turns.js';

export type RequestKind = 'main' | 'subagent' | 'classifier' | 'title' | 'compact' | 'other';

export interface RawRow {
  id: string;
  timestamp: string;
  provider: string | null;
  model: string | null;
  connectionId: string | null;
  status: string | null;
  data: string;
}

/** Which 9router api key sent a request; the secret itself never leaves the reader. */
export interface KeyRef {
  id: string;
  name: string;
}

export interface ParsedRecord {
  id: string;
  ts: string; // ISO
  provider: string;
  model: string;
  status: string;
  kind: RequestKind;
  truncated: boolean;
  preview?: string;
  originalSize?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  latencyMs: number | null;
  ttftMs: number | null;
  /** OS account seen in paths of the prompt (C:\Users\<x>), shown next to the key */
  userHint: string;
  externalSessionId: string | null;
  /** hash of the first user turn: identifies a thread inside its conversation */
  firstTurnHash: string;
  /** first user turn + first answer: finds the same chat again when it is resumed under a new session id */
  rootHash: string | null;
  continuation: boolean;
  history: Block[]; // blocks of the request history (system excluded), kinds refined per turn
  response: Block[]; // blocks of the response (may be empty for pure tool_use streams)
  title: string;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system))
    return system
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('\n');
  return '';
}

/** `user_<hash>_account_<uuid>_session_<uuid>` (Claude Code) or a JSON string with the same keys. */
export function parseMetadataUserId(meta: unknown): { account?: string; device?: string; session?: string } {
  if (!meta || typeof meta !== 'object') return {};
  const uid = (meta as { user_id?: unknown }).user_id;
  if (typeof uid !== 'string' || !uid) return {};
  if (uid.trim().startsWith('{')) {
    try {
      const j = JSON.parse(uid) as Record<string, string>;
      return { account: j.account_uuid || j.account_id, device: j.device_id, session: j.session_id };
    } catch {
      /* fall through */
    }
  }
  const m = /^user_([0-9a-f]+)(?:_account_([0-9a-f-]*))?(?:_session_([0-9a-f-]+))?$/i.exec(uid);
  if (m) return { device: m[1], account: m[2] || undefined, session: m[3] };
  return { device: uid };
}

const HOME_RE = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([A-Za-z0-9._ -]{2,64})/;

export interface Shape {
  sys: string;
  /** all user-side text of the request, raw (before kind refinement) */
  userText: string;
  /** text of the last user turn */
  lastText: string;
  toolNames: string[];
  maxTokens: number | null;
  hasSession: boolean;
}

/**
 * 9router does not log the system prompt of Claude Code requests, so the kind is read from what the request
 * carries: its tools, its size limit and the text of its messages.
 */
export function classify(x: Shape): RequestKind {
  const hasTools = x.toolNames.length > 0;
  const head = x.userText.slice(0, 20_000);
  const all = `${x.sys.slice(0, 4000)}\n${head}\n${x.userText.slice(-6000)}`;
  if (/^\s*(CRITICAL: Respond with TEXT ONLY|Your task is to create a detailed summary of the conversation so far)/m.test(x.lastText)) return 'compact';
  if (!hasTools) {
    if (/<\/?transcript>/.test(head) || /Stage 1 does NOT apply|Review the classification process|Err on the side of blocking|<block>(yes|no)|Respond with <severity>|security monitor/i.test(all)) return 'classifier';
    if (/You are coming up with a succinct title|Generate a (short |concise )?(title|name)|isNewTopic|sentence-case title|summariz(e|ing) the conversation/i.test(all)) return 'title';
    if (x.maxTokens != null && x.maxTokens > 0 && x.maxTokens <= 16) return 'other'; // quota / health probes
  }
  if (/You are (an? )?(agent|sub-?agent)|general-purpose agent|Explore agent|file search specialist/i.test(x.sys.slice(0, 4000))) return 'subagent';
  // Claude Code gives the Agent tool to the main loop only; subagents cannot start subagents.
  if (hasTools && x.hasSession && !x.toolNames.some((n) => n === 'Agent' || n === 'Task')) return 'subagent';
  return 'main';
}

function responseBlocks(resp: unknown): Block[] {
  if (!resp || typeof resp !== 'object') return [];
  const r = resp as { content?: unknown; thinking?: unknown };
  const out: Block[] = [];
  if (typeof r.content === 'string') {
    const t = cleanText(r.content).trim();
    if (t && t !== '[Empty streaming response]') out.push({ kind: 'assistant_text', role: 'assistant', text: t });
  } else if (Array.isArray(r.content)) {
    out.push(...messageToBlocks('assistant', r.content));
  }
  return out;
}

export function parseRow(row: RawRow): ParsedRecord | null {
  let j: Record<string, any>;
  try {
    j = JSON.parse(row.data);
  } catch {
    return null;
  }
  const q = (j.request ?? {}) as Record<string, any>;
  const t = (j.tokens ?? {}) as Record<string, unknown>;
  const lat = (j.latency ?? {}) as Record<string, unknown>;
  const base = {
    id: row.id,
    ts: new Date(row.timestamp || j.timestamp).toISOString(),
    provider: String(row.provider ?? j.provider ?? ''),
    model: String(row.model ?? j.model ?? ''),
    status: String(row.status ?? j.status ?? ''),
    tokens: {
      input: num(t.prompt_tokens ?? t.input_tokens),
      output: num(t.completion_tokens ?? t.output_tokens),
      cacheRead: num(t.cache_read_input_tokens),
      cacheWrite: num(t.cache_creation_input_tokens),
    },
    latencyMs: lat.total == null ? null : num(lat.total),
    ttftMs: lat.ttft == null ? null : num(lat.ttft),
  };

  if (q._truncated) {
    const preview = cleanText(String(q._preview ?? ''));
    return {
      ...base,
      kind: 'main',
      truncated: true,
      preview,
      originalSize: num(q._originalSize),
      userHint: HOME_RE.exec(preview)?.[1]?.trim() ?? '',
      externalSessionId: null,
      firstTurnHash: '',
      rootHash: null,
      continuation: false,
      history: [],
      response: responseBlocks(j.response),
      title: '',
    };
  }

  const all: Array<{ role: string; content: unknown }> = Array.isArray(q.messages)
    ? q.messages
    : Array.isArray(q.input)
      ? q.input.filter((m: any) => m && typeof m === 'object' && m.role)
      : [];
  // the desktop app's helper forks put their system prompt into the message list
  const msgs = all.filter((m) => m.role !== 'system');
  const sys = [systemText(q.system), ...all.filter((m) => m.role === 'system').map((m) => systemText(m.content))].join('\n');
  const raw: Block[] = [];
  for (const m of msgs) raw.push(...messageToBlocks(m.role, m.content));

  const ids = parseMetadataUserId(q.metadata);
  const rawText = raw.filter((b) => b.role === 'user').map((b) => b.text).join('\n');
  const lastAssistant = raw.map((b) => b.role).lastIndexOf('assistant');
  // Cursor chats from the Windows agent are always the person's own. Codex is the same unless the
  // rollout is a subagent thread (parent_thread_id), which the agent marks in the system prompt.
  const kind: RequestKind = j.client === 'cursor' || (j.client === 'codex' && !/You are a Codex subagent/i.test(sys))
    ? 'main'
    : j.client === 'codex'
      ? 'subagent'
      : classify({
    sys,
    userText: rawText,
    lastText: raw.slice(lastAssistant + 1).map((b) => b.text).join('\n'),
    toolNames: Array.isArray(q.tools) ? q.tools.map((t: any) => String(t?.name ?? t?.function?.name ?? '')) : [],
    maxTokens: typeof q.max_tokens === 'number' ? q.max_tokens : null,
    hasSession: !!ids.session,
  });
  const history = refineKinds(raw, kind === 'subagent' ? 'subagent' : 'main');
  // Classifier/title requests carry no Claude Code system prompt, so fall back to paths seen in the body.
  const home = HOME_RE.exec(sys)?.[1]?.trim() ?? HOME_RE.exec(rawText.slice(0, 200_000))?.[1]?.trim();

  const turn = firstTurn(history);
  const answer = history[turn.length];
  const id = identityOf(turn);
  return {
    ...base,
    kind,
    truncated: false,
    userHint: home ?? '',
    externalSessionId: ids.session ?? null,
    firstTurnHash: turnHash(id.length ? id : [{ role: 'user', text: row.id }]),
    rootHash: id.length && answer ? sha(turnHash(id) + '|' + blockHash(answer)).slice(0, 24) : null,
    continuation: turn.some((b) => b.meta?.tag === 'continuation-summary'),
    history,
    response: responseBlocks(j.response),
    title: titleFromBlocks(firstPrompt(history) ? [firstPrompt(history)!] : []),
  };
}

/** Content identity of a block. The kind is left out on purpose: it is a judgement that may improve later. */
export const blockHash = (b: Pick<Block, 'role' | 'text' | 'meta'>) => sha(`${b.role}|${b.text}|${JSON.stringify(b.meta?.name ?? '')}`).slice(0, 20);

export const turnHash = (blocks: Pick<Block, 'role' | 'text' | 'meta'>[]) => sha(blocks.map(blockHash).join(',')).slice(0, 24);
