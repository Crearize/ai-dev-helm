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
    for (const header of ['方針', '単価:業務', '', '業務単価', 'Business', 'テスト結果']) expect([header, guard.headerClass(header)]).toEqual([header, null]);
    // 2 巡目の中 3: a space alone also separates the class from its label.
    expect(guard.headerClass('業務 単価')).toEqual({ name: '業務', label: '単価' });
    expect(guard.headerClass('延長　停滞')).toEqual({ name: '延長', label: '停滞' });
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

  // reservedAt has millisecond precision: wait a little so two reservations in a row never share a time.
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);

  test('the phase of the last reserved round decides: design after quality passes; production last and below denies', () => {
    // Break: looking at any quality / production phase (not the last reserved round) stops a design 延長 on a branch
    // that also has a quality state, and lets a production 延長 through after quality reached its limit.
    expect(run(ask(['延長']))).toBeNull(); // no state yet
    begin('quality', ['integrated-reviewer']); // quality 1/5
    pause();
    begin('design', ['document-reviewer'], 1); // design 1/1, the last round
    expect(guard.lastRoundPhase(JSON.parse(fs.readFileSync(budget.status({ cwd: dir }).statePath, 'utf8')))).toBe('design');
    expect(run(ask(['延長']))).toBeNull();
    pause();
    begin('production', ['integrated-reviewer']); // production 1/5, the last round
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('quality at its limit, production last and below: 延長 is denied (it is about production)', () => {
    // Break: passing when any quality / production phase reached its limit lets the production 延長 through.
    begin('quality', ['integrated-reviewer'], 1);
    pause();
    begin('production', ['integrated-reviewer']);
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('延長:停滞 (any label holding 停滞), 延長:設計 and 延長:要件 pass below the limit (X1 after the rework, design and requirements reviews)', () => {
    // Break: denying them stops the X1 question the rules require even below the limit.
    begin('quality', ['integrated-reviewer']);
    for (const header of ['延長:停滞', '延長：停滞（作りの見直しの後）', '延長:構造的停滞', '延長:X1停滞', '延長 停滞', '延長:設計', '延長:要件', ' 延長 ： 全員 ']) {
      expect([header, run(ask([header]))]).toEqual([header, null]);
    }
    const out = run(ask(['延長:品質']));
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('X1 の停滞・構造的停滞（作りの見直しの後も続くもの）は「延長:停滞」「延長:構造的停滞」');
  });

  // 2 巡目の高 1: plan and mutation do not wait for the owner, so a reservation of theirs is not "the last round".
  test('a mutation or plan reservation after quality below its limit: 延長 is still denied', () => {
    // Break: counting plan / mutation rounds as the last round lets the quality 延長 below the limit through.
    begin('quality', ['integrated-reviewer']);
    pause();
    begin('quality', ['verification-reviewer']); // quality 2/5
    pause();
    begin('mutation', ['falsification-qa'], 1); // mutation 1/1
    expect(denied(run(ask(['延長'])))).toBe(true);
    pause();
    begin('plan', ['document-reviewer']); // plan 1/3
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('a retake counts as a reservation of its phase (rounds[].retakes[].at)', () => {
    // Break: reading reservedAt alone takes design as the last round after the quality round was retaken.
    begin('quality', ['integrated-reviewer']);
    pause();
    begin('design', ['document-reviewer'], 1);
    expect(run(ask(['延長']))).toBeNull();
    const file = budget.status({ cwd: dir }).statePath;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.phases.quality.rounds[0].retakes = [{ token: 'a'.repeat(32), roles: ['integrated-reviewer'], used: {}, reason: 'the reviewer results were lost', at: new Date(Date.now() + 60000).toISOString() }];
    fs.writeFileSync(file, JSON.stringify(state));
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('quality 1/5, then design, then quality 2/5: the latest time decides, not the order of the phases in the state', () => {
    // Break: taking the last phase in the state object (design, added after quality) would let this 延長 through.
    begin('quality', ['integrated-reviewer']);
    pause();
    begin('design', ['document-reviewer'], 3);
    pause();
    begin('quality', ['verification-reviewer']);
    const state = JSON.parse(fs.readFileSync(budget.status({ cwd: dir }).statePath, 'utf8'));
    expect(Object.keys(state.phases)).toEqual(['quality', 'design']);
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('a design reservation with --limit 3 (1 of 3) passes; rounds of two phases at the same time pass', () => {
    // Break: denying the design 延長 below its limit, or picking one of two phases reserved at the same time.
    begin('design', ['document-reviewer'], 3);
    expect(run(ask(['延長']))).toBeNull();
    const file = budget.status({ cwd: dir }).statePath;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = state.phases.design.rounds[0].reservedAt;
    state.phases.quality = { limit: 5, rounds: [{ token: 'b'.repeat(32), roles: ['integrated-reviewer'], used: {}, reservedAt: at }] };
    fs.writeFileSync(file, JSON.stringify(state));
    expect(guard.lastRoundPhase(state)).toBeNull();
    expect(run(ask(['延長']))).toBeNull();
    state.phases.quality.rounds[0].reservedAt = new Date(Date.parse(at) + 1).toISOString();
    fs.writeFileSync(file, JSON.stringify(state));
    expect(denied(run(ask(['延長'])))).toBe(true);
  });

  test('another branch, a broken state, another version or another branch in the state, and rounds without a time pass', () => {
    // Break: a state that is not this branch's version-1 state would be read as if it were, and deny wrongly.
    begin('quality', ['integrated-reviewer']);
    expect(denied(run(ask(['延長'])))).toBe(true);
    const file = budget.status({ cwd: dir }).statePath;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Another branch has its own (empty) state (the repository has no commit: HEAD is moved by symbolic-ref).
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feat/y'], { cwd: dir, stdio: 'ignore' });
    expect(run(ask(['延長']))).toBeNull();
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feat/x'], { cwd: dir, stdio: 'ignore' });
    for (const changed of [{ ...state, version: 2 }, { ...state, branch: 'refs/heads/feat/y' },
      { ...state, phases: { quality: { ...state.phases.quality, rounds: state.phases.quality.rounds.map(({ reservedAt, ...r }) => r) } } }]) {
      fs.writeFileSync(file, JSON.stringify(changed));
      expect(run(ask(['延長']))).toBeNull();
    }
    fs.writeFileSync(file, '{ broken');
    expect(run(ask(['延長']))).toBeNull();
    fs.writeFileSync(file, JSON.stringify(state));
    expect(denied(run(ask(['延長'])))).toBe(true);
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
    '`! npm run deploy` で反映してください。',
    'アプリを再起動して下さい。',
    'OK ならマージしてください。',
    '実行をお願いします。',
    'Please run `npm test` and tell me the result.',
    // 1 巡目の中 5（見逃し）
    '次のコマンドを実行してみてください。',
    'ブラウザで開いてみてください。',
    'このコマンドを実行して頂けますか？',
    '`npm run build` を実行していただけると助かります。',
    'デプロイの実行お願いします。',
    'ページをリロードしてください。',
    'GitHub にログインし直してください。',
    '`gh auth login` をお願いします。',
    '`! npm test` で確かめてください。',
    '`! gh auth login` が必要です。',
    // 2 巡目の中 4・5（よく使う動詞と頼む語）
    '環境変数を設定してください。',
    'アプリを起動してください。',
    'このページにアクセスしてください。',
    'ファイルをダウンロードしてください。',
    '画像をアップロードしていただけますでしょうか。',
    '権限を許可していただきたいです。',
    'この PR を承認してもらえると助かります。',
    '設定を保存して貰えますか。',
    'マージをお願いしたいです。',
    '実行してほしい（急ぎ）。',
    'マージしてほしいです。',
  ])('blocks: %s', (message) => {
    // Break: a missing phrase lets the AI hand an operation to the user (the record's main complaint).
    const out = stop(`作業を進めました。\n\n${message}`);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/ユーザーに操作を頼んでいます（該当: 「.+」）。/);
    expect(out.reason).toContain('操作を頼まずに「〜してよいか」と承認を求めて'); // 1 巡目の中 4
    expect(out.reason).toContain('[本人の操作]');
    expect(out.reason).toContain('自分で実行して確かめ');
  });

  test.each([
    '完了: テストを実行し、すべて通りました。',
    'ユーザーに「実行してください」と頼まない規則を足しました。',
    '差し戻しの文に『開いてください』が入っていないかを確かめた。',
    '```\n# 手順: 次を実行してください\nnpm test\n```\nこの手順を README に入れました。',
    '> トークンを入力してください\n\nという文を README から消しました。',
    '判断が必要なこと: マージしてよいか、ご確認ください。',
    '`!==` を `!=` に直しました。',
    // 1 巡目の中 3（誤検出）
    'オーナーからマージしてほしいと指示があったため、マージしました。',
    '次の手順を自動で実行してほしい場合は、--yes を付けます。',
    'エラー: Please run `npm install` first. と出たので、依存を入れ直して解決しました。',
    '差し戻しの文から "実行してください" を消しました。',
    '例文 “開いてください” は使いません。',
    '| 実行してください | 依頼として差し戻す |',
    '設定ファイルに `! npm test` の例を書きました。',
    // 2 巡目の中 2（コードの否定は `!` の後に空白が無い。「できます」は説明）
    '`!user` のときに早期 return するようにしたので、未ログインでも一覧を表示できます。',
    '`!important` を外したので、テーマの色で上書きできます。',
    '`!Array.isArray(x)` の分岐を足し、文字列でも受け取れるようにしたので、古い設定も読み込みできます。',
  ])('passes: %s', (message) => {
    // Break: quoting a rule or a document (「」, "", code, a quote or table line), a conditional ほしい, or an English
    // error text would block every report about these rules.
    expect(stop(message)).toBeNull();
  });

  test('a reply that starts with Please run … is blocked (the start of the text counts as the start of a sentence)', () => {
    // Break: requiring a sentence end before Please misses the reply whose first word is the request.
    expect(stop('Please run `npm test` and paste the output here.').decision).toBe('block');
    expect(stop('Please run `npm test` and paste the output here.').reason).toContain('「Please run」');
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

  test('a transcript over 2 MB is read from its end (the first line of the tail may be cut)', () => {
    // Break: reading the first 2 MB (or the whole file into one JSON line) misses the last reply.
    const file = path.join(dir, 'big.jsonl');
    const pad = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100000) }] } });
    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: '作業して' } })];
    for (let n = 0; n < 25; n += 1) lines.push(pad);
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: '続けて' } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ブラウザで開いてください。' }] } }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    expect(fs.statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(guard.lastAssistantText(file)).toBe('ブラウザで開いてください。');
    expect(run({ cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: file }).decision).toBe('block');
  });
});

describe('input edges (1 巡目の中 6)', () => {
  test('an input that throws in the middle of a check passes with exit 0 and no output', () => {
    // Break: an uncaught error would end the hook with exit 1 and a stack trace instead of letting the question through.
    const input = JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: '業務', question: { toString: 1 } }] } });
    const r = spawnSync(process.execPath, [HOOK], { cwd: dir, input, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  test('spaces around the header and the label, a BOM in the header and a BOM before the input are read', () => {
    // Break: an untrimmed header ( 業務) or label (延長: 全員) is denied as having no class / being below the limit.
    budget.beginRound({ cwd: dir, phase: 'quality', roles: ['integrated-reviewer'] });
    expect(guard.headerClass('  業務：単価  ')).toEqual({ name: '業務', label: '単価' });
    expect(guard.headerClass('﻿費用')).toEqual({ name: '費用', label: '' });
    expect(guard.headerClass('延長:  全員 ')).toEqual({ name: '延長', label: '全員' });
    expect(run(ask(['  その他  ']))).toBeNull();
    expect(run(ask(['延長：  全員']))).toBeNull();
    expect(denied(run(`﻿${JSON.stringify(ask(['方針']))}`))).toBe(true);
  });
});

test('the file header states the purpose (fail-open, not a security boundary) and lists every class', () => {
  // Break: a class added to the hook but not to its header leaves the next reader without the table.
  const head = fs.readFileSync(HOOK, 'utf8').split('\nconst fs')[0];
  expect(head).toContain('意図的な回避は追わない');
  expect(head).toContain('fail-open');
  for (const cls of guard.CLASSES) expect([cls, head.includes(cls)]).toEqual([cls, true]);
});
