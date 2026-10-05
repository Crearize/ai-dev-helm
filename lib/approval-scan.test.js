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
  /(ユーザー|オーナー|利用者)(に|へ|の|と)[^。]{0,20}(確認|承認|判断|合意|相談|聞|尋ね|選ば|返答|報告し、判断)/, /判断を仰/, /と合意/,
  /ユーザーに(提示|促)/, /エスカレーション/, /ユーザー判断/,
  /\b(ask|check with|confirm with|wait for|discuss with)\b[^.]{0,30}\b(user|owner|human partner)\b/i,
  /\breport[^.]{0,40}\bto the (user|owner)\b/i, /human partner's (permission|call)/i, /\bescalat/i,
  /ask for (direction|clarification)/i, /user (explicitly )?approves/i, /Report material changes/i, /stop and ask/i,
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
  [SUPERPOWERS('writing-plans'), 'the user approved it', 'before approval: precondition of the plan', 2],
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
  [SUPERPOWERS('using-superpowers'), 'ask again merely because a skill was loaded', 'negation', 2],
  [SUPERPOWERS('writing-plans'), 'Do not ask the user to select an execution mechanism', 'negation', 2],
  [SUPERPOWERS('subagent-driven-development'), 'ask the controller (never the user)', 'negation', 2],
  [SUPERPOWERS('subagent-driven-development'), 'the report to the user follows the final-message rule', 'final message, not a stop', 2],
  [TEMPLATES, 'go into the final message, not a mid-way stop', 'negation', 3],
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
  [TR, '対象領域の行が無い、または「見送り回数」が 0', 'reference to a recorded decline'],
  [TR, '恒久的に再提案しないというユーザー判断の記録', 'reference to a recorded decision'],
  [file('templates/test-recommendation-ledger.md.template'), '恒久的に再提案しないというユーザー判断の記録', 'reference to a recorded decision'],
  [SCHEMA, '`applied`: 承認済み候補を反', 'self-improvement record'],
  [SCHEMA, 'ユーザー判断と適用結果', 'self-improvement record'],
  [QPOLICY, 'ユーザーと合意しない', 'negation'],
  [README, 'ユーザーとの合意は求めません', 'negation'],
  // X1: quality-check review limit, stagnation, structural stagnation (and production)
  [SUPERPOWERS('executing-plans'), 'If the quality-check review limit is reached and the user approves', 'X1', 2],
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
  [file('skills/project/generate-docs/SKILL.md'), 'ユーザーに確認する。デフォルト提案として', 'X2: release notes'],
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
    lines.forEach((line, index) => {
      if (PATTERNS.some((pattern) => pattern.test(line))) found.push({ file, line: index + 1, text: line });
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
