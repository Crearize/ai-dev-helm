'use strict';

// 3.7.1 (D5): context-handoff for Codex. The same hook body reads a Codex rollout ({timestamp, type, payload} per
// line, first line session_meta) from its response_item lines, saves on PreCompact, restores on SessionStart
// (compact), and hands /clear over through the marker every Stop writes. The fixtures follow codex-rs rust-v0.163.0
// (history/src/rollout_payload.rs, protocol/src/models.rs, rollout/src/policy.rs).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const TEMPLATE = path.resolve(__dirname, '../templates/hooks/context-handoff.cjs');
const { readCodexRollout, transcriptKind, isCodexInjected, CODEX_INJECT_BYTES } = require(TEMPLATE);

let root;
let repo;
let store;
let hook;
let sessions;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'helm-handoff-codex-')));
  repo = path.join(root, 'repo');
  store = path.join(root, 'store');
  sessions = path.join(root, 'codex-home', 'sessions', '2026', '10', '26');
  fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  // Codex runs the copy in .codex/hooks (the registration's wrapper calls it from the git root).
  hook = path.join(repo, '.codex', 'hooks', 'context-handoff.cjs');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.copyFileSync(TEMPLATE, hook);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

let clock = Date.parse('2026-10-26T00:00:00Z');
const at = () => {
  clock += 60000;
  return new Date(clock).toISOString();
};

// ---------- rollout lines ----------
const line = (type, payload) => ({ timestamp: at(), type, payload });
const meta = (id, mode) => line('session_meta', {
  session_id: id, id, timestamp: at(), cwd: repo, originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli',
  history_mode: mode, base_instructions: { text: 'You are Codex. '.repeat(200) }, git: { commit_hash: 'abc123', branch: 'feat/codex', repository_url: 'https://github.com/o/r' },
});
const turnContext = () => line('turn_context', { turn_id: 't', cwd: repo, approval_policy: 'on-request', model: 'gpt-6-astra' });
const userMessage = (...items) => line('response_item', { type: 'message', role: 'user', content: items.map((item) => (typeof item === 'string' ? { type: 'input_text', text: item } : item)) });
const developer = (text) => line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const reply = (text, phase) => line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...(phase ? { phase } : {}) });
const reasoning = () => line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '考え中' }], encrypted_content: 'xyz' });
const execCommand = (cmd, callId) => line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, yield_time_ms: 10000 }), call_id: callId });
const shellArray = (command, callId) => line('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command, workdir: repo }), call_id: callId });
const output = (callId, out) => line('response_item', { type: 'function_call_output', call_id: callId, output: out });
const applyPatch = (input, callId) => line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input });
const patchOutput = (callId) => line('response_item', { type: 'custom_tool_call_output', call_id: callId, output: 'Success. Updated the following files:\nM src/app.ts' });
const compacted = (message) => line('compacted', { message });
// event_msg differs by history mode (rollout/src/policy.rs): Legacy keeps user_message / agent_message,
// Paginated keeps item_completed. The reader must not count either.
const legacyEvents = (user, agent) => [line('event_msg', { type: 'user_message', message: user, images: [] }), line('event_msg', { type: 'agent_message', message: agent })];
const paginatedEvents = (user, agent) => [
  line('event_msg', { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: user }] } }),
  line('event_msg', { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: agent }] } }),
];

const AGENTS = `# AGENTS.md instructions for ${repo}\n\n<INSTRUCTIONS>\nAlways answer in Japanese.\n</INSTRUCTIONS>`;
const ENV = `<environment_context>\n  <cwd>${repo}</cwd>\n  <shell>bash</shell>\n</environment_context>`;

function sampleRollout(id, mode) {
  const events = mode === 'legacy' ? legacyEvents : paginatedEvents;
  return [
    meta(id, mode),
    developer('<permissions instructions>\nsandbox: workspace-write\n</permissions instructions>'),
    userMessage(AGENTS, ENV),
    turnContext(),
    userMessage('最初の指示: README を直してください'),
    ...events('最初の指示: README を直してください', 'README を直します。'),
    reasoning(),
    reply('README を直します。', 'commentary'),
    applyPatch('*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** Add File: docs/new.md\n+hello\n*** Delete File: old.txt\n*** End Patch\n', 'call_patch'),
    patchOutput('call_patch'),
    execCommand('git commit -m "fix readme"\necho done', 'call_commit'),
    output('call_commit', '[feat/codex 1234567] fix readme'),
    execCommand('ls -la', 'call_ls'),
    output('call_ls', 'https://github.com/o/r/pull/99 (not from a git or gh command)'),
    userMessage('<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'),
    userMessage('<user_shell_command>\n<command>ls</command>\n</user_shell_command>'),
    userMessage('<skill>\n<name>quality-check</name>\nbody\n</skill>'),
    userMessage('<external_hook_context source="x">from a hook</external_hook_context>'),
    userMessage('二つ目の指示: PR を作ってください', { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }),
    ...events('二つ目の指示: PR を作ってください', 'PR を作りました。'),
    shellArray(['bash', '-lc', 'gh pr create --title "Fix README" --body x'], 'call_pr'),
    output('call_pr', [{ type: 'input_text', text: 'Creating pull request\nhttps://github.com/o/r/pull/12\n' }]),
    execCommand("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch\nEOF", 'call_heredoc'),
    output('call_heredoc', 'Done!'),
    compacted('Summary: 前半の要約'),
    reply('最後の応答です。', 'final_answer'),
  ];
}

function writeRollout(id, entries, name = `rollout-2026-10-26T00-00-00-${id}.jsonl`) {
  const file = path.join(sessions, name);
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

function run(input, { env = {}, script = hook } = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: input.cwd || repo,
    input: JSON.stringify({ cwd: repo, model: 'gpt-6-astra', ...input }),
    encoding: 'utf8',
    env: { ...process.env, AI_DEV_HELM_HANDOFF_DIR: store, CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : null };
}

const projectKey = () => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim().replace(/[^\w.-]/g, '_');
const recordOf = (id, base = store) => path.join(base, projectKey(), `${id}.md`);
const ID1 = '019a2b3c-0000-7000-8000-000000000001';
const ID2 = '019a2b3c-0000-7000-8000-000000000002';
const listStore = () => (fs.existsSync(store) ? fs.readdirSync(store, { recursive: true }) : []);

describe('Codex rollout reading', () => {
  test.each(['legacy', 'paginated'])('reads instructions, replies, apply_patch paths, commands and PRs from a %s rollout', async (mode) => {
    // Break: reading event_msg would count every instruction twice (Legacy) or miss them (Paginated); reading the
    // user messages as they are would record AGENTS.md and the environment context as the user's instructions.
    const file = writeRollout(ID1, sampleRollout(ID1, mode));
    expect(transcriptKind(file)).toBe('codex');
    const record = await readCodexRollout(file);
    expect(record.messages.map((m) => m.text.body)).toEqual(['最初の指示: README を直してください', '二つ目の指示: PR を作ってください\n[画像]']);
    expect(record.turns.map((t) => t.replyText)).toEqual(['README を直します。', '最後の応答です。']);
    expect([...record.files.keys()]).toEqual(['README.md', 'docs/new.md', 'old.txt', 'src/app.ts']);
    expect(record.ops.map((o) => o.text.body)).toEqual(['git commit -m "fix readme"', 'gh pr create --title "Fix README" --body x']);
    expect([...record.prs.values()].map((p) => p.text.body)).toEqual(['PR #12 https://github.com/o/r/pull/12']);
    expect(record.compactSummary.body).toBe('Summary: 前半の要約');
    expect(record.cwd).toBe(repo);
    expect(record.branch).toBe('feat/codex');
  });

  test('tells the injected context from what the user typed', () => {
    for (const text of [AGENTS, ENV, '<turn_aborted>\nx\n</turn_aborted>', '<skill>\n<name>a</name>\n</skill>', '<user_instructions>\nx\n</user_instructions>',
      '<external_hook_context source="a">x</external_hook_context>', '<hook_prompt hook_run_id="r">x</hook_prompt>', '[context-handoff] 直前の記録です', '   ']) {
      expect(isCodexInjected(text), text).toBe(true);
    }
    for (const text of ['README を直して', '<b>太字</b> にして、残りはそのまま', 'これを見て: <environment_context>', '# AGENTS.md を読んで直して']) {
      expect(isCodexInjected(text), text).toBe(false);
    }
  });

  test('a .jsonl.zst rollout, a Claude Code transcript and a missing file are not read as a Codex rollout', async () => {
    const zst = path.join(sessions, 'rollout-old.jsonl.zst');
    fs.writeFileSync(zst, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));
    expect(transcriptKind(zst)).toBe('codex-compressed');
    expect((await readCodexRollout(zst)).messages).toEqual([]);
    const claude = path.join(root, 'claude.jsonl');
    fs.writeFileSync(claude, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })}\n`);
    expect(transcriptKind(claude)).toBe('claude');
    expect(transcriptKind(path.join(root, 'nope.jsonl'))).toBe(null);
    expect(transcriptKind(null)).toBe(null);
  });
});

describe('Codex events', () => {
  test('PreCompact saves the record in the Codex store; SessionStart (compact) puts the key points back', () => {
    const file = writeRollout(ID1, sampleRollout(ID1, 'paginated'));
    const pre = run({ hook_event_name: 'PreCompact', session_id: ID1, turn_id: 't1', transcript_path: file, trigger: 'manual' });
    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe('');
    const record = fs.readFileSync(recordOf(ID1), 'utf8');
    expect(record).toContain('きっかけ: コンパクト（/compact）');
    expect(record).toContain('ブランチ: feat/codex');
    expect(record).toContain('> 二つ目の指示: PR を作ってください');
    expect(record).toContain('### Codex');
    expect(record).toContain('- src/app.ts');
    expect(record).toContain('PR #12 https://github.com/o/r/pull/12');
    expect(record).not.toContain('Always answer in Japanese');
    expect(record).not.toContain('environment_context');

    const start = run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact', permission_mode: 'default' });
    expect(start.status).toBe(0);
    expect(Object.keys(start.json)).toEqual(['hookSpecificOutput']);
    expect(Object.keys(start.json.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext']);
    const context = start.json.hookSpecificOutput.additionalContext;
    expect(start.json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain('直前のコンパクト（/compact）の前の会話の記録です');
    expect(context).toContain(recordOf(ID1));
    expect(context).toContain('二つ目の指示: PR を作ってください');
    expect(context).toContain('## 直前の Codex の応答');
    expect(context).not.toContain('Read で読んで');
    expect(fs.existsSync(recordOf(ID1).replace(/\.md$/, '.compact.json'))).toBe(false);
  });

  test('Stop marks the latest session; SessionStart (clear) in the next session restores it once', () => {
    // Break: Codex's SessionEnd cannot tell /clear apart and may run after the new session started.
    const old = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    const stop = run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't1', transcript_path: old, stop_hook_active: false, last_assistant_message: '最後の応答です。' });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    const fresh = writeRollout(ID2, [meta(ID2, 'legacy')]);
    // The same session's SessionStart (clear) does not take its own marker.
    expect(run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: old, source: 'clear' }).stdout).toBe('');
    const start = run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: fresh, source: 'clear' });
    expect(start.status).toBe(0);
    const context = start.json.hookSpecificOutput.additionalContext;
    expect(context).toContain('直前の/clearの前の会話の記録です');
    expect(context).toContain(recordOf(ID1));
    expect(context).toContain('最初の指示: README を直してください');
    expect(fs.readFileSync(recordOf(ID1), 'utf8')).toContain('きっかけ: /clear');
    // Used once.
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: fresh, source: 'clear' }).stdout).toBe('');
  });

  test('SessionStart (clear) also works when the new session has no rollout yet, and ignores a marker over 24 hours old', () => {
    const old = writeRollout(ID1, sampleRollout(ID1, 'paginated'));
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't1', transcript_path: old });
    const notYet = path.join(sessions, `rollout-2026-10-26T01-00-00-${ID2}.jsonl`);
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: notYet, source: 'clear' }).json.hookSpecificOutput.additionalContext).toContain('二つ目の指示');

    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't2', transcript_path: old });
    const marker = path.join(store, 'clear-markers', `${projectKey()}.json`);
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.writeFileSync(marker, JSON.stringify({ ...saved, at: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: notYet, source: 'clear' }).stdout).toBe('');
  });

  test('keeps the restored context within Codex\'s 2,500-token limit (bytes / 4) with many long instructions', () => {
    // Break: over 2,500 tokens Codex moves the context into a file and keeps only a preview.
    const entries = [meta(ID1, 'paginated')];
    for (let i = 0; i < 120; i += 1) {
      entries.push(userMessage(`指示 ${i} ${'あ'.repeat(3000)}`), reply('了解'.repeat(2000)));
      entries.push(applyPatch(`*** Begin Patch\n*** Update File: src/${'深'.repeat(150)}${i}.ts\n*** End Patch`, `p${i}`));
      entries.push(execCommand(`git commit -m "${'変'.repeat(250)} ${i}"`, `c${i}`));
    }
    entries.push(userMessage('最新の指示: ここまでを PR にしてください'));
    const file = writeRollout(ID1, entries);
    const context = run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact' }).json.hookSpecificOutput.additionalContext;
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(CODEX_INJECT_BYTES);
    expect(Math.ceil(Buffer.byteLength(context, 'utf8') / 4)).toBeLessThanOrEqual(2500);
    expect(context).toContain('最新の指示: ここまでを PR にしてください');
    expect(context).toContain(recordOf(ID1));
  });

  test('does nothing for a null or unreadable transcript_path, a .jsonl.zst rollout and a subagent\'s compaction; always exits 0', () => {
    const zst = path.join(sessions, 'rollout-old.jsonl.zst');
    fs.writeFileSync(zst, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));
    const file = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    for (const transcript of [null, path.join(sessions, 'missing.jsonl'), zst]) {
      for (const input of [
        { hook_event_name: 'Stop', turn_id: 't' },
        { hook_event_name: 'PreCompact', turn_id: 't', trigger: 'auto' },
        { hook_event_name: 'SessionStart', source: 'compact' },
      ]) {
        const result = run({ session_id: ID1, transcript_path: transcript, ...input });
        expect(result.status, JSON.stringify(input)).toBe(0);
        expect(result.stdout).toBe('');
      }
    }
    const sub = run({ hook_event_name: 'PreCompact', session_id: ID1, turn_id: 't', transcript_path: file, trigger: 'auto', agent_id: 'a1', agent_type: 'explorer' });
    expect(sub.status).toBe(0);
    expect(listStore().filter((name) => !String(name).startsWith('.'))).toEqual([]);
    // Nothing to restore and no marker: SessionStart (clear) is quiet too.
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: null, source: 'clear' }).stdout).toBe('');
    // A broken input.
    const broken = spawnSync(process.execPath, [hook], { input: '{ not json', encoding: 'utf8' });
    expect(broken.status).toBe(0);
  });

  test('stores under $CODEX_HOME/context-handoff/<git root>, also when run from a subdirectory', () => {
    const codexHome = path.join(root, 'codex-home');
    const file = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    const result = run({ hook_event_name: 'PreCompact', session_id: ID1, turn_id: 't', transcript_path: file, trigger: 'auto', cwd: path.join(repo, 'nested') }, { env: { AI_DEV_HELM_HANDOFF_DIR: '', CODEX_HOME: codexHome } });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(recordOf(ID1, path.join(codexHome, 'context-handoff')), 'utf8')).toContain('きっかけ: 自動コンパクト');
    expect(fs.existsSync(store)).toBe(false);
  });

  test('the template copy (not under .codex/hooks) reads a Codex rollout as Codex too', () => {
    const file = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    const result = run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact' }, { script: TEMPLATE });
    expect(result.json.hookSpecificOutput.additionalContext).toContain('## 直前の Codex の応答');
    expect(fs.existsSync(recordOf(ID1))).toBe(true);
  });

  test('secrets in a Codex rollout are redacted in the record and the restored context, as for Claude Code', () => {
    // Break: the Codex reader bypassing capture() would write a pasted token into the store and back into context.
    const token = `ghp_${'A1b2C3d4E5'.repeat(3)}`;
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage(`この鍵で push して: ${token}`),
      reply(`受け取りました: ${token}`),
      execCommand('git push https://user:s3cr3t-pass@github.com/o/r.git feat/codex', 'call_push'),
      output('call_push', 'done'),
    ]);
    run({ hook_event_name: 'PreCompact', session_id: ID1, turn_id: 't', transcript_path: file, trigger: 'manual' });
    const record = fs.readFileSync(recordOf(ID1), 'utf8');
    const context = run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact' }).json.hookSpecificOutput.additionalContext;
    for (const text of [record, context]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain('s3cr3t-pass');
      expect(text).toContain('[REDACTED]');
    }
    expect(record).toContain('git push https://[REDACTED]@github.com/o/r.git');
  });

  test('AI_DEV_HELM_HANDOFF=off turns Codex off as well', () => {
    const file = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    expect(run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact' }, { env: { AI_DEV_HELM_HANDOFF: 'off' } }).stdout).toBe('');
    expect(fs.existsSync(store)).toBe(false);
  });
});
