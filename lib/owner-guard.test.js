'use strict';

// 3.8.0（#248、設計 A5）: owner-guard の判定。本体を、Claude Code と同じ形の JSON を標準入力に渡して起動する。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '../templates/hooks/owner-guard.cjs');
const budget = require('../templates/hooks/review-budget.cjs');
const guard = require('../templates/hooks/owner-guard.cjs');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-owner-guard-'));
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir, stdio: 'ignore' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(input) {
  const r = spawnSync(process.execPath, [HOOK], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  expect(r.status).toBe(0); // 差し戻しも exit 0（JSON で返す）
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const ask = (...questions) => ({
  cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: questions.map(([header, question = '進め方はどれにしますか？']) => ({ question, header, multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] })) },
});
const denied = (out) => Boolean(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny');
const stop = (message, extra = {}) => run({ cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, ...extra });

describe('PreToolUse: the class at the head of each header', () => {
  test('a class alone, class:… and class：… pass; anything else is denied with what to do, in Japanese, as JSON and exit 0', () => {
    // Break: a header check that only takes one colon form (or demands a label) would deny the forms the design allows.
    for (const header of ['業務', '業務:単価', '業務：単価', 'その他', 'テスト', '設計:画面', '本番：反映', '差異']) {
      expect([header, guard.headerClass(header) && guard.headerClass(header).name]).toEqual([header, header.replace(/[:：].*$/, '')]);
    }
    for (const header of ['方針', '業務 単価', '単価:業務', '', '業務単価', 'Business']) expect([header, guard.headerClass(header)]).toEqual([header, null]);
    const out = run(ask(['方針']));
    expect(denied(out)).toBe(true);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/header の先頭に区分がありません。区分（業務・客先・費用・資源・取消・範囲・本番・差異・設計・延長・テスト・その他）を/);
    expect(run(ask(['その他']))).toBeNull();
    expect(run(ask(['費用:月額']))).toBeNull();
  });

  test('every question is checked: one bad question denies the call and names it', () => {
    // Break: a check of questions[0] only lets the second, unclassed question through.
    const out = run(ask(['その他'], ['方針']));
    expect(denied(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('問い 2（header「方針」）');
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain('問い 1');
  });

  test('業務・客先・範囲 need 「（調べたもの: …）」 in the question; the other classes do not', () => {
    // Break: without the check the AI asks the owner what the repository or the record already says.
    for (const cls of ['業務', '客先', '範囲']) {
      const out = run(ask([`${cls}:x`, '単価はいくらですか？']));
      expect([cls, denied(out)]).toEqual([cls, true]);
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('（調べたもの: …）');
      expect(run(ask([cls, '単価はいくらですか？（調べたもの: documents/pricing.md）']))).toBeNull();
      expect(run(ask([cls, '単価はいくらですか？（調べたもの：過去の会話の記録）']))).toBeNull();
    }
    for (const cls of ['費用', '資源', '取消', '本番', '差異', '設計', 'その他']) expect([cls, run(ask([cls, 'どうしますか？']))]).toEqual([cls, null]);
  });

  test('テスト passes with a notice (additionalContext), not a deny', () => {
    // Break: denying テスト would stop the questions that must be asked (a paid or long test).
    const out = run(ask(['テスト:E2E']));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/有料の API・実 AI を呼ばず、副作用が無く、見込み 30 分以内なら、聞かずに実施/);
    // A deny of another question wins over the notice.
    expect(denied(run(ask(['テスト'], ['方針'])))).toBe(true);
  });

  test('unreadable input, no questions and other tools pass without output', () => {
    // Break: a guard that throws or denies on odd input would stop every question (it is fail-open).
    for (const input of ['not json', '', 'null', '[]', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: 'x' } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [null, { header: 3 }] } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', header: '方針' } })]) {
      expect([input, run(input)]).toEqual([input, null]);
    }
  });
});

describe('PreToolUse: 延長 against the branch\'s review-budget state', () => {
  const begin = (phase, roles, limit) => budget.beginRound({ cwd: dir, phase, roles, limit });

  test('quality below its limit denies 延長; at the limit it passes; 延長:全員 always passes', () => {
    // Break: reading another file than review-budget's (another hash, the branch name without refs/heads/) finds no
    // state and lets every 延長 through.
    begin('quality', ['integrated-reviewer']);
    const out = run(ask(['延長:品質']));
    expect(denied(out)).toBe(true);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('上限の内なので、直した高があれば次の巡を回し、最後の報告に書いて');
    expect(run(ask(['延長:全員']))).toBeNull();
    expect(run(ask(['延長：全員レビュー']))).toBeNull();
    // The state the guard read is review-budget's own file.
    expect(fs.existsSync(budget.status({ cwd: dir }).statePath)).toBe(true);
  });

  test('a phase at its limit passes; an approved extend puts it below again', () => {
    // Break: comparing with the phase limit alone ignores the rounds the owner approved with extend.
    begin('quality', ['integrated-reviewer'], 1);
    expect(run(ask(['延長']))).toBeNull();
    budget.extendLimit({ cwd: dir, phase: 'quality', rounds: 1, reason: 'オーナー「もう 1 巡回してよい」' });
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('production counts as quality does; design, no state, another branch and a broken state pass', () => {
    // Break: denying 延長 of a design review, or with no state, would stop a question the owner must answer.
    expect(run(ask(['延長']))).toBeNull(); // no state yet
    begin('design', ['document-reviewer']);
    expect(run(ask(['延長']))).toBeNull(); // design only
    begin('production', ['integrated-reviewer']);
    expect(denied(run(ask(['延長'])))).toBe(true);
    // Another branch has its own (empty) state (the repository has no commit: HEAD is moved by symbolic-ref).
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feat/y'], { cwd: dir, stdio: 'ignore' });
    expect(run(ask(['延長']))).toBeNull();
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feat/x'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(budget.status({ cwd: dir }).statePath, '{ broken');
    expect(run(ask(['延長']))).toBeNull();
  });

  test('when quality reached its limit and production is below, 延長 passes (it may be about quality)', () => {
    // Break: denying on any phase below its limit stops the question about the phase that reached it.
    begin('quality', ['integrated-reviewer'], 1);
    begin('production', ['integrated-reviewer']);
    expect(run(ask(['延長']))).toBeNull();
  });

  test('outside a repository (cwd not in git) 延長 passes', () => {
    // Break: a git failure that is not caught would end the guard with an error instead of letting the question through.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-owner-guard-out-'));
    try {
      const r = spawnSync(process.execPath, [HOOK], { cwd: outside, input: JSON.stringify({ ...ask(['延長']), cwd: outside }), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Stop: asking the user to do an operation', () => {
  test.each([
    '次のコマンドを実行してください。',
    'ブラウザで http://localhost:3000 を開いてください。',
    'GitHub にログインしてください。',
    '画面の「承認」ボタンを押してください。',
    'トークンを入力してください。',
    'プロンプトで `! gh auth login` と打ってください。',
    '`! npm run deploy` で反映できます。',
    'アプリを再起動して下さい。',
    'OK ならマージしてください。',
    '実行をお願いします。',
    'Please run `npm test` and tell me the result.',
  ])('blocks: %s', (message) => {
    // Break: a missing phrase lets the AI hand an operation to the user (the record's main complaint).
    const out = stop(`作業を進めました。\n\n${message}`);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/ユーザーに操作を頼んでいます（該当: 「.+」）。自分で実行して確かめ/);
    expect(out.reason).toContain('[本人の操作]');
  });

  test.each([
    '完了: テストを実行し、すべて通りました。',
    'ユーザーに「実行してください」と頼まない規則を足しました。',
    '差し戻しの文に『開いてください』が入っていないかを確かめた。',
    '```\n# 手順: 次を実行してください\nnpm test\n```\nこの手順を README に入れました。',
    '> トークンを入力してください\n\nという文を README から消しました。',
    '判断が必要なこと: マージしてよいか、ご確認ください。',
    '`!==` を `!=` に直しました。',
  ])('passes: %s', (message) => {
    // Break: quoting a rule or a document (「」, code, a quote line) would block every report about these rules.
    expect(stop(message)).toBeNull();
  });

  test('[本人の操作] in the same reply, stop_hook_active and unreadable input pass', () => {
    // Break: without stop_hook_active the guard and another Stop hook would keep the turn going forever.
    expect(stop('[本人の操作] MFA の確認が要るため、ブラウザでログインしてください（理由: 本人の確認が必須）。')).toBeNull();
    expect(stop('次のコマンドを実行してください。', { stop_hook_active: true })).toBeNull();
    expect(run('not json')).toBeNull();
    expect(stop('')).toBeNull();
  });

  test('without last_assistant_message, the last assistant text of the transcript is read (not an earlier turn, not a subagent)', () => {
    // Break: reading the whole transcript blocks on an old turn; reading nothing lets the request through.
    const file = path.join(dir, 'transcript.jsonl');
    const line = (entry) => JSON.stringify(entry);
    const assistant = (text, extra = {}) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
    const user = (content) => line({ type: 'user', message: { role: 'user', content } });
    const write = (...lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const fromTranscript = () => run({ cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: file });
    write(user('作業して'), assistant('調べます。'), line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), assistant('終わりました。'), assistant('次のコマンドを実行してください。'));
    expect(fromTranscript().decision).toBe('block');
    expect(guard.lastAssistantText(file)).toBe('終わりました。\n\n次のコマンドを実行してください。');
    write(assistant('次のコマンドを実行してください。'), user('自分でやって'), assistant('実行して確かめました。'));
    expect(fromTranscript()).toBeNull();
    write(user('作業して'), assistant('完了しました。'), assistant('ブラウザで開いてください。', { isSidechain: true }));
    expect(fromTranscript()).toBeNull();
    // A missing transcript passes.
    expect(run({ cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: path.join(dir, 'none.jsonl') })).toBeNull();
  });
});

test('the file header states the purpose (fail-open, not a security boundary) and lists every class', () => {
  // Break: a class added to the hook but not to its header leaves the next reader without the table.
  const head = fs.readFileSync(HOOK, 'utf8').split('\nconst fs')[0];
  expect(head).toContain('意図的な回避は追わない');
  expect(head).toContain('fail-open');
  for (const cls of guard.CLASSES) expect([cls, head.includes(cls)]).toEqual([cls, true]);
});
