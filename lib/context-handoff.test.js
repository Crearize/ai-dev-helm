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

  test('ignores a marker older than 120 seconds and a marker from another directory', () => {
    sampleTranscript();
    run({ hook_event_name: 'SessionEnd', reason: 'clear' });
    const markers = path.join(store, 'clear-markers');
    const [name] = fs.readdirSync(markers);
    const marker = JSON.parse(fs.readFileSync(path.join(markers, name), 'utf8'));
    fs.writeFileSync(path.join(markers, name), JSON.stringify({ ...marker, at: Date.now() - 121000 }));
    expect(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2' }).stdout).toBe('');
    fs.writeFileSync(path.join(markers, name), JSON.stringify({ ...marker, at: Date.now() }));
    expect(run({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-2', cwd: 'C:\\other' }).stdout).toBe('');
  }, 30000);

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
