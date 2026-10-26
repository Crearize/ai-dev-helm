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
const { readCodexRollout, transcriptKind, isCodexInjected, codexProjectKey, CODEX_INJECT_BYTES } = require(TEMPLATE);

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
// The order of Codex 0.163's session_meta: source comes after about 500-620 bytes (the reader must look that far).
const meta = (id, mode, { source = 'cli', cwd = repo } = {}) => ({ timestamp: at(), ordinal: 0, type: 'session_meta', payload: {
  creator_user_id: 'user-0123456789abcdefghijklmn', creator_account_id: '01234567-89ab-cdef-0123-456789abcdef',
  session_id: id, id, parent_thread_id: '019a2b3c-0000-7000-8000-000000000000', timestamp: at(), cwd, runtime_workspace_roots: [cwd],
  originator: 'codex-tui', cli_version: '0.163.0', source,
  history_mode: mode, base_instructions: { text: 'You are Codex. '.repeat(200) }, git: { commit_hash: 'abc123', branch: 'feat/codex', repository_url: 'https://github.com/o/r' },
} });
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
// Codex 0.163 keeps the summary encrypted in replacement_history; message is empty.
const compacted = (message) => line('compacted', { message, replacement_history: [{ type: 'compaction', encrypted_content: 'gAAAA' }] });
// Codex 0.163's default: shell commands and patches are calls in the JavaScript the exec tool runs.
const execScript = (code, callId) => line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'exec', input: code });
const execOutput = (callId, text) => line('response_item', { type: 'custom_tool_call_output', call_id: callId, name: 'exec', output: [{ type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' }, { type: 'input_text', text }] });
const questionReply = (answers) => userMessage(`<send_user_message_question_reply>\n${JSON.stringify(answers)}\n</send_user_message_question_reply>`);
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
    compacted(''),
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

// The project's folder in a store (the git root's name and a hash): the one folder other than clear-markers.
const projectDirs = (base = store) => fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'clear-markers').map((d) => d.name);
const recordOf = (id, base = store) => {
  const dirs = projectDirs(base);
  expect(dirs).toHaveLength(1);
  return path.join(base, dirs[0], `${id}.md`);
};
const markerOf = () => {
  const names = fs.readdirSync(path.join(store, 'clear-markers'));
  expect(names).toHaveLength(1);
  return path.join(store, 'clear-markers', names[0]);
};
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
    expect(record.compactSummary).toBe(null);
    expect(record.cwd).toBe(repo);
    expect(record.branch).toBe('feat/codex');
  });

  test('tells the injected context from what the user typed', () => {
    for (const text of [AGENTS, ENV, '<turn_aborted>\nx\n</turn_aborted>', '<skill>\n<name>a</name>\n</skill>', '<user_instructions>\nx\n</user_instructions>',
      '<external_hook_context source="a">x</external_hook_context>', '<hook_prompt hook_run_id="r">x</hook_prompt>', '[context-handoff] 直前の記録です', '   ']) {
      expect(isCodexInjected(text), text).toBe(true);
    }
    expect(isCodexInjected('<recommended_plugins>\n- a\n</recommended_plugins>')).toBe(true);
    // A user's own HTML is an instruction: HTML tag names have no underscore.
    for (const text of ['README を直して', '<b>太字</b> にして、残りはそのまま', 'これを見て: <environment_context>', '# AGENTS.md を読んで直して',
      '<b>太字</b>', '<details>\n<summary>この折りたたみを README の先頭に入れて</summary>\n</details>']) {
      expect(isCodexInjected(text), text).toBe(false);
    }
  });

  test('reads the commands, patches and PRs in the JavaScript of Codex 0.163\'s exec tool', async () => {
    // Break: Codex 0.163 runs shell commands and apply_patch inside exec; reading only function_call exec_command and
    // custom_tool_call apply_patch records no file, operation or PR from a real conversation.
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: docs/b.md\n+x\n*** End Patch\n';
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage('直して PR にしてください'),
      execScript(`text(await tools.apply_patch(${JSON.stringify(patch)}));`, 'e1'),
      execOutput('e1', 'Success. Updated the following files:\nM src/a.ts'),
      execScript([
        'const r = await Promise.allSettled([',
        '  tools.exec_command({cmd:"git commit -m \\"feat: x\\"",max_output_tokens:2000}),',
        "  tools.exec_command({\"cmd\":'gh pr create --title \"T\" --body b'}),",
        '  tools.exec_command({cmd:`git push origin ${branch}`}),',
        '  tools.exec_command({cmd}),',
        ']);text(r);',
      ].join('\n'), 'e2'),
      execOutput('e2', JSON.stringify([{ status: 'fulfilled', value: { output: 'https://github.com/o/r/pull/34\n' } }])),
      execScript('text(await tools.exec_command({cmd:"cat docs/notes.md"}));', 'e3'),
      execOutput('e3', 'see https://github.com/o/r/pull/7 (a reference in a file)'),
      reply('PR を作りました。'),
    ]);
    const record = await readCodexRollout(file);
    expect([...record.files.keys()]).toEqual(['src/a.ts', 'docs/b.md']);
    expect(record.ops.map((o) => o.text.body)).toEqual(['git commit -m "feat: x"', 'gh pr create --title "T" --body b', 'git push origin ${branch}']);
    expect([...record.prs.values()].map((p) => p.text.body)).toEqual(['PR #34 https://github.com/o/r/pull/34']);
  });

  test('reads cmd anywhere in the exec_command object, shell_command\'s command, and the escapes of a template literal', async () => {
    // Break: reading only a cmd right after "{" missed {workdir, cmd} (37 calls in real rollouts); the escapes of
    // `...` and shell_command were not tested.
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage('PR を作ってください'),
      execScript([
        'await tools.exec_command({workdir:"/w", yield_time_ms:1000, cmd:"gh pr create --title A --body b"});',
        'await tools.exec_command({ env: { GIT_DIR: "/x", cmd: "not this" }, "cmd": \'git push origin feat/a\' });',
        'await tools.exec_command({cmd:`git commit -m \\`x\\` -m "a\\tb"`});',
        'await tools.shell_command({workdir:"/w", command:"gh pr merge 5 --squash"});',
      ].join('\n'), 'e1'),
      execOutput('e1', 'https://github.com/o/r/pull/41'),
    ]);
    const record = await readCodexRollout(file);
    expect(record.ops.map((o) => o.text.body)).toEqual(['gh pr create --title A --body b', 'git push origin feat/a', 'git commit -m `x` -m "a\tb"', 'gh pr merge 5 --squash']);
    expect([...record.prs.values()].map((p) => p.text.body)).toEqual(['PR #41 https://github.com/o/r/pull/41']);
  });

  test('a regex literal does not hide the calls after it, and the object is read as JavaScript reads it', async () => {
    // Break: a scanner without regex literals read the quote in /'/g as a string to the end of the line, /\/*$/ as a
    // comment to the end of the script and /[{(]/ as an object that never closes, and lost every call after them
    // (the old per-call regex found them). In the object: a comment before cmd, a "cmd" string as a value, and a
    // repeated key (JavaScript keeps the last one).
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage('PR を作ってください'),
      execScript([
        'const q = (s) => "\'" + s.replace(/\'/g, "\'\'") + "\'"; await tools.exec_command({cmd:"gh issue close 3"});',
        'const base = dir.replace(/\\/*$/, "");',
        'await tools.exec_command({cmd:"git tag v1", workdir: dir.replace(/[{(`]/g, "")});',
        'await tools.exec_command({ // note',
        '  cmd: /* x */ "git push origin a" });',
        'await tools.exec_command({cmd: "gh pr create --fill", workdir: c ? "cmd" : "x"});',
        'await tools.exec_command({cmd:"git status", cmd:"git push --force origin b"});',
        'const half = total / 2; await tools.exec_command({cmd:"git commit -m half"});',
      ].join('\n'), 'e1'),
      execOutput('e1', 'https://github.com/o/r/pull/77'),
    ]);
    const record = await readCodexRollout(file);
    expect(record.ops.map((o) => o.text.body)).toEqual([
      'gh issue close 3', 'git tag v1', 'git push origin a', 'gh pr create --fill', 'git push --force origin b', 'git commit -m half',
    ]);
    expect([...record.prs.values()].map((p) => p.text.body)).toEqual(['PR #77 https://github.com/o/r/pull/77']);
  });

  test('a tools call written in a string literal or a comment of the exec script is not an operation', async () => {
    // Break: matching the call text anywhere recorded a force push that only sat in a patch or a comment, and
    // counted that exec's output PRs.
    const patch = '*** Begin Patch\n*** Add File: docs/howto.md\n+tools.exec_command({cmd:"git push --force origin main"})\n*** End Patch\n';
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage('手順書を書いてください'),
      execScript([
        `await tools.apply_patch(${JSON.stringify(patch)});`,
        '// await tools.exec_command({cmd:"git push --force origin main"});',
        '/* tools.exec_command({cmd:"gh pr merge 1"}) */',
        "const note = 'tools.exec_command({cmd:\"git push origin x\"})';",
        'const doc = `',
        'tools.apply_patch("*** Begin Patch\\n*** Delete File: README.md\\n*** End Patch")',
        '`;',
        'text(await tools.exec_command({cmd:"cat docs/howto.md"}));',
      ].join('\n'), 'e1'),
      execOutput('e1', 'https://github.com/o/r/pull/8'),
    ]);
    const record = await readCodexRollout(file);
    expect([...record.files.keys()]).toEqual(['docs/howto.md']);
    expect(record.ops).toEqual([]);
    expect(record.prs.size).toBe(0);
  });

  test('reads an exec script built to slow a scanner down in linear time', async () => {
    // Break: retrying an unterminated literal or comment at every quote takes quadratic time past the hook's timeout.
    const scripts = ['\\"'.repeat(200000), '\\`'.repeat(200000), '/*'.repeat(200000), 'tools.exec_command({'.repeat(20000), `tools.exec_command({cmd:${'"a",'.repeat(100000)}`,
      '=/['.repeat(150000), '(/\\'.repeat(150000), `x =${' '.repeat(400000)}/`, ' / '.repeat(150000)];
    const file = writeRollout(ID1, [meta(ID1, 'paginated'), ...scripts.map((code, i) => execScript(code, `e${i}`))]);
    const started = Date.now();
    const record = await readCodexRollout(file);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(record.ops).toEqual([]);
  });

  test('keeps an answer to Codex\'s question as an answer, not dropped with the injected context', async () => {
    // Break: the reply comes as one tag block in a user message, which the injection filter would drop.
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      userMessage('設計を進めてください'),
      questionReply([{ answer: '推奨で進める', question: 'どちらにしますか？', questionItemId: 'x' }, { answer: ' ', question: '空の回答' }]),
      userMessage('<send_user_message_question_reply>\n読めない形の回答\n</send_user_message_question_reply>'),
      reply('推奨で進めます。'),
    ]);
    const record = await readCodexRollout(file);
    expect(record.messages.map((m) => [m.kind, m.text.body])).toEqual([
      ['指示', '設計を進めてください'], ['質問への回答', 'どちらにしますか？ → 推奨で進める'], ['質問への回答', '読めない形の回答'],
    ]);
    expect(record.turns.map((t) => t.replyText)).toEqual(['推奨で進めます。']);
  });

  test('reads a patch line with a long run of spaces in linear time', async () => {
    // Break: /: (.+?)\s*$/ takes quadratic time here (about 10 s for 100,000 spaces), past the hook's timeout.
    const file = writeRollout(ID1, [
      meta(ID1, 'paginated'),
      applyPatch(`*** Begin Patch\n*** Update File: a${' '.repeat(100000)}b\n*** Update File:   \n*** End Patch`, 'p1'),
    ]);
    const started = Date.now();
    const record = await readCodexRollout(file);
    expect(Date.now() - started).toBeLessThan(3000);
    expect([...record.files.keys()]).toEqual([`a${' '.repeat(100000)}b`]);
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
    // Codex creates the rollout before it writes session_meta: an empty file is not known yet.
    const empty = path.join(sessions, 'rollout-empty.jsonl');
    fs.writeFileSync(empty, '');
    expect(transcriptKind(empty)).toBe(null);
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
    const marker = markerOf();
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.writeFileSync(marker, JSON.stringify({ ...saved, at: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: notYet, source: 'clear' }).stdout).toBe('');
    // 23 hours is still within the limit (the marker of a conversation left overnight).
    fs.writeFileSync(marker, JSON.stringify({ ...saved, at: Date.now() - 23 * 60 * 60 * 1000 }));
    expect(run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: notYet, source: 'clear' }).json.hookSpecificOutput.additionalContext).toContain('二つ目の指示');
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
    // Named after the git root (not the subdirectory), with a hash of its path.
    expect(projectDirs(path.join(codexHome, 'context-handoff'))[0]).toMatch(/^repo-[0-9a-f]{16}$/);
    expect(fs.existsSync(store)).toBe(false);
  });

  test('the template copy (not under .codex/hooks) reads a Codex rollout as Codex too', () => {
    const file = writeRollout(ID1, sampleRollout(ID1, 'legacy'));
    const result = run({ hook_event_name: 'SessionStart', session_id: ID1, transcript_path: file, source: 'compact' }, { script: TEMPLATE });
    expect(result.json.hookSpecificOutput.additionalContext).toContain('## 直前の Codex の応答');
    expect(fs.existsSync(recordOf(ID1))).toBe(true);
  });

  test('SessionStart (clear) restores from the marker when the new rollout exists but is still empty, without waiting', () => {
    // Break: an empty rollout read as a Claude Code transcript sent the Codex copy down Claude Code's path, which
    // waits 5 seconds for a Claude Code marker and restores nothing.
    const old = writeRollout(ID1, sampleRollout(ID1, 'paginated'));
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't1', transcript_path: old });
    const empty = path.join(sessions, `rollout-2026-10-26T01-00-00-${ID2}.jsonl`);
    fs.writeFileSync(empty, '');
    const started = Date.now();
    const start = run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: empty, source: 'clear' });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(start.json.hookSpecificOutput.additionalContext).toContain('二つ目の指示');
    // PreCompact on the empty rollout writes nothing.
    expect(run({ hook_event_name: 'PreCompact', session_id: ID2, turn_id: 't', transcript_path: empty, trigger: 'auto' }).stdout).toBe('');
    expect(fs.existsSync(path.join(path.dirname(recordOf(ID1)), `${ID2}.md`))).toBe(false);
    // A first line written only in part (before "type") is not a Claude Code transcript either: the .codex/hooks copy
    // always takes Codex's path.
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't2', transcript_path: old });
    fs.writeFileSync(empty, '{"timestamp":"2026-10-26T01:00:00.000Z",');
    const partial = run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: empty, source: 'clear' });
    expect(partial.json.hookSpecificOutput.additionalContext).toContain('二つ目の指示');
  });

  test('two projects whose names differ only in non-ASCII characters keep their own store and /clear marker', () => {
    // Break: safeName turns 損保 and 映画 into the same "__", so /clear in one restored the other's conversation.
    const projects = ['損保', '映画'].map((name) => {
      const dir = path.join(root, 'w', name);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
      return dir;
    });
    const [a, b] = projects;
    const rolloutA = writeRollout(ID1, [meta(ID1, 'paginated', { cwd: a }), userMessage('損保の指示: 料率を直して'), reply('直します。')]);
    const rolloutB = writeRollout(ID2, [meta(ID2, 'paginated', { cwd: b }), userMessage('映画の指示: 予告編を直して'), reply('直します。')]);
    run({ hook_event_name: 'Stop', session_id: ID2, turn_id: 't', transcript_path: rolloutB, cwd: b });
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't', transcript_path: rolloutA, cwd: a });
    expect(fs.readdirSync(path.join(store, 'clear-markers'))).toHaveLength(2);
    const ID3 = '019a2b3c-0000-7000-8000-000000000003';
    const context = run({ hook_event_name: 'SessionStart', session_id: ID3, transcript_path: null, source: 'clear', cwd: b }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('映画の指示');
    expect(context).not.toContain('損保の指示');
    expect(projectDirs()).toHaveLength(1);
  });

  test('the project key is the root\'s folder name (64 characters at most) and a hash of the whole path', () => {
    // Break: naming the store after the whole path passed the 255-character limit of one name for a root of 234
    // characters or more, and Stop / PreCompact silently wrote nothing.
    const deep = path.join(root, ...Array.from({ length: 6 }, (_, i) => `${'d'.repeat(50)}${i}`), `app-${'x'.repeat(100)}`);
    const key = codexProjectKey(deep);
    expect(key).toMatch(new RegExp(`^app-${'x'.repeat(60)}-[0-9a-f]{16}$`));
    expect(key.length).toBe(64 + 17);
    // The same folder name in two places: two keys.
    const a = codexProjectKey(path.join(root, 'w', 'a', 'app'));
    const b = codexProjectKey(path.join(root, 'w', 'b', 'app'));
    expect(a).toMatch(/^app-[0-9a-f]{16}$/);
    expect(b).toMatch(/^app-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(codexProjectKey(path.join(root, 'w', 'プロジェクト'))).toMatch(/^______-[0-9a-f]{16}$/);
  });

  test.runIf(process.platform === 'win32')('on Windows a path in another case is the same project (name and hash)', () => {
    // Break: the name kept the case of the cwd, so C:\...\NotARepo and c:\...\notarepo had two stores.
    const dir = path.join(root, 'NotARepo');
    expect(codexProjectKey(dir.toUpperCase())).toBe(codexProjectKey(dir.toLowerCase()));
    expect(codexProjectKey(dir)).toMatch(/^notarepo-[0-9a-f]{16}$/);
  });

  test.skipIf(process.platform === 'win32')('Stop and PreCompact still write for a git root over 240 characters long', () => {
    // Windows is skipped: git init fails there at about 236 characters.
    const deep = path.join(root, ...Array.from({ length: 5 }, (_, i) => `${'d'.repeat(50)}${i}`), 'repo');
    expect(deep.length).toBeGreaterThan(240);
    fs.mkdirSync(deep, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: deep, stdio: 'ignore' });
    const file = writeRollout(ID1, [meta(ID1, 'paginated', { cwd: deep }), userMessage('深い場所の指示'), reply('直します。')]);
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't', transcript_path: file, cwd: deep });
    run({ hook_event_name: 'PreCompact', session_id: ID1, turn_id: 't', transcript_path: file, trigger: 'auto', cwd: deep });
    expect(fs.readFileSync(recordOf(ID1), 'utf8')).toContain('深い場所の指示');
    expect(JSON.parse(fs.readFileSync(markerOf(), 'utf8')).sessionId).toBe(ID1);
  });

  test('Stop of a `codex exec` run or a subagent session leaves the interactive session\'s marker as it is', () => {
    // Break: an exec run (an AI's acceptance test) ending after the user's turn replaced the marker, and /clear
    // restored the exec run.
    const user = writeRollout(ID1, sampleRollout(ID1, 'paginated'));
    run({ hook_event_name: 'Stop', session_id: ID1, turn_id: 't1', transcript_path: user });
    const ID3 = '019a2b3c-0000-7000-8000-000000000003';
    const ID4 = '019a2b3c-0000-7000-8000-000000000004';
    const ID5 = '019a2b3c-0000-7000-8000-000000000005';
    const execMeta = meta(ID3, 'paginated', { source: 'exec' });
    // As in Codex 0.163, source sits past the first 512 bytes of the line (the reader must not stop at 512).
    expect(Buffer.byteLength(JSON.stringify(execMeta).split('"source"')[0])).toBeGreaterThan(512);
    const exec = writeRollout(ID3, [execMeta, userMessage('受け入れ試験の指示'), reply('試験しました。')]);
    const sub = writeRollout(ID4, [meta(ID4, 'paginated', { source: { subagent: { thread_spawn: { parent_thread_id: ID1, depth: 1 } } } }), userMessage('サブエージェントへの依頼'), reply('調べました。')]);
    const mcp = writeRollout(ID5, [meta(ID5, 'paginated', { source: 'mcp' }), userMessage('MCP からの依頼'), reply('答えました。')]);
    for (const [id, file] of [[ID3, exec], [ID4, sub], [ID5, mcp]]) {
      expect(run({ hook_event_name: 'Stop', session_id: id, turn_id: 't', transcript_path: file }).stdout).toBe('');
    }
    expect(JSON.parse(fs.readFileSync(markerOf(), 'utf8')).sessionId).toBe(ID1);
    const context = run({ hook_event_name: 'SessionStart', session_id: ID2, transcript_path: null, source: 'clear' }).json.hookSpecificOutput.additionalContext;
    expect(context).toContain('二つ目の指示');
    expect(context).not.toContain('受け入れ試験の指示');
    expect(context).not.toContain('MCP からの依頼');
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
