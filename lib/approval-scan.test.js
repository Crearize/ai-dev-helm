// #188: after the design approval the AI proceeds without asking again and reports only the
// deviations from the design at the end (development-policy §1.0 「承認後の進め方」). This scan
// pins that: every place in the distributed text that makes the AI ask, stop or wait must be
// listed below with the stop exception (X1-X8) or phase it belongs to. Adding a new stop point
// means adding it here, mapped to an exception - or not adding it.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['skills', 'scripts/skill-overlays', 'templates', 'shared', 'stacks', 'configs', 'README.md'];
const TEXT_FILE = /\.(md|template|mdc|toml)$/;

const PATTERNS = [
  /ユーザーに確認/, /ユーザーの(明示)?承認/, /判断を仰/, /と合意/, /ユーザーに提示/, /ユーザーに促/, /エスカレーション/,
  /ask your human partner/i, /ask the user/i, /human partner's (permission|call)/i, /discuss with your human partner/i,
  /\bescalat/i, /ask for direction/i, /ask for clarification/i, /user (explicitly )?approves/i,
];

// [file pattern, snippet in the matching line, why it may stay]
const SUPERPOWERS = (skill) => new RegExp(`^(skills/superpowers|scripts/skill-overlays)/${skill}/`);
const TEMPLATES = /^templates\/(CLAUDE\.md|AGENTS\.md|cursorrules)\.template$/;
const ALLOWED = [
  // Before the design approval (the Design Gate itself and design-time tools)
  [SUPERPOWERS('brainstorming'), 'Ask the user to review the design', 'before approval: Design Gate'],
  [/^skills\/superpowers\/brainstorming\/visual-companion\.md$/, 'Start AFTER the user approves the companion', 'before approval: design mockups'],
  [/^skills\/superpowers\/brainstorming\/visual-companion\.md$/, "you don't need to ask the user", 'negation'],
  [SUPERPOWERS('writing-plans'), 'the user approved it', 'before approval: precondition of the plan'],
  [TEMPLATES, 'Stop until the user explicitly approves', 'before approval: Design Gate'],
  [TEMPLATES, 'Before the design is approved, ask the user only when', 'before approval'],
  [/^shared\/documents\/development-policy\.md$/, 'Ask the user only when', 'the rule that limits it to before approval'],
  [/^shared\/documents\/quality-policy\.md$/, '設計レビューの超過はユーザーにエスカレーション', 'before approval / X4: design review limit'],
  // Statements that say NOT to ask
  [SUPERPOWERS('brainstorming'), 'Once the user approves, do not ask again', 'negation'],
  [SUPERPOWERS('executing-plans'), 'do not ask the user again after the design approval', 'negation'],
  [SUPERPOWERS('receiving-code-review'), 'do not ask the user; record what stays unresolved', 'negation'],
  [SUPERPOWERS('using-superpowers'), 'ask again merely because a skill was loaded', 'negation'],
  [SUPERPOWERS('writing-plans'), 'Do not ask the user to select an execution mechanism', 'negation'],
  [TEMPLATES, 'go into the final message, not a mid-way stop', 'negation'],
  [/^shared\/documents\/development-policy\.md$/, 'これらの前・途中でユーザーに確認しない', 'negation'],
  [/^skills\/project\/feature-documentation\/SKILL\.md$/, '場所はユーザーに確認しない', 'negation'],
  [/^skills\/project\/feature-documentation\/SKILL\.md$/, 'ユーザーに確認せずに確定する', 'negation'],
  [/^skills\/project\/implementation-report\/SKILL\.md$/, 'ユーザーに促さない', 'negation'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, 'ユーザーに促して止まらない', 'negation'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, 'ユーザーに確認しない', 'negation'],
  [/^skills\/project\/test-recommendation\/SKILL\.md$/, 'ユーザーと合意せずに', 'negation'],
  [/^skills\/project\/lint-scaffolding\/SKILL\.md$/, '途中でユーザーに確認しない', 'negation'],
  [/^skills\/project\/test-recommendation\/SKILL\.md$/, 'ユーザーと合意しない', 'negation'],
  [/^shared\/documents\/quality-policy\.md$/, 'ユーザーと合意しない', 'negation'],
  // X1: quality-check review limit, stagnation, structural stagnation
  [SUPERPOWERS('executing-plans'), 'If the quality-check review limit is reached and the user approves', 'X1'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, '上限到達** → ユーザーに判断を仰ぐ', 'X1'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, '構造的停滞**', 'X1'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, 'ユーザーの明示承認なしにフラグを作成しない', 'X1'],
  [/^skills\/project\/_schemas\/quality-check-report\.schema\.md$/, 'サイクル上限到達・停滞でサイクルを打ち切った', 'X1 record'],
  [/^skills\/project\/_schemas\/quality-check-report\.schema\.md$/, 'サイクル上限到達または停滞でユーザーに判断を仰ぎ', 'X1 record'],
  [/^skills\/project\/_schemas\/quality-check-report\.schema\.md$/, '「ユーザーの明示承認を得た」ことの記録', 'X1 record'],
  [/^shared\/documents\/quality-policy\.md$/, '高指摘を記録してユーザーに判断を仰ぐ', 'X1'],
  [/^shared\/documents\/quality-policy\.md$/, 'ユーザーの明示承認なしに `.quality-check-passed`', 'X1'],
  [/^README\.md$/, '構造的停滞としてユーザー', 'X1 summary'],
  [/^README\.md$/, '上限到達・停滞時はユーザーに判断を仰ぐ', 'X1 summary'],
  // X2: release
  [/^skills\/project\/generate-docs\/SKILL\.md$/, 'ユーザーに確認する', 'X2: release notes'],
  [/^skills\/project\/generate-docs\/SKILL\.md$/, 'ユーザーの承認後にのみ、CHANGELOG.md', 'X2: release notes'],
  // X3: irreversible operations on others' work
  [/^skills\/project\/worktree-parallel\/SKILL\.md$/, '既存 worktree の完了・削除を待つか、ユーザーに判断を仰ぐ', 'X3: removing other work'],
  // X5: executed E2E still failing
  [/^skills\/project\/test-recommendation\/SKILL\.md$/, '2 回で緑にならない場合はユーザーに判断を仰ぐ', 'X5'],
  // X7: broken state, ledger or harness settings
  [/^skills\/project\/test-recommendation\/SKILL\.md$/, 'ユーザーに提示して修復を仰ぐ', 'X7'],
  [/^skills\/project\/quality-check\/SKILL\.md$/, '最も厳しい値を採用してユーザーにエスカレーション', 'X7'],
  [/^shared\/documents\/quality-policy\.md$/, '食い違いの事実をユーザーにエスカレーション', 'X7'],
  [/^shared\/documents\/quality-policy\.md$/, 'ユーザーにエスカレーションして是正を求め', 'X7'],
  // Not a stop point (examples and quotations)
  [/^skills\/superpowers\/writing-skills\/testing-skills-with-subagents\.md$/, "I'd ask your human partner", 'example in a pressure test'],
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

test('no allow-list entry is stale', () => {
  const all = hits();
  const stale = ALLOWED.filter(([file, snippet]) => !all.some((hit) => file.test(hit.file) && hit.text.includes(snippet)))
    .map(([file, snippet]) => `${file} :: ${snippet}`);
  expect(stale).toEqual([]);
});
