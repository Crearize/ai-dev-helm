'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '../templates/hooks/context-handoff.cjs');

let root;
let store;
let transcript;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-'));
  store = path.join(root, 'store');
  fs.mkdirSync(path.join(root, 'projects', 'C--work-app'), { recursive: true });
  transcript = path.join(root, 'projects', 'C--work-app', 'sess-1.jsonl');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

let clock = Date.parse('2026-10-12T00:00:00Z');
function at() {
  clock += 60000;
  return new Date(clock).toISOString();
}

const human = (text) => ({ type: 'user', origin: { kind: 'human' }, timestamp: at(), cwd: 'C:\\work\\app', gitBranch: 'feat/x', message: { role: 'user', content: text } });
const assistant = (content, usage) => ({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content, ...(usage ? { usage } : {}) } });
const text = (value) => ({ type: 'text', text: value });
const tool = (name, input, id = `toolu_${name}_${clock}`) => ({ type: 'tool_use', id, name, input });

function writeTranscript(entries) {
  fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function run(input, { args = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [HOOK, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: 'C:\\work\\app', ...input }),
    encoding: 'utf8',
    env: { ...process.env, AI_DEV_HELM_HANDOFF_DIR: store, CLAUDE_PROJECT_DIR: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, json: result.stdout ? JSON.parse(result.stdout) : null };
}

const recordFile = () => path.join(store, 'C--work-app', 'sess-1.md');

function sampleTranscript() {
  writeTranscript([
    human('最初の指示: README を直してください'),
    assistant([text('README を直します。'), tool('Edit', { file_path: 'C:\\work\\app\\README.md' })]),
    { type: 'system', subtype: 'compact_boundary', timestamp: at() },
    { type: 'user', isCompactSummary: true, timestamp: at(), message: { role: 'user', content: 'Summary: 前半の要約' } },
    { type: 'user', origin: { kind: 'task-notification' }, timestamp: at(), message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    human('二つ目の指示<system-reminder>内部の注意</system-reminder>です'),
    assistant([tool('AskUserQuestion', { questions: [] }, 'toolu_ask')]),
    { type: 'user', timestamp: at(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'The user answered: "案は?"="A 案で". Read the answers carefully — they may request clarification.' }] } },
    assistant([tool('Bash', { command: 'git commit -m "fix readme"\necho done' }), tool('Bash', { command: 'ls -la' })]),
    { type: 'user', timestamp: at(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'listing' }] } },
    { type: 'pr-link', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12', timestamp: at() },
    { type: 'assistant', isSidechain: true, timestamp: at(), message: { content: [tool('Write', { file_path: 'C:\\side.md' })] } },
    assistant([text('最後の応答です。')], { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 }),
  ]);
}

describe('context-handoff record', () => {
  test('PreCompact saves human instructions newest first, answers, files, git and PRs, but not notifications or reminders', () => {
    // Break: counting task notifications or tool results as instructions buries what the user actually said.
    sampleTranscript();
    expect(run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'API を重点に' }).status).toBe(0);
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('/compact に付けた指示: API を重点に');
    expect(record).toContain('ブランチ: feat/x');
    const second = record.indexOf('> 二つ目の指示です');
    const first = record.indexOf('> 最初の指示: README を直してください');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(record).toContain('（質問への回答）');
    expect(record).toContain('The user answered: "案は?"="A 案で".');
    expect(record).not.toContain('Read the answers carefully');
    expect(record).not.toContain('task-notification');
    expect(record).not.toContain('内部の注意');
    expect(record).not.toContain('listing');
    expect(record).toContain('- C:\\work\\app\\README.md');
    expect(record).not.toContain('side.md');
    expect(record).toContain('git commit -m "fix readme"');
    expect(record).not.toContain('ls -la');
    expect(record).toContain('PR #12 https://github.com/o/r/pull/12');
    expect(record).toContain('## 直前のコンパクトの要約');
    expect(record).toContain('最後の応答です。');
  });

  test('SessionStart (compact) puts the key points back with the record path', () => {
    sampleTranscript();
    const result = run({ hook_event_name: 'SessionStart', source: 'compact' });
    expect(result.status).toBe(0);
    const context = result.json.hookSpecificOutput.additionalContext;
    expect(result.json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain(recordFile());
    expect(context).toContain('二つ目の指示です');
    expect(context).toContain('最後の応答です。');
    expect(context).not.toContain('前半の要約');
  });

  test('SessionStart (compact) keeps the trigger and /compact instructions that PreCompact saw', () => {
    // Break: the rebuild after compaction overwrote the record and lost what the user passed to /compact.
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'API を重点に' });
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('コンパクト（/compact）');
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('きっかけ: コンパクト（/compact）');
    expect(record).toContain('/compact に付けた指示: API を重点に');
    expect(fs.existsSync(recordFile().replace(/\.md$/, '.compact.json'))).toBe(false);
  });

  test('keeps the restored context under the 10,000-character limit with many long instructions', () => {
    // Break: Claude Code moves additionalContext over 10,000 characters into a file and keeps only 2,000.
    const entries = [];
    for (let i = 0; i < 200; i += 1) entries.push(human(`指示 ${i} ${'あ'.repeat(3000)}`), assistant([text('了解'.repeat(2000))]));
    writeTranscript(entries);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThanOrEqual(9000);
    expect(context).toContain('指示 199');
    expect(context).toMatch(/ほか \d+ 件は記録の全文にあります。/);
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('指示 0 ');
  });

  test('SessionStart (startup / resume) does nothing', () => {
    sampleTranscript();
    for (const source of ['startup', 'resume']) {
      const result = run({ hook_event_name: 'SessionStart', source });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(fs.existsSync(recordFile())).toBe(false);
  });
});

describe('context-handoff /clear', () => {
  test('SessionEnd (clear) leaves a marker that the next SessionStart (clear) uses once', () => {
    sampleTranscript();
    expect(run({ hook_event_name: 'SessionEnd', reason: 'clear' }).status).toBe(0);
    expect(fs.existsSync(recordFile())).toBe(true);
    const next = run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2', transcript_path: path.join(root, 'projects', 'C--work-app', 'sess-2.jsonl') });
    const context = next.json.hookSpecificOutput.additionalContext;
    expect(context).toContain('/clear');
    expect(context).toContain('二つ目の指示です');
    expect(fs.readdirSync(path.join(store, 'clear-markers'))).toEqual([]);
  }, 20000);

  test('ignores a marker older than 120 seconds, a marker of another project and the same session', () => {
    sampleTranscript();
    run({ hook_event_name: 'SessionEnd', reason: 'clear' });
    const markers = path.join(store, 'clear-markers');
    const [name] = fs.readdirSync(markers);
    const marker = JSON.parse(fs.readFileSync(path.join(markers, name), 'utf8'));
    fs.writeFileSync(path.join(markers, name), JSON.stringify({ ...marker, at: Date.now() - 121000 }));
    expect(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2' }).stdout).toBe('');
    fs.writeFileSync(path.join(markers, name), JSON.stringify({ ...marker, at: Date.now() }));
    const otherProject = path.join(root, 'projects', 'C--other', 'sess-2.jsonl');
    expect(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2', transcript_path: otherProject }).stdout).toBe('');
    expect(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-1' }).stdout).toBe('');
  }, 30000);

  test('hands over when the conversation moved to another directory (a worktree) before /clear', () => {
    // Break: keying the marker by cwd lost the handover whenever the session had moved into a worktree.
    sampleTranscript();
    run({ hook_event_name: 'SessionEnd', reason: 'clear', cwd: 'C:\\work\\app\\.worktrees\\feat' });
    const next = run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2', cwd: 'C:\\work\\app' });
    expect(next.json.hookSpecificOutput.additionalContext).toContain('二つ目の指示です');
  }, 20000);

  test('SessionEnd for other reasons saves nothing', () => {
    sampleTranscript();
    expect(run({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }).status).toBe(0);
    expect(fs.existsSync(store)).toBe(false);
  });
});

describe('context-handoff Stop notice', () => {
  const usage = (tokens) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens });
  const withContext = (tokens) => writeTranscript([human('作業'), assistant([text('応答')], usage(tokens))]);
  const stop = (env) => run({ hook_event_name: 'Stop', stop_hook_active: false }, { env });

  test('tells the user once when crossing the threshold and again per 100,000 tokens', () => {
    // Break: a notice on every turn would be noise; none at all would leave the session growing unseen.
    withContext(299999);
    expect(stop().stdout).toBe('');
    withContext(320000);
    expect(stop().json.systemMessage).toContain('約 32 万トークン');
    withContext(390000);
    expect(stop().stdout).toBe('');
    withContext(410000);
    expect(stop().json.systemMessage).toContain('/clear');
  });

  test('counts again after the context drops below the threshold, and follows the configured threshold', () => {
    withContext(320000);
    expect(stop().stdout).not.toBe('');
    withContext(20000);
    expect(stop().stdout).toBe('');
    withContext(320000);
    expect(stop().stdout).not.toBe('');
    withContext(150000);
    expect(stop({ AI_DEV_HELM_CONTEXT_NOTICE_TOKENS: '100000' }).json.systemMessage).toContain('約 15 万トークン');
    withContext(900000);
    expect(stop({ AI_DEV_HELM_CONTEXT_NOTICE_TOKENS: '0' }).stdout).toBe('');
  });

  test('reads the main conversation usage, not a subagent line', () => {
    writeTranscript([human('作業'), assistant([text('応答')], usage(10000)), { type: 'assistant', isSidechain: true, message: { content: [], usage: usage(900000) } }]);
    expect(stop().stdout).toBe('');
  });
});

describe('context-handoff safety', () => {
  test('exits 0 on broken input, a missing transcript and unknown events', () => {
    // Break: exit 2 on PreCompact stops compaction, and on Stop keeps the turn going.
    expect(run('not json').status).toBe(0);
    expect(run({ hook_event_name: 'PreCompact', transcript_path: path.join(root, 'missing.jsonl') }).status).toBe(0);
    expect(run({ hook_event_name: 'Stop', transcript_path: path.join(root, 'missing.jsonl') }).status).toBe(0);
    expect(run({ hook_event_name: 'UserPromptSubmit' }).status).toBe(0);
    fs.writeFileSync(transcript, '{"type":"user", broken\n');
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }).status).toBe(0);
  });

  test('the global copy does nothing when the project registers its own copy', () => {
    // Break: both copies running would save twice and restore the record twice.
    sampleTranscript();
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(project, '.claude', 'hooks', 'context-handoff.cjs'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node .claude/hooks/context-handoff.cjs' }] }] } }));
    const env = { CLAUDE_PROJECT_DIR: project };
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, { args: ['--scope=global'], env }).stdout).toBe('');
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, { env }).stdout).not.toBe('');
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}');
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, { args: ['--scope=global'], env }).stdout).not.toBe('');
  });
});

// Cycle 1 findings of the quality-check (#207).
describe('context-handoff edge cases', () => {
  const lone = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

  test('never cuts a surrogate pair, at the 800-character line, the reply and the whole context', () => {
    // Break: a lone surrogate in additionalContext can make the API reject every request after compaction.
    const entries = [];
    for (let i = 0; i < 60; i += 1) entries.push(human(`${'あ'.repeat(799 - String(i).length)}${i}😀${'い'.repeat(50)}`));
    entries.push(assistant([text(`${'う'.repeat(1499)}😀${'え'.repeat(100)}`)]));
    writeTranscript(entries);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(lone(context)).toBe(false);
    expect(lone(fs.readFileSync(recordFile(), 'utf8'))).toBe(false);
    const { cut } = require('../templates/hooks/context-handoff.cjs');
    expect(cut('ab😀', 3)).toBe('ab');
    expect(cut('ab😀', 4)).toBe('ab😀');
  });

  test('keeps an instruction that quotes <command-name> tags, and still reads a real slash command', () => {
    // Break: an instruction with a pasted transcript fragment was replaced by the command name and lost.
    writeTranscript([
      human('パーサーを直して <command-name>/mcp</command-name> の部分は触らないでください'),
      human('<command-name>/code-review</command-name>\n<command-message>code-review</command-message>\n<command-args>high</command-args>'),
    ]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('> パーサーを直して <command-name>/mcp</command-name> の部分は触らないでください');
    expect(record).toContain('> /code-review high');
  });

  test('keeps files inside the store for "." and ".." folder names and session ids', () => {
    // Break: ".." escaped the store, wrote outside it and let pruning delete old files there.
    writeTranscript([human('作業')]);
    const victim = path.join(root, 'victim-old.md');
    fs.writeFileSync(victim, 'keep');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(victim, old, old);
    // Built by hand: path.join would resolve the "..".
    const escape = `${path.join(root, 'projects', 'C--work-app')}${path.sep}..${path.sep}sess-1.jsonl`;
    fs.copyFileSync(transcript, path.join(root, 'projects', 'sess-1.jsonl'));
    for (const input of [{ transcript_path: escape }, { session_id: '..' }, { session_id: '.' }]) {
      expect(run({ hook_event_name: 'PreCompact', trigger: 'auto', ...input }).status).toBe(0);
    }
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.md') || name.endsWith('.compact.json'))).toEqual(['victim-old.md']);
    expect(fs.existsSync(path.join(store, 'unknown'))).toBe(true);
  });

  test('prunes only its own old files, once a day, across project folders', () => {
    writeTranscript([human('作業')]);
    const other = path.join(store, 'C--old-project');
    fs.mkdirSync(other, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const id = '0d187efb-de3b-4d9b-877c-19f2262e7dd4';
    for (const name of [`${id}.md`, `${id}.notice.json`, `${id}.compact.json`, 'unknown.md', 'notes.md', 'keep.txt']) {
      fs.writeFileSync(path.join(other, name), 'x');
      fs.utimesSync(path.join(other, name), old, old);
    }
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    // Only this hook's own names (session ids and "unknown") go; a user's notes.md stays.
    expect(fs.readdirSync(other).sort()).toEqual(['keep.txt', 'notes.md']);
    const later = '4a56f6ef-c9bb-4d37-8064-0c8334296266.md';
    fs.writeFileSync(path.join(other, later), 'x');
    fs.utimesSync(path.join(other, later), old, old);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.readdirSync(other)).toContain(later);
  });

  test('replaces secrets in the record and the restored context', () => {
    // Break: a pasted token came back verbatim after /clear and stayed on disk for 30 days.
    writeTranscript([
      human('このキーを使って ghp_abcdefghijklmnopqrstuvwxyz0123456789 と sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV を設定'),
      assistant([tool('Bash', { command: 'git push https://user:s3cret@github.com/o/r.git HEAD' })]),
    ]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    const record = fs.readFileSync(recordFile(), 'utf8');
    for (const out of [context, record]) {
      expect(out).not.toMatch(/ghp_abcdef|sk-ant-api03|s3cret/);
      expect(out).toContain('[REDACTED]');
    }
    expect(record).toContain('git push https://[REDACTED]@github.com/o/r.git HEAD');
  });

  test('AI_DEV_HELM_HANDOFF=off turns everything off', () => {
    sampleTranscript();
    const env = { AI_DEV_HELM_HANDOFF: 'off' };
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, { env }).stdout).toBe('');
    expect(run({ hook_event_name: 'SessionEnd', reason: 'clear' }, { env }).status).toBe(0);
    expect(fs.existsSync(store)).toBe(false);
  });

  test('skips interrupted or failed answers and merges a repeated git command', () => {
    writeTranscript([
      human('始めます'),
      assistant([tool('AskUserQuestion', {}, 'toolu_q1'), tool('AskUserQuestion', {}, 'toolu_q2')]),
      { type: 'user', timestamp: at(), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_q1', content: '[Tool call interrupted: the session ended]' },
        { type: 'tool_result', tool_use_id: 'toolu_q2', is_error: true, content: 'The user answered: "x"="y"' },
      ] } },
      assistant([tool('Bash', { command: 'git push origin feat' })]),
      assistant([tool('Bash', { command: 'git push origin feat' })]),
      assistant([tool('Bash', { command: 'git commit -m x' })]),
      assistant([tool('Bash', { command: 'git push origin feat' })]),
    ]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).not.toContain('（質問への回答）');
    expect(record.match(/`git push origin feat`/g)).toHaveLength(2);
    expect(record).toContain('PR と git の操作（新しい順・3 件）');
  });

  test('reads a transcript without origin fields (older Claude Code)', () => {
    writeTranscript([
      { type: 'user', timestamp: at(), message: { role: 'user', content: '古い形式の指示' } },
      { type: 'user', timestamp: at(), message: { role: 'user', content: '<task-notification>done</task-notification>' } },
      { type: 'user', timestamp: at(), message: { role: 'user', content: 'Caveat: The messages below were generated' } },
      { type: 'user', isMeta: true, timestamp: at(), message: { role: 'user', content: 'メタの行' } },
      { type: 'user', timestamp: at(), message: { role: 'user', content: '[Request interrupted by user]' } },
    ]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('原文・新しい順・1 件');
    expect(record).toContain('> 古い形式の指示');
  });

  test('uses the saved /compact trigger only while it is fresh', () => {
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '古い指示' });
    const trigger = recordFile().replace(/\.md$/, '.compact.json');
    const saved = JSON.parse(fs.readFileSync(trigger, 'utf8'));
    fs.writeFileSync(trigger, JSON.stringify({ ...saved, at: Date.now() - 31 * 60 * 1000 }));
    run({ hook_event_name: 'SessionStart', source: 'compact' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('きっかけ: コンパクト\n');
    expect(record).not.toContain('古い指示');
  });

  test('the newest instruction always goes in, even when the other sections fill the budget', () => {
    // Break: long file paths and commands pushed even the newest instruction into "ほか N 件".
    const entries = [human(`最新の指示 ${'お'.repeat(3000)}`)];
    for (let i = 0; i < 20; i += 1) entries.push(assistant([tool('Write', { file_path: `C:\\${'d'.repeat(190)}\\f${i}.md` })]));
    for (let i = 0; i < 10; i += 1) entries.push(assistant([tool('Bash', { command: `git commit -m "${'m'.repeat(280)}${i}"` })]));
    entries.push(assistant([text('応'.repeat(3000))]));
    writeTranscript(entries);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('最新の指示');
    // The budget, not the final cut, keeps it under the limit: the later sections are all still there.
    expect(context).toContain('## PR と git の操作（新しい順）');
    expect(context.endsWith('…')).toBe(false);
    expect(context.length).toBeLessThanOrEqual(9000);
  });

  test('the newest instruction goes in also when the newest entry is an answer', () => {
    // Break: only the newest entry was kept, so an answer right after a question pushed the instruction out.
    const entries = [human(`最新の指示 ${'お'.repeat(900)}`)];
    for (let i = 0; i < 20; i += 1) entries.push(assistant([tool('Write', { file_path: `C:\\${'d'.repeat(190)}\\f${i}.md` })]));
    for (let i = 0; i < 10; i += 1) entries.push(assistant([tool('Bash', { command: `git commit -m "${'m'.repeat(280)}${i}"` })]));
    entries.push(assistant([text('応'.repeat(3000)), tool('AskUserQuestion', {}, 'toolu_last')]));
    entries.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_last', content: `The user answered: "q"="${'か'.repeat(700)}"` }] } });
    writeTranscript(entries);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('最新の指示');
    expect(context.length).toBeLessThanOrEqual(9000);
  });

  test('the global copy also defers to a registration in settings.local.json', () => {
    sampleTranscript();
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(project, '.claude', 'hooks', 'context-handoff.cjs'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node .claude/hooks/context-handoff.cjs' }] }] } }));
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, { args: ['--scope=global'], env: { CLAUDE_PROJECT_DIR: project } }).stdout).toBe('');
  });
});

describe('context-handoff Stop notice edges', () => {
  const usage = (tokens) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens });
  const stop = () => run({ hook_event_name: 'Stop', stop_hook_active: false });

  test('notices only above the threshold (300,000 is not above it)', () => {
    writeTranscript([human('作業'), assistant([text('応答')], usage(300000))]);
    expect(stop().stdout).toBe('');
    writeTranscript([human('作業'), assistant([text('応答')], usage(300001))]);
    expect(stop().json.systemMessage).toContain('約 30 万トークン');
  });

  test('a <synthetic> zero-usage line or no usage in the tail changes nothing', () => {
    // Break: reading an API-error line as 0 reset the count, so the same notice came twice.
    writeTranscript([human('作業'), assistant([text('応答')], usage(320000))]);
    expect(stop().stdout).not.toBe('');
    writeTranscript([
      human('作業'), assistant([text('応答')], usage(320000)),
      { type: 'assistant', timestamp: at(), message: { model: '<synthetic>', content: [text('API Error')], usage: usage(0) } },
    ]);
    expect(stop().stdout).toBe('');
    writeTranscript([human('作業'), assistant([text('応答')], usage(321000))]);
    expect(stop().stdout).toBe('');
    writeTranscript([human('作業')]);
    expect(stop().stdout).toBe('');
    writeTranscript([human('作業'), assistant([text('応答')], usage(322000))]);
    expect(stop().stdout).toBe('');
  });
});

// Cycle 2 findings of the quality-check (#207).
describe('context-handoff redaction', () => {
  const { redact } = require('../templates/hooks/context-handoff.cjs');

  test('stays linear on long runs that the URL rule could backtrack on', () => {
    // Break: an unbounded scheme made 100,000 characters of "a." take seconds and timed out large transcripts.
    for (const unit of ['a.', 'ab-', 'sk-', 'a+']) {
      const input = unit.repeat(Math.ceil(1000000 / unit.length));
      const start = Date.now();
      redact(input);
      expect(Date.now() - start).toBeLessThan(2000);
    }
  });

  test('replaces the whole password of a URL, and leaves URLs without one alone', () => {
    expect(redact('https://user:p@ss@github.com/o/r')).toBe('https://[REDACTED]@github.com/o/r');
    expect(redact('git push https://x-access-token:ghs_abc@github.com/o/r.git')).toBe('git push https://[REDACTED]@github.com/o/r.git');
    expect(redact('http://localhost:3000?mail=a@b.com')).toBe('http://localhost:3000?mail=a@b.com');
    expect(redact('説明https://example.comを参照、ユーザー:パス@ホスト')).toBe('説明https://example.comを参照、ユーザー:パス@ホスト');
  });

  test('replaces the known token shapes and keeps look-alike names', () => {
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'glpat-abcdefghijklmnopqrstuvwx',
      'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      `sk-${'A1'.repeat(24)}`,
      'sk_live_ABCDEFGHIJKLMNOP1234',
      'AKIAABCDEFGHIJKLMNOP',
      'npm_abcdefghijklmnopqrstuvwxyz012345',
      'xoxb-1234567890-abcdefghij',
      `AIza${'B'.repeat(35)}`,
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const secret of secrets) expect(redact(`値は ${secret} です`)).toBe('値は [REDACTED] です');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123')).toBe('Authorization: Bearer [REDACTED]');
    for (const name of ['git push origin sk-feature-improve-redaction-logic', 'ghp_short', 'AKIA-not-a-key']) expect(redact(name)).toBe(name);
  });

  test('the /compact instructions are redacted in the trigger file too', () => {
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'トークン ghp_abcdefghijklmnopqrstuvwxyz0123456789 を使う' });
    const trigger = fs.readFileSync(recordFile().replace(/\.md$/, '.compact.json'), 'utf8');
    expect(trigger).not.toContain('ghp_abcdef');
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toContain('ghp_abcdef');
  });
});

describe('context-handoff store', () => {
  test('keeps records no longer than cleanupPeriodDays when it is shorter than 30 days', () => {
    // Break: records outlived the transcripts that Claude Code itself already deleted.
    writeTranscript([human('作業')]);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const env = { HOME: home, USERPROFILE: home };
    const other = path.join(store, 'C--old');
    fs.mkdirSync(other, { recursive: true });
    const file = path.join(other, '0d187efb-de3b-4d9b-877c-19f2262e7dd4.md');
    const tenDays = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, tenDays, tenDays);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' }, { env });
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(path.join(store, '.last-prune'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 5 }));
    run({ hook_event_name: 'PreCompact', trigger: 'auto' }, { env });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('one unreadable entry does not stop pruning the others', () => {
    writeTranscript([human('作業')]);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const a = path.join(store, 'C--a');
    const b = path.join(store, 'C--b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    // A dangling link with a record's name: stat() throws ENOENT on it.
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(a, '0d187efb-de3b-4d9b-877c-19f2262e7dd4.md'), 'junction');
    for (const dir of [a, b]) {
      const file = path.join(dir, '4a56f6ef-c9bb-4d37-8064-0c8334296266.md');
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, old, old);
    }
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.existsSync(path.join(a, '4a56f6ef-c9bb-4d37-8064-0c8334296266.md'))).toBe(false);
    expect(fs.existsSync(path.join(b, '4a56f6ef-c9bb-4d37-8064-0c8334296266.md'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('writes the record readable by the user only', () => {
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.statSync(recordFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(recordFile())).mode & 0o777).toBe(0o700);
  });

  test('a <synthetic> line with non-zero usage is skipped as well', () => {
    const usage = (tokens) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens });
    writeTranscript([human('作業'), assistant([text('応答')], usage(10000)), { type: 'assistant', timestamp: at(), message: { model: '<synthetic>', content: [], usage: usage(900000) } }]);
    expect(run({ hook_event_name: 'Stop' }).stdout).toBe('');
  });
});

// Cycle 3 findings of the quality-check (#207).
describe('context-handoff capping and redaction together', () => {
  const pem = (body) => `-----BEGIN RSA PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;

  test('a key block cut by the cap leaves no key text in the record', () => {
    // Break: capping at max + 512 before redacting cut off the END line, so the key body stayed in the record.
    writeTranscript([
      human(`${'あ'.repeat(18500)}\n${pem('Q'.repeat(3200))}\n続き`),
      assistant([text(`${'う'.repeat(3000)}\n${pem('Z'.repeat(1700))}`)]),
    ]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(record).not.toMatch(/Q{20}|Z{20}/);
  });

  test('a password cut at the cap is dropped, also when earlier secrets shrank', () => {
    // Break: redaction shortened the text after the early cut, pulling half of a URL password inside the limit.
    const pats = Array.from({ length: 40 }, (_, i) => `github_pat_${String(i).padStart(2, '0')}${'A'.repeat(78)}`).join(' ');
    const before = `${pats} ${'あ'.repeat(19980 - pats.length - 1)} `;
    writeTranscript([human(`${before}https://admin:SuperSecretPassw0rd@db.example.com/x 以降`)]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).not.toMatch(/admin:Sup|SuperSecret|github_pat_\d/);
  });

  test('the omitted count is taken from the original length', () => {
    // Break: the early cut made a 100,000-character instruction read "512 文字省略".
    writeTranscript([human('あ'.repeat(100000)), assistant([text('い'.repeat(9000))])]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('…（80000 文字省略）');
    expect(record).toContain('…（96000 文字省略）');
    expect(record).toContain('…（5000 文字省略）');
  });

  test('a one-million-character instruction is handled quickly', () => {
    writeTranscript([human(`${'a.'.repeat(250000)}${'ab-'.repeat(170000)}`)]);
    const start = Date.now();
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }).status).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('picks the newest of several instructions, not the oldest, and counts the rest exactly', () => {
    // Break: choosing the oldest instruction as the one that must go in passed every earlier test.
    const entries = [human(`OLD-MARK ${'お'.repeat(900)}`), human(`NEW-MARK ${'に'.repeat(900)}`)];
    for (let i = 0; i < 20; i += 1) entries.push(assistant([tool('Write', { file_path: `C:\\${'d'.repeat(190)}\\f${i}.md` })]));
    for (let i = 0; i < 10; i += 1) entries.push(assistant([tool('Bash', { command: `git commit -m "${'m'.repeat(280)}${i}"` })]));
    entries.push(assistant([text('応'.repeat(3000)), tool('AskUserQuestion', {}, 'toolu_last')]));
    entries.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_last', content: `The user answered: "q"="${'か'.repeat(700)}"` }] } });
    writeTranscript(entries);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('NEW-MARK');
    expect(context).not.toContain('OLD-MARK');
    const shown = context.includes('（質問への回答）') ? 2 : 1;
    expect(context).toContain(`- ほか ${3 - shown} 件は記録の全文にあります。`);
  });
});

describe('context-handoff pruning failures', () => {
  test('a file that cannot be deleted does not stop pruning the others', () => {
    // Break: one try around the whole loop stopped at the first failing file, every day.
    writeTranscript([human('作業')]);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    // Both files in one folder, and the first unlink call fails whichever file readdir returns first: this catches a
    // try around the whole loop and a try around each folder alike, on any file system order.
    const a = path.join(store, 'C--a');
    fs.mkdirSync(a, { recursive: true });
    const files = ['0d187efb-de3b-4d9b-877c-19f2262e7dd4.md', '4a56f6ef-c9bb-4d37-8064-0c8334296266.md'].map((name) => path.join(a, name));
    for (const file of files) {
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, old, old);
    }
    // Node deletes read-only files on Windows, so the failure is made in-process.
    const { prune } = require('../templates/hooks/context-handoff.cjs');
    const saved = process.env.AI_DEV_HELM_HANDOFF_DIR;
    process.env.AI_DEV_HELM_HANDOFF_DIR = store;
    const realUnlink = fs.unlinkSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).endsWith('.md')) calls += 1;
      if (calls === 1 && String(file).endsWith('.md')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return realUnlink(file);
    });
    try {
      prune();
      expect(files.filter((file) => fs.existsSync(file))).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.AI_DEV_HELM_HANDOFF_DIR;
      else process.env.AI_DEV_HELM_HANDOFF_DIR = saved;
    }
  });

  test('keeps a file that only contains a session id in its name', () => {
    writeTranscript([human('作業')]);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const dir = path.join(store, 'C--c');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'backup-0d187efb-de3b-4d9b-877c-19f2262e7dd4.md';
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), old, old);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.readdirSync(dir)).toEqual([name]);
  });
});

describe('context-handoff more secret shapes', () => {
  const { redact } = require('../templates/hooks/context-handoff.cjs');

  test('covers an empty URL user, lowercase bearer, PGP keys and temporary AWS keys', () => {
    expect(redact('redis://:hunter2pass@cache:6379')).toBe('redis://[REDACTED]@cache:6379');
    expect(redact('authorization: bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('authorization: bearer [REDACTED]');
    expect(redact('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----')).toBe('[REDACTED]');
    expect(redact('ASIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]');
  });

  test('Bearer does not reach across a line break', () => {
    expect(redact('Bearer\nsrc/lib/context-handoff.test.js')).toBe('Bearer\nsrc/lib/context-handoff.test.js');
  });
});

// Cycle 4 findings of the quality-check (#207).
describe('context-handoff counts and redaction on every rendering path', () => {
  const pem = (body) => `-----BEGIN RSA PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;

  test('the restored context redacts the reply as well', () => {
    // Break: rendering the raw reply text without capture() passed every test before.
    writeTranscript([human('作業'), assistant([text('トークンは ghp_abcdefghijklmnopqrstuvwxyz0123456789 です')])]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('トークンは [REDACTED] です');
    expect(context).not.toContain('ghp_abcdef');
  });

  test('a one-line rendering counts what it left out of the original, not the whitespace it collapsed (3.7.0)', () => {
    // Break: the count was the original length minus the collapsed text, so whitespace read as omitted text.
    const spaced = (n) => ('x' + ' '.repeat(9)).repeat(n);
    writeTranscript([human(spaced(200))]);
    let context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('x x x');
    expect(context).not.toMatch(/x …（\d+ 文字省略）/);
    writeTranscript([human(spaced(1000))]);
    context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    // The prompt is captured without its trailing 9 spaces (9,991 characters); the 800 shown
    // characters ("x " x 400) stand for its first 3,992, so 5,999 are left out (the old count said 9,191).
    expect(context).toContain('…（5999 文字省略）');
  });

  test('counts a reply in several blocks from its full length, in the record and the context', () => {
    // Break: dropping the total (or the "\n\n" between blocks) from the count was not caught.
    writeTranscript([human('作業'), assistant([text('い'.repeat(3000)), text('う'.repeat(3000)), text('え'.repeat(3000))])]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('…（7504 文字省略）');
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('…（5004 文字省略）');
  });

  test('the /compact instructions keep their omitted count through SessionStart', () => {
    // Break: the instructions were cleaned twice, so the record said "12 文字省略" instead of "3000 文字省略".
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: `${'あ'.repeat(4990)}abcdefghij` });
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('…（3000 文字省略）');
    run({ hook_event_name: 'SessionStart', source: 'compact' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('…（3000 文字省略）');
    expect(record.match(/文字省/g).length).toBe(1);
  });

  test('the restored context counts an instruction from its original length', () => {
    // Break: the context re-cut the 20,000-character record text and said "19200 文字省略".
    writeTranscript([human('あ'.repeat(100000))]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('…（99200 文字省略）');
  });

  test('drops at most 200 trailing ASCII characters at the cap and counts them as omitted', () => {
    writeTranscript([human('x'.repeat(20001))]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain(`> ${'x'.repeat(19800)}…（201 文字省略）`);
  });

  test('a key pasted without its END line is redacted also under the cap, and a bare header stays', () => {
    // Break: an unterminated key under 20,000 characters stayed whole; one character more removed it.
    const body = pem('Q'.repeat(1700)).replace(/\n-----END[\s\S]*$/, '');
    writeTranscript([human(`鍵です\n${body}`), human('-----BEGIN RSA PRIVATE KEY----- という見出しの話です')]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).not.toMatch(/Q{20}/);
    expect(record).toContain('-----BEGIN RSA PRIVATE KEY----- という見出しの話です');
  });

  test('caps before redacting, so a quadratic-prone paste stays fast', () => {
    // Break: redacting before the cap made a 2-million-character run of key headers take minutes.
    writeTranscript([human('-----BEGIN RSA PRIVATE KEY-----'.repeat(65000))]);
    const start = Date.now();
    expect(run({ hook_event_name: 'PreCompact', trigger: 'auto' }).status).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('a long answer with many spaces is handled fast', () => {
    // Break: the old answer regex went quadratic on whitespace (100,000 spaces took about 2 seconds).
    writeTranscript([
      human('始めます'),
      assistant([tool('AskUserQuestion', {}, 'toolu_ws')]),
      { type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ws', content: `The user answered: "q"="a${' '.repeat(400000)}b"` }] } },
    ]);
    const start = Date.now();
    expect(run({ hook_event_name: 'PreCompact', trigger: 'auto' }).status).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('many unclosed reminder tags are handled fast and closed ones removed', () => {
    writeTranscript([human(`前<system-reminder>消す</system-reminder>後${'<system-reminder>'.repeat(60000)}`)]);
    const start = Date.now();
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(Date.now() - start).toBeLessThan(5000);
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain('> 前後');
    expect(record).not.toContain('消す');
  });
});

describe('context-handoff Bearer separators', () => {
  const { redact } = require('../templates/hooks/context-handoff.cjs');

  test('any case, and spaces such as NBSP, but not a line break', () => {
    expect(redact('BEARER abcdefghijklmnopqrstuvwxyz0123')).toBe('BEARER [REDACTED]');
    expect(redact('Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Bearer [REDACTED]');
    expect(redact('Bearer\r\nabcdefghijklmnopqrstuvwxyz0123')).toBe('Bearer\r\nabcdefghijklmnopqrstuvwxyz0123');
  });
});

// Cycle 5 findings of the quality-check (#207).
describe('context-handoff unterminated keys', () => {
  const { redact } = require('../templates/hooks/context-handoff.cjs');
  const data = 'MIIEowIBAAKCAQEAx7vQ9kLmN3pQrStUvWxYz0123456789abcdefghijklmnopqrs';

  test.each([
    ['LF', `-----BEGIN RSA PRIVATE KEY-----\n${data}\n${data}`],
    ['CRLF', `-----BEGIN RSA PRIVATE KEY-----\r\n${data}\r\n${data}`],
    ['PGP armor with a blank line', `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${data}\n=abcd`],
    ['PGP armor with a Version line', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n${data}`],
    ['encrypted PEM', `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n${data}`],
    ['JSON with \\n', `"private_key": "-----BEGIN PRIVATE KEY-----\\n${data}\\n${data}\\n"`],
    ['trailing spaces after the header', `-----BEGIN RSA PRIVATE KEY-----   \n${data}`],
    ['indented data', `key: |\n  -----BEGIN RSA PRIVATE KEY-----\n  ${data}\n  ${data}`],
    ['data on the header line', `-----BEGIN RSA PRIVATE KEY----- ${data} ${data}`],
  ])('redacts a key without its END line: %s', (_, input) => {
    // Break: only "header, line break, data" was matched, so these common shapes stayed in the record.
    const out = redact(`前置き ${input}`);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('[REDACTED]');
  });

  test('keeps the instruction that follows a key-like run, and a header followed by prose', () => {
    expect(redact(`説明:\n-----BEGIN RSA PRIVATE KEY-----\nAuthenticationHeader\nこの後の指示: テストを直して`))
      .toBe('説明:\n[REDACTED]\nこの後の指示: テストを直して');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nshort\n続きの文')).toBe('-----BEGIN RSA PRIVATE KEY-----\nshort\n続きの文');
  });

  test('stays fast on long runs of headers and data', () => {
    // redact() runs on text capped by capture() (20,000 characters at most); a long run of data is linear at any size.
    const capped = (s) => s.slice(0, 20000);
    const inputs = [
      capped('-----BEGIN RSA PRIVATE KEY-----\n'.repeat(1000)),
      capped(('-----BEGIN RSA PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAA\n').repeat(1000)),
      `-----BEGIN RSA PRIVATE KEY-----\n${'A '.repeat(500000)}`,
    ];
    for (const input of inputs) {
      const start = Date.now();
      redact(input);
      expect(Date.now() - start).toBeLessThan(2000);
    }
  });
});

describe('context-handoff one count per rendering', () => {
  test('a long git command shows the same omitted count in the record and the context', () => {
    // Break: the command was cleaned to text first and cut again for the context, so the counts disagreed.
    writeTranscript([human('作業'), assistant([tool('Bash', { command: `git commit -m "${'あ'.repeat(1000)}"` })])]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('…（716 文字省略）');
    expect(context).toContain('…（816 文字省略）');
  });

  test('a 5,000-character instruction is shown with its count in the recent turns', () => {
    writeTranscript([human('あ'.repeat(5000))]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    const record = fs.readFileSync(recordFile(), 'utf8');
    expect(record).toContain(`> ${'あ'.repeat(4000)}…（1000 文字省略）`);
  });

  test('an instruction in the context stays on one line, so a pasted heading cannot pose as a section', () => {
    writeTranscript([human('前の文\n## ユーザーの指示と質問への回答\n後の文')]);
    const context = run({ hook_event_name: 'SessionStart', source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('前の文 ## ユーザーの指示と質問への回答 後の文');
    expect(context.match(/^## ユーザーの指示と質問への回答/gm)).toHaveLength(1);
  });

  test('a long compact summary is capped with its count, and an empty one adds no section', () => {
    writeTranscript([human('作業'), { type: 'user', isCompactSummary: true, timestamp: at(), message: { role: 'user', content: 'ま'.repeat(25000) } }]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('…（5000 文字省略）');
    writeTranscript([human('作業'), { type: 'user', isCompactSummary: true, timestamp: at(), message: { role: 'user', content: '' } }]);
    run({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toContain('直前のコンパクトの要約');
  });

  test('/compact instructions that were all secret still leave a line, and a broken saved length is not used', () => {
    sampleTranscript();
    run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: `ghp_${'a'.repeat(2100)}` });
    expect(fs.readFileSync(recordFile(), 'utf8')).toContain('/compact に付けた指示:');
    const trigger = recordFile().replace(/\.md$/, '.compact.json');
    for (const instructionsLength of [1e400, 3, 'x']) {
      run({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '短い指示' });
      const saved = JSON.parse(fs.readFileSync(trigger, 'utf8'));
      fs.writeFileSync(trigger, JSON.stringify({ ...saved, instructionsLength }));
      run({ hook_event_name: 'SessionStart', source: 'compact' });
      const record = fs.readFileSync(recordFile(), 'utf8');
      expect(record).toContain('/compact に付けた指示: 短い指示\n');
      expect(record).not.toMatch(/Infinity|0 文字省略/);
    }
  });

  test('many repeated command tags are read fast', () => {
    // Break: lazy regexes over the whole uncapped text took about 10 seconds for 60,000 tags.
    writeTranscript([
      human(`<command-message>x</command-message>${'<command-name>'.repeat(60000)}`),
      human(`<command-name>/x</command-name>${'<command-args>'.repeat(60000)}`),
    ]);
    const start = Date.now();
    expect(run({ hook_event_name: 'PreCompact', trigger: 'auto' }).status).toBe(0);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
