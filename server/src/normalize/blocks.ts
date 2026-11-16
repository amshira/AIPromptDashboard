import { cleanText } from './text.js';

// A normalised, UI-ready block. One 9router message becomes one or more blocks.
export type BlockKind =
  | 'human'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'command'
  | 'system_reminder'
  | 'local_output'
  | 'interrupt'
  | 'agent_prompt' // a subagent's task, written by Claude
  | 'image';

export interface Block {
  kind: BlockKind;
  role: 'user' | 'assistant';
  text: string; // cleaned text (for tool_use: a short one-line summary)
  meta?: Record<string, unknown>;
}

// No text is ever cut here: a prompt, answer or tool output of any size is kept whole (texts are stored once and
// compressed, see the texts table). The page shows a preview and loads the rest on demand.

const TAG_RE = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification|user-prompt-submit-hook)>([\s\S]*?)<\/\1>/g;

interface Piece {
  kind: BlockKind;
  text: string;
  meta?: Record<string, unknown>;
}

/** Split one user text into human text, reminders, slash commands and local output. */
export function splitUserText(raw: string): Piece[] {
  const text = cleanText(raw);
  const out: Piece[] = [];

  if (/^\s*\[Request interrupted by user[^\]]*\]\s*$/i.test(text)) {
    return [{ kind: 'interrupt', text: text.trim() }];
  }

  // Slash command envelope: <command-message/><command-name/><command-args/>
  const cmdName = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (cmdName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    out.push({ kind: 'command', text: `${cmdName}${args ? ' ' + args : ''}`, meta: { name: cmdName, args } });
  }

  let rest = text;
  const reminders: string[] = [];
  rest = rest.replace(TAG_RE, (_m, tag: string, body: string) => {
    if (tag === 'command-name' || tag === 'command-message' || tag === 'command-args') return '';
    if (tag === 'local-command-stdout' || tag === 'local-command-stderr') {
      out.push({ kind: 'local_output', text: body.trim() });
      return '';
    }
    if (tag === 'task-notification') {
      out.push({ kind: 'system_reminder', text: body.trim(), meta: { tag } });
      return '';
    }
    reminders.push(body.trim());
    return '';
  });
  for (const r of reminders) if (r) out.push({ kind: 'system_reminder', text: r });

  // Remaining text -> split on the "This session is being continued" summary header if present.
  const human = rest.trim();
  if (human) {
    if (/^This session is being continued from a previous conversation/i.test(human)) {
      out.push({ kind: 'system_reminder', text: human, meta: { tag: 'continuation-summary' } });
    } else {
      out.push({ kind: 'human', text: human });
    }
  }
  return out;
}

function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (o.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === 'string' && i[k]) return String(i[k]);
    return '';
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return pick('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep':
      return pick('pattern');
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'Skill':
      return pick('skill') + (pick('args') ? ' ' + pick('args') : '');
    case 'Agent':
      return pick('description', 'prompt');
    default:
      return JSON.stringify(input);
  }
}

/** Convert one Anthropic/OpenAI style message into blocks. */
export function messageToBlocks(role: string, content: unknown): Block[] {
  const r: 'user' | 'assistant' = role === 'assistant' ? 'assistant' : 'user';
  const blocks: Block[] = [];

  const pushText = (t: string) => {
    if (r === 'assistant') {
      const c = cleanText(t).trim();
      if (c) blocks.push({ kind: 'assistant_text', role: r, text: c });
    } else {
      for (const p of splitUserText(t)) blocks.push({ kind: p.kind, role: r, text: p.text, meta: p.meta });
    }
  };

  if (typeof content === 'string') {
    pushText(content);
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  for (const raw of content) {
    if (typeof raw === 'string') {
      pushText(raw);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        if (typeof b.text === 'string') pushText(b.text);
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking.trim())
          blocks.push({ kind: 'thinking', role: r, text: cleanText(b.thinking) });
        break;
      case 'tool_use': {
        const name = String(b.name ?? 'tool');
        blocks.push({
          kind: 'tool_use',
          role: r,
          text: cleanText(summarizeToolInput(name, b.input)),
          meta: { name, id: b.id },
        });
        break;
      }
      case 'tool_result': {
        const t = cleanText(stringifyResultContent(b.content));
        blocks.push({
          kind: 'tool_result',
          role: r,
          text: t,
          meta: { toolUseId: b.tool_use_id, isError: b.is_error === true },
        });
        break;
      }
      case 'image':
        blocks.push({ kind: 'image', role: r, text: '[image]' });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/** Heuristic title: the first typed line / slash command (or a subagent's task), max 60 chars. */
export function titleFromBlocks(blocks: Block[]): string {
  const pick = blocks.find((b) => b.kind === 'command' || b.kind === 'human' || b.kind === 'agent_prompt')?.text ?? '';
  const first = pick.split('\n').find((l) => l.trim()) ?? '';
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}
