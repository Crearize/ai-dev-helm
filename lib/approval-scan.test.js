// #188: after the design approval the AI proceeds without asking again and reports only the
// deviations from the design at the end (development-policy §1.0 「承認後の進め方」). This scan
// pins that: every place in the distributed text that makes the AI ask, stop or wait must be
// listed below with the stop exception (X1-X8) or phase it belongs to. Adding a new stop point
// means adding it here, mapped to an exception - or not adding it.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['skills', 'scripts/skill-overlays', 'templates', 'shared', 'stacks', 'configs', 'README.md'];
const TEXT_FILE = /\.(md|template|mdc|toml)$|^templates\/hooks\/.*\.cjs$/;

const PATTERNS = [
  /(ユーザー|オーナー|利用者)(に|へ|の|と|が|から)[^。]{0,20}(確認|承認|判断|合意|相談|聞|尋ね|選|返答|返事|問い合わせ|報告し、判断)/,
  /\b(user|owner)'s (approval|decision|confirmation)\b/i, /\bwait for (approval|confirmation)\b/i, /\blet the (user|owner) decide\b/i, /判断を仰/, /と合意/,
  /ユーザーに(提示|促)/, /エスカレーション/, /ユーザー判断/,
  /\b(ask|check with|confirm with|wait for|discuss with)\b[^.]{0,30}\b(user|owner|human partner)\b/i,
  /\breport[^.]{0,40}\bto the (user|owner)\b/i, /human partner's (permission|call)/i, /\bescalat/i,
  /ask for (direction|clarification)/i, /user (explicitly )?approves/i, /Report material changes/i, /stop and ask/i,
  // #199 (M4): stops and repeated questions that name no user or owner.
  /\bask (again|about)\b/i, /\bbefore stopping\b/i, /聞き直す|を聞く|(?<![がは・])止まる/,
];

// [file pattern, snippet in the matching line, why it may stay, expected number of matching lines (default 1)]
const SUPERPOWERS = (skill) => new RegExp(`^(skills/superpowers|scripts/skill-overlays)/${skill}/`);
const TEMPLATES = /^templates\/(CLAUDE\.md|AGENTS\.md|cursorrules)\.template$/;
const file = (rel) => new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);
const QC = file('skills/project/quality-check/SKILL.md');
const TR = file('skills/project/test-recommendation/SKILL.md');
const SCHEMA = file('skills/project/_schemas/quality-check-report.schema.md');
const POLICY = file('shared/documents/development-policy.md');
const QPOLICY = file('shared/documents/quality-policy.md');
const RUNTIME = file('shared/documents/harness-runtime.md');
const README = file('README.md');
const HOOK = file('templates/hooks/review-budget.cjs');
const ALLOWED = [
  // Before the design approval (the Design Gate itself and design-time tools)
  [SUPERPOWERS('brainstorming'), 'Ask the user to review the design', 'before approval: Design Gate', 2],
  [SUPERPOWERS('brainstorming'), 'ask the owner for approval only when a review limit is reached', 'before approval / X1: design review limit', 2],
  [file('skills/superpowers/brainstorming/visual-companion.md'), 'Start AFTER the user approves the companion', 'before approval: design mockups'],
  [TEMPLATES, 'Stop until the user explicitly approves', 'before approval: Design Gate', 3],
  [TEMPLATES, 'Before the design is approved, ask the user only when', 'before approval', 3],
  [POLICY, '設計レビュー → ユーザーへのレビュー依頼と承認', 'before approval: Design Gate'],
  [POLICY, 'Ask the user only when', 'the rule that limits it to before approval'],
  [QPOLICY, '設計レビューの超過はユーザーにエスカレーション', 'before approval / X4: design review limit'],
  [file('shared/documents/harness-upgrade.md'), '設計とレビュー結果をユーザーへ 1 通で示し承認まで止まる', 'before approval: Design Gate'],
  [README, 'ユーザーへのレビュー依頼と承認（Design Gate）', 'before approval: Design Gate'],
  [README, 'Design Gate（設計レビュー → ユーザーへのレビュー依頼と承認）', 'before approval: Design Gate'],
  // Statements that say NOT to ask, or that only refer to a recorded decision
  [file('skills/superpowers/brainstorming/visual-companion.md'), "you don't need to ask the user", 'negation'],
  [SUPERPOWERS('brainstorming'), 'Once the user approves, do not ask again', 'negation', 2],
  [SUPERPOWERS('executing-plans'), 'do not ask the user again after the design approval', 'negation', 2],
  [SUPERPOWERS('receiving-code-review'), 'do not ask the user; record what stays unresolved', 'negation', 2],
  [SUPERPOWERS('writing-plans'), 'Do not ask the user to select an execution mechanism', 'negation', 2],
  [SUPERPOWERS('subagent-driven-development'), 'ask the controller (never the user)', 'negation', 2],
  [SUPERPOWERS('subagent-driven-development'), 'the report to the user follows the final-message rule', 'final message, not a stop', 2],
  [POLICY, 'これらの前・途中でユーザーに確認しない', 'negation'],
  [file('skills/project/feature-documentation/SKILL.md'), 'ユーザーには確認しない', 'negation', 2],
  [file('skills/project/feature-documentation/SKILL.md'), '場所はユーザーに確認しない', 'negation'],
  [file('skills/project/feature-documentation/SKILL.md'), 'ユーザーに確認せずに確定する', 'negation'],
  [file('skills/project/feature-documentation/SKILL.md'), 'ユーザーには途中で確認しない', 'negation'],
  [file('skills/project/implementation-report/SKILL.md'), 'ユーザーに促さない', 'negation'],
  [file('skills/project/implementation-report/SKILL.md'), '理由: [ユーザーの判断根拠]', 'X1 record'],
  [file('skills/project/lint-scaffolding/SKILL.md'), '途中でユーザーに確認しない', 'negation'],
  [file('skills/project/lint-scaffolding/SKILL.md'), '決定済みの行はユーザーに再確認せず引き継ぐ', 'negation (setup task)'],
  [file('skills/project/test-design/SKILL.md'), '設計の承認後はユーザーに途中で確認しない', 'negation'],
  [QC, 'ユーザーに促して止まらない', 'negation'],
  [QC, '（ユーザーに確認しない）', 'negation'],
  [QC, 'ユーザーへの通知・確認はしない', 'negation'],
  [TR, 'ユーザーと合意せずに', 'negation'],
  [TR, 'ユーザーと合意しない', 'negation'],
  [TR, 'ユーザーに途中で確認しない', 'negation'],
  [TR, '同じ対象を**ユーザーが**見送った記録が無い', 'reference to a recorded decline'],
  [TR, '恒久的に再提案しないというユーザー判断の記録', 'reference to a recorded decision'],
  [file('templates/test-recommendation-ledger.md.template'), '恒久的に再提案しないというユーザー判断の記録', 'reference to a recorded decision'],
  [SCHEMA, '`applied`: 承認済み候補を反', 'self-improvement record'],
  [SCHEMA, 'ユーザー判断と適用結果', 'self-improvement record'],
  [QPOLICY, 'ユーザーと合意しない', 'negation'],
  [README, 'ユーザーとの合意は求めません', 'negation'],
  // X1: quality-check review limit, stagnation, structural stagnation (and production)
  [SUPERPOWERS('executing-plans'), 'If that limit is reached and the user approves exceeding it', 'X1', 2],
  [HOOK, 'OWNER_STOP_PHASES wait for the owner', 'X1 (code comment)'],
  [QC, '上限到達 or 停滞 → ユーザー判断', 'X1'],
  [QC, '上限到達** → ユーザーに判断を仰ぐ', 'X1'],
  [QC, '構造的停滞**（1サイクルで同一クラスの高指摘', 'X1'],
  [QC, 'ユーザーの明示承認なしにフラグを作成しない', 'X1'],
  [QC, '上限到達・停滞・構造的停滞時はユーザー判断', 'X1'],
  [QC, 'オーナーの承認後だけ `review-budget extend` を使う', 'X1'],
  [SCHEMA, 'サイクル上限到達・停滞でサイクルを打ち切った', 'X1 record'],
  [SCHEMA, 'サイクル上限到達または停滞でユーザーに判断を仰ぎ', 'X1 record'],
  [SCHEMA, '「ユーザーの明示承認を得た」ことの記録', 'X1 record'],
  [QPOLICY, '高指摘を記録してユーザーに判断を仰ぐ', 'X1'],
  [QPOLICY, 'ユーザーの明示承認なしに `.quality-check-passed`', 'X1'],
  [RUNTIME, '残存事項をオーナーに報告し、判断を待つ', 'X1'],
  [RUNTIME, 'オーナーの承認の文を 10〜500 文字で引用', 'X1 / X7'],
  [file('shared/documents/harness-upgrade.md'), 'オーナーの承認後にエージェントが `review-budget extend`', 'X1'],
  [HOOK, 'report the remaining findings to the owner', 'X1'],
  [README, '構造的停滞（同一クラスの高指摘が閾値以上）→ ユーザー判断', 'X1 summary'],
  [README, '上限到達 / その他の停滞 → ユーザー判断', 'X1 summary'],
  [README, '構造的停滞としてユーザー', 'X1 summary'],
  [README, '上限到達・停滞時はユーザーに判断を仰ぐ', 'X1 summary'],
  // X2: release
  [file('skills/project/generate-docs/SKILL.md'), '以下を出力してユーザーに確認する', 'X2: release notes'],
  [file('skills/project/generate-docs/SKILL.md'), 'ユーザーの承認後にのみ、CHANGELOG.md', 'X2: release notes'],
  // X3: irreversible operations on others' work
  [file('skills/project/worktree-parallel/SKILL.md'), '既存 worktree の完了・削除を待つか、ユーザーに判断を仰ぐ', 'X3: removing other work'],
  // X5: executed E2E still failing
  [TR, '2 回で緑にならない場合はユーザーに判断を仰ぐ', 'X5'],
  // X6: unknown cause or only a temporary workaround
  [TEMPLATES, 'If a durable fix is unclear, stop and ask (exception X6)', 'X6', 3],
  // X7: broken state, ledger or harness settings
  [TR, 'ユーザーに提示して修復を仰ぐ', 'X7'],
  [QC, '最も厳しい値を採用してユーザーにエスカレーション', 'X7'],
  [QPOLICY, '食い違いの事実をユーザーにエスカレーション', 'X7'],
  [QPOLICY, 'ユーザーにエスカレーションして是正を求め', 'X7: duplicated or conflicting override keys', 2],
  [HOOK, 'If it persists, report it to the owner and wait', 'X7: stale lock'],
  [HOOK, 'Do not delete or edit it; report it with the output of status', 'X7: invalid state'],
  // Sentence-level entries (the scan splits lines into sentences)
  [SUPERPOWERS('brainstorming'), 'Start implementation only after the user explicitly approves', 'before approval: Design Gate', 2],
  [SUPERPOWERS('brainstorming'), 'ask the user before any further review round', 'before approval: Design Gate', 2],
  [SUPERPOWERS('brainstorming'), 'If the user approves exceeding the review limit', 'before approval / X1: design review limit', 2],
  [SUPERPOWERS('writing-plans'), 'Only when the user has already approved exceeding it', 'X1: only an existing approval', 2],
  [SUPERPOWERS('using-superpowers'), 'After the design approval, "ask your human partner" in an upstream skill means', 'the reinterpretation rule', 2],
  [TEMPLATES, '"ask your human partner" after approval means', 'the reinterpretation rule', 3],
  [TEMPLATES, 'Do not ask the user to run commands or do operations', 'negation', 3],
  [POLICY, 'ユーザーへの確認は纏める', 'before approval: batch the design questions'],
  [POLICY, '上流スキル（`superpowers:*`）の「ask / discuss with your human partner」も', 'the reinterpretation rule'],
  [RUNTIME, '上限を超えるのは、オーナーが会話で明示に承認した後だけ', 'X1'],
  [RUNTIME, 'ユーザーにコマンドの実行や状態の確認・退避を頼まない', 'negation'],
  [RUNTIME, '`status` の出力とパスをオーナーに報告して判断を待つ', 'X7: invalid state'],
  [file('shared/documents/harness-upgrade.md'), '`--baseline` は利用者が選んだ比較元', 'not a stop'],
  [QPOLICY, 'ユーザーが見送った記録が無いものは確認なしで実施する', 'reference to a recorded decline'],
  [QPOLICY, '①残存指摘を受容して通す', 'X1'],
  [QPOLICY, '設計とレビュー結果をユーザーへ 1 通で示し承認を得る', 'before approval: Design Gate'],
  [README, 'オーナーが会話で承認した後に限り', 'X1'],
  [TR, '都度ユーザーの明示選択が必要', 'X5'],
  [TR, '恒久的に不要とユーザーが判断 — 再提案しない', 'recorded decision'],
  [TR, '（ユーザーが恒久的に不要と判断したもの）', 'recorded decision'],
  [TR, 'ユーザーの判断として扱う', 'reference to a recorded decline'],
  [TR, 'ユーザーが見送ったものとして確認に回す', 'reference to a recorded decline'],
  [file('templates/test-recommendation-ledger.md.template'), '恒久的に不要とユーザーが判断 — 再提案しない', 'recorded decision'],
  [SCHEMA, 'ユーザーが示した判断根拠をそのまま記録する', 'X1 record'],
  [file('skills/project/generate-docs/SKILL.md'), 'ユーザーに確認する。', 'X2: release notes'],
  // The merge: X2 first, then a merge that waits because deviations from the design were recorded (final message)
  [SUPERPOWERS('finishing-a-development-branch'), "if the project's rules require the user's approval for the merge", 'X2', 2],
  [SUPERPOWERS('finishing-a-development-branch'), "create the quality-check flag only after the user's confirmation", 'final message: merge waits for deviations (§1.0-1)', 2],
  [HOOK, "<the owner's approval, quoted>", 'X1: extend after the owner approved'],
  [HOOK, "quote the owner's approval in 10 to 500 characters", 'X1: extend after the owner approved'],
  [HOOK, "extend only after reaching it and getting the owner's approval", 'X1: extend after the owner approved'],
  // #199 (M4): stops and repeated questions that name no user or owner
  [SUPERPOWERS('brainstorming'), 'delete the flag, then ask about merging with it', 'final message: merge waits for deviations (§1.0-1, 3)', 2],
  [SUPERPOWERS('finishing-a-development-branch'), 'otherwise rebuild the list and ask again', 'X2: promotion range (§1.0-8)', 2],
  [SUPERPOWERS('receiving-code-review'), 'WRONG: Implement 1,2,3,6 now, ask about 4,5 later', 'example of what not to do', 2],
  [SUPERPOWERS('using-git-worktrees'), 'do not ask again for an already authorized workspace action', 'negation', 2],
  [SUPERPOWERS('using-superpowers'), 'do not restart an approved design or ask again', 'negation', 2],
  [TEMPLATES, '- After approval: the approval covers planning', 'negation (do not ask again)', 3],
  [TEMPLATES, 'After approval, do not ask again: the approval covers the spec update', 'negation', 3],
  [TEMPLATES, 'After the design is approved, do not ask again.', 'negation', 3],
  [POLICY, 'ほかの工程（PR・quality-check）を済ませたうえでマージの前に止まる', 'final message: merge waits for deviations (§1.0-1)'],
  [POLICY, '**途中で止まるのは次の例外だけ**', 'the rule that closes the stop exceptions'],
  [POLICY, '止まるのは quality-check と制作物の最終品質レビュー', 'X1 / before approval / X4'],
  [POLICY, '**X4 の手順（止まるのは 1 回）**', 'X4'],
  [POLICY, '返答が来なければその状態で止まる', 'final message: order B waits for the answer'],
  [POLICY, 'その一覧と短縮 SHA を示して OK を聞く', 'X2: promotion range (§1.0-8)'],
  [POLICY, '一覧を作り直して聞き直す', 'X2: promotion range (§1.0-8)'],
  [README, '途中で止まるのは閉じた例外だけ', 'the rule that closes the stop exceptions'],
  // Not a stop point (examples and quotations)
  [file('skills/superpowers/writing-skills/testing-skills-with-subagents.md'), "I'd ask your human partner", 'example in a pressure test'],
];

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.posix.join(rel, name), out);
  } else if (TEXT_FILE.test(rel) || rel === 'README.md') {
    out.push(rel);
  }
}

function hits() {
  const files = [];
  for (const rel of SCOPE) walk(rel, files);
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    // Sentence by sentence: a stop instruction appended to an allowed sentence on the same line is still caught.
    lines.forEach((line, index) => {
      for (const sentence of line.split(/(?<=。)|(?<=[.!?])\s+/)) {
        if (PATTERNS.some((pattern) => pattern.test(sentence))) found.push({ file, line: index + 1, text: sentence });
      }
    });
  }
  return found;
}

const allowedFor = (hit) => ALLOWED.filter(([file, snippet]) => file.test(hit.file) && hit.text.includes(snippet));

test('every ask/stop point in the distributed text is mapped to a stop exception (#188)', () => {
  const unmapped = hits().filter((hit) => allowedFor(hit).length === 0)
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text.trim().slice(0, 160)}`);
  expect(unmapped).toEqual([]);
});

test('every allow-list entry matches exactly its expected number of lines (no stale entry, no piggybacking)', () => {
  const all = hits();
  const wrong = ALLOWED.map(([file, snippet, , count = 1]) => [file, snippet, count, all.filter((hit) => file.test(hit.file) && hit.text.includes(snippet)).length])
    .filter(([, , expected, actual]) => expected !== actual)
    .map(([file, snippet, expected, actual]) => `${file} :: ${snippet} expected ${expected} got ${actual}`);
  expect(wrong).toEqual([]);
});
