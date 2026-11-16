import { describe, expect, it } from 'vitest';
import { messageToBlocks, splitUserText } from '../src/normalize/blocks.js';
import { parseMetadataUserId, parseRow } from '../src/normalize/record.js';
import { refineKinds } from '../src/normalize/turns.js';
import { cleanText, detectDir, fixMojibake, searchFold } from '../src/normalize/text.js';

const utf8AsLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

describe('text cleaning', () => {
  it('repairs Persian mojibake', () => {
    expect(fixMojibake(utf8AsLatin1('سلام دنیا'))).toBe('سلام دنیا');
  });
  it('leaves good Persian and English alone', () => {
    expect(fixMojibake('سلام hello')).toBe('سلام hello');
    expect(fixMojibake('café déjà vu')).toBe('café déjà vu');
  });
  it('decodes double-encoded unicode escapes only in pure-ascii text', () => {
    expect(cleanText('\\u0633\\u0644\\u0627\\u0645')).toBe('سلام');
    expect(cleanText('const a = "\\u00e9" + "é"')).toContain('\\u00e9');
  });
  it('normalises arabic letters but keeps digits and ZWNJ', () => {
    expect(cleanText('كتاب يك ۱۲۳ می‌خواهم')).toBe('کتاب یک ۱۲۳ می‌خواهم');
  });
  it('folds digits and ZWNJ for search', () => {
    expect(searchFold('می‌خواهم ۱۲۳ ABC')).toBe('میخواهم 123 abc');
  });
  it('detects direction', () => {
    expect(detectDir('چرا کامنتی نمیزاری')).toBe('rtl');
    expect(detectDir('why no comment')).toBe('ltr');
    expect(detectDir('123 چرا')).toBe('rtl');
  });
});

describe('user text splitting', () => {
  it('extracts slash commands', () => {
    const p = splitUserText('<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>15min /watch-prs</command-args>');
    expect(p).toEqual([expect.objectContaining({ kind: 'command', text: '/loop 15min /watch-prs' })]);
  });
  it('separates system reminders from the human text', () => {
    const p = splitUserText('<system-reminder>memory index</system-reminder>\nمیخوام یه وب اپ بسازم');
    expect(p.map((x) => x.kind)).toEqual(['system_reminder', 'human']);
    expect(p[1].text).toBe('میخوام یه وب اپ بسازم');
  });
  it('marks interrupts', () => {
    expect(splitUserText('[Request interrupted by user]')[0].kind).toBe('interrupt');
  });
  it('marks compaction summaries as system text', () => {
    const p = splitUserText('This session is being continued from a previous conversation that ran out of context. Summary: …');
    expect(p[0].kind).toBe('system_reminder');
  });
  it('captures local command output', () => {
    const p = splitUserText('<local-command-stdout>Compacted </local-command-stdout>');
    expect(p[0]).toMatchObject({ kind: 'local_output', text: 'Compacted' });
  });
});

describe('message blocks', () => {
  it('turns tool_use into a summary and tool_result into output', () => {
    const a = messageToBlocks('assistant', [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
    ]);
    expect(a.map((b) => b.kind)).toEqual(['assistant_text', 'tool_use']);
    expect(a[1].text).toBe('ls -la');
    expect(a[1].meta).toMatchObject({ name: 'Bash' });
    const u = messageToBlocks('user', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file.txt' }] }]);
    expect(u[0]).toMatchObject({ kind: 'tool_result', text: 'file.txt' });
  });
});

describe('metadata user id', () => {
  it('parses Claude Code format', () => {
    const r = parseMetadataUserId({ user_id: 'user_abc123_account_11111111-2222-3333-4444-555555555555_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(r).toEqual({ device: 'abc123', account: '11111111-2222-3333-4444-555555555555', session: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  });
  it('parses JSON format', () => {
    expect(parseMetadataUserId({ user_id: '{"device_id":"d1","account_uuid":"a1","session_id":"s1"}' })).toEqual({ device: 'd1', account: 'a1', session: 's1' });
  });
  it('tolerates missing', () => {
    expect(parseMetadataUserId(undefined)).toEqual({});
  });
});

const row = (data: object, over: Record<string, unknown> = {}) => ({
  id: '2026-10-26T12:00:00.000Z-abc',
  timestamp: '2026-10-26T12:00:00.000Z',
  provider: 'claude',
  model: 'claude-opus-5-5',
  connectionId: null,
  status: 'success',
  data: JSON.stringify(data),
  ...over,
});

describe('record parsing', () => {
  const main = {
    tokens: { prompt_tokens: 4, completion_tokens: 271, cache_read_input_tokens: 70000, cache_creation_input_tokens: 500 },
    latency: { ttft: 800, total: 5200 },
    request: {
      system: [{ type: 'text', text: 'You are Claude Code. Working directory: C:\\Users\\P.Sahebi.ABNOOSGASHT\\source\\repos\\HotelContract-Backend' }],
      tools: [{ name: 'Bash' }, { name: 'Agent' }],
      metadata: { user_id: 'user_dead01_account_aaaa_session_bbbb' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'چرا کامنتی روی پول رکوست نمیزاری؟' }] }],
    },
    response: { content: '[Empty streaming response]' },
  };

  it('extracts tokens, identity and session', () => {
    const r = parseRow(row(main))!;
    expect(r.tokens).toEqual({ input: 4, output: 271, cacheRead: 70000, cacheWrite: 500 });
    expect(r.userHint).toBe('P.Sahebi.ABNOOSGASHT');
    expect(r.externalSessionId).toBe('bbbb');
    expect(r.kind).toBe('main');
    expect(r.history[0]).toMatchObject({ kind: 'human', text: 'چرا کامنتی روی پول رکوست نمیزاری؟' });
    expect(r.response).toEqual([]); // placeholder is not a real answer
    expect(r.latencyMs).toBe(5200);
  });

  it('treats a Claude Code request without the Agent tool as a subagent, whose "user" is Claude', () => {
    const d = structuredClone(main) as any;
    d.request.tools = [{ name: 'Bash' }];
    const r = parseRow(row(d))!;
    expect(r.kind).toBe('subagent');
    expect(r.history[0].kind).toBe('agent_prompt');
  });

  it('reads the kind from the content when 9router dropped the system prompt', () => {
    const helper = (text: string, extra: object = {}) => parseRow(row({ tokens: {}, request: { messages: [{ role: 'user', content: [{ type: 'text', text }] }], ...extra } }))!.kind;
    expect(helper('<transcript>\n{"Bash":"ls"}\n</transcript>', { max_tokens: 2112 })).toBe('classifier');
    expect(helper('You are coming up with a succinct title and git branch name for a coding session')).toBe('title');
    expect(helper('Hi', { max_tokens: 1 })).toBe('other');
    expect(helper('سلام، یه سوال دارم')).toBe('main');
  });

  it('takes a Cursor chat from a Windows agent as the person\'s own chat, whatever it says', () => {
    const r = parseRow(row({ client: 'cursor', tokens: {}, request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize the conversation so far' }] }] } }))!;
    expect(r.kind).toBe('main');
  });

  it('marks client-injected text in a user turn as system text', () => {
    const r = parseRow(
      row({
        ...main,
        request: {
          ...main.request,
          messages: [
            { role: 'user', content: [{ type: 'text', text: '<command-message>review</command-message>\n<command-name>/review</command-name>' }, { type: 'text', text: '# Review the PR\nSteps…' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'Base directory for this skill: C:/x' }, { type: 'text', text: '<total_tokens>1 tokens left</total_tokens>' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }, { type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: 'stop, do X instead' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            { role: 'user', content: [{ type: 'text', text: "The user hasn't heard from you in a while. Keep them updated." }, { type: 'text', text: 'و حالا تست بنویس' }] },
          ],
        },
      }),
    )!;
    const kinds = r.history.filter((b) => b.role === 'user').map((b) => `${b.kind}${b.meta?.tag ? ':' + b.meta.tag : ''}`);
    expect(kinds).toEqual([
      'command',
      'system_reminder:command-body',
      'tool_result',
      'system_reminder:skill',
      'system_reminder:budget',
      'tool_result',
      'interrupt',
      'human',
      'system_reminder:nudge',
      'human',
    ]);
    expect(r.title).toBe('/review');
  });

  it('keeps a message the person queued while Claude worked', () => {
    const out = refineKinds(
      [
        { kind: 'tool_result', role: 'user', text: 'ok' },
        { kind: 'system_reminder', role: 'user', text: 'The user sent the following message:\nfix the test too' },
      ],
      'main',
    );
    expect(out[1].kind).toBe('human');
  });

  it('recognises the auto-mode classifier', () => {
    const d = {
      tokens: { prompt_tokens: 160, completion_tokens: 9 },
      request: {
        messages: [
          { role: 'user', content: '<transcript>\n{"user":"hi"}\n</transcript>\n\nErr on the side of blocking. Stage 1 does NOT apply user intent. Your ENTIRE response MUST begin with <block>.' },
        ],
      },
      response: { content: '<block>no' },
    };
    const r = parseRow(row(d))!;
    expect(r.kind).toBe('classifier');
    expect(r.response[0].text).toBe('<block>no');
  });

  it('handles truncated request bodies', () => {
    const r = parseRow(row({ tokens: { prompt_tokens: 9, completion_tokens: 1 }, request: { _truncated: true, _originalSize: 418971, _preview: '{"model":"claude"' } }))!;
    expect(r.truncated).toBe(true);
    expect(r.originalSize).toBe(418971);
    expect(r.tokens.input).toBe(9);
  });

  it('returns null for broken JSON', () => {
    expect(parseRow({ ...row({}), data: '{nope' })).toBeNull();
  });
});
