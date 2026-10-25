'use strict';

// 3.7.0 (#216, design C1 / C1a): every review and quality-check rule is written once.
// - Markers: a sentence or table row that belongs to one canonical file appears there and
//   nowhere else in the distributed text, except the reviewer briefs that carry a copy so the
//   reviewer can read it (and that copy must be the same text).
// - Old wording: copies the templates, README and summaries used to carry do not come back.
// - Links: relative links in the distributed documents resolve, including SKILL.md -> references/.
// - Size: Claude Code re-attaches only the first ~5,000 tokens of a skill after compaction, so a
//   project skill (and a superpowers skill the harness replaces with an overlay) keeps SKILL.md
//   within 15,000 bytes and 500 lines; an upstream skill shipped as is stays within upstream's
//   20,000 bytes. writing-skills is 26 KB at superpowers v6.4.2 and 16.7 KB at v7.0.1 (3.7.0 PR 1).
// When a rule moves, move its marker here in the same commit.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, normalize } = require('../test/helpers/skill-text');
// describe / it / expect come from vitest globals (see vitest config).

const read = (rel) => normalize(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const SCOPE = ['skills', 'scripts/skill-overlays', 'templates', 'shared', 'stacks', 'configs', 'README.md'];
const TEXT_FILE = /\.(md|template|mdc|toml)$/;

function walk(rel, out, filter) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.posix.join(rel, name), out, filter);
  } else if (filter(rel)) {
    out.push(rel);
  }
  return out;
}
const distributed = () => SCOPE.flatMap((rel) => walk(rel, [], (f) => TEXT_FILE.test(f) || f === 'README.md'));

const QC = 'skills/project/quality-check';
const PROMPTS = `${QC}/references/reviewer-prompts.md`;
const SEVERITY = [`${QC}/SKILL.md`, PROMPTS];

// [marker, files allowed to contain it (the first is the canonical one)]. A marker that starts
// with '#' is a heading and is compared against whole lines; any other marker is a substring.
const MARKERS = [
  ['| 高 | 具体的な入力・手順で起きる誤動作。', SEVERITY],
  ['| 中 | テストの不足（重要な経路でも）、文書の古さ・食い違い、条件付きの軽い不具合（高の分類に当たらないもの） |', SEVERITY],
  ['| 低 | 好み・書き方・将来の拡張 | 出さない |', SEVERITY],
  ['差分より前からある問題で高の分類に当たるものだけは「既存（差分外）」と明記して出す', SEVERITY],
  ['**統合指摘に高指摘（`preexisting` を除く）が残っておらず', [`${QC}/SKILL.md`]],
  ['## hook の完全な契約（無条件ブロック・通過条件・fail-open・worktree）', [`${QC}/references/hook-contract.md`]],
  ['**無条件ブロック**（規則1の候補があるコマンドについて', [`${QC}/references/hook-contract.md`]],
  ['**操作先の移動**（#158）', [`${QC}/references/hook-contract.md`]],
  ['## ハーネスのみ変更の免除', [`${QC}/references/harness-exemption.md`]],
  ['## リリースの差分の免除（release-please のリリースの PR）', [`${QC}/references/harness-exemption.md`]],
  ['## スピード優先モード', [`${QC}/references/speed-mode.md`]],
  ['## 後回しのレビューの実行', [`${QC}/references/deferred-review.md`]],
  ['| 1 | セキュリティエンジニア |', [`${QC}/references/step0-step1.md`]],
  ['| `verification` | 直前サイクルで Step 4 を実行し高指摘が出た場合の修正差分レビュー |', [`${QC}/references/step4-review.md`]],
  ['#### 4-3. サイクルルール（quality-check 全体のサイクル）', [`${QC}/references/step4-review.md`]],
  // Numbers (limits, scope caps, budgets) live in quality-policy.
  ['| レビュー回数上限 | **2巡**', ['shared/documents/quality-policy.md']],
  ['**自動実施の範囲の上限**', ['shared/documents/quality-policy.md']],
  // Test rules, the workflow after approval, and the report form.
  ['| **自動実施** |', ['skills/project/test-recommendation/references/step2-classification.md']],
  ['## Step 4: テストオラクル定義（本スキルの中核）', ['skills/project/test-design/SKILL.md']],
  ['#### 承認後の進め方（正本）', ['shared/documents/development-policy.md']],
  ['**X4 の手順（止まるのは 1 回）**', ['shared/documents/development-policy.md']],
  ['| `deferred_review` |', ['skills/project/_schemas/quality-check-report.schema.md']],
];

// Copies the other documents carried before 3.7.0, and wording the #219 fixes replaced.
const OLD_WORDING = [
  '**Finding severity**',
  '| Role | When | Focus |',
  '### Speed Mode (「スピード優先」)',
  '### Merge Gate',
  '### Quality Check Hook',
  'At most 2 review rounds',
  'X5 an executed E2E still fails after two fix-and-recheck iterations',
  'the same handling as the final quality-check',
  '優先度の基準は最終ゲートと同じ',
  '（次節「対象」参照）',
  '| **検証レビュアー** |',
  '（統合レビュアー・QA・専門家）',
  'SKILL.md 4-1',
  'SKILL.md Step 4-2',
];

const occurs = (text, marker) => (marker.startsWith('#')
  ? text.split('\n').filter((line) => line.trim() === marker).length
  : text.split(marker).length - 1);

describe('one canonical place for each rule (C1)', () => {
  const files = distributed();
  const texts = new Map(files.map((f) => [f, read(f)]));

  it('finds every marker in its canonical file and nowhere else but the allowed copies', () => {
    for (const [marker, allowed] of MARKERS) {
      expect([marker, occurs(texts.get(allowed[0]) || '', marker) > 0]).toEqual([marker, true]);
      const found = files.filter((f) => occurs(texts.get(f), marker) > 0);
      expect([marker, found.filter((f) => !allowed.includes(f))]).toEqual([marker, []]);
    }
  });

  it('keeps the reviewer brief\'s severity table the same text as the canonical one', () => {
    const block = (rel) => {
      const text = read(rel);
      const from = text.indexOf('| 優先度 | 基準 | 扱い |');
      const last = text.indexOf('- 前段工程の高', from);
      expect([rel, from > -1 && last > from]).toEqual([rel, true]);
      return text.slice(from, text.indexOf('\n', last));
    };
    expect(block(PROMPTS)).toBe(block(`${QC}/SKILL.md`));
  });

  it('drops the old copies and the replaced wording', () => {
    // harness-upgrade.md keeps the per-version history, which names the template parts of its time.
    const scope = [...files.filter((f) => f !== 'shared/documents/harness-upgrade.md'), 'lib/quality-check-context.js'];
    const hits = [];
    for (const f of scope) {
      const text = texts.get(f) ?? read(f);
      for (const old of OLD_WORDING) if (text.includes(old)) hits.push(`${f}: ${old}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('the rules kept in each skill body (C1a)', () => {
  // cycle 1 (QA M): only SKILL.md is re-injected after compaction, so the flow, the completion criteria, the stop
  // points and the per-stage reading table must stay in the body - read alone, not joined with references/.
  const BODY = {
    'quality-check': ['## 最重要ルール', '## 実行フロー', '## 段ごとに読む参照ファイル', '## 完了条件', '## 途中で止まる場面（例外）',
      '途中で止まるのは `documents/development/development-policy.md` §1.0「承認後の進め方」の例外だけ'],
    'test-recommendation': ['## 実行フロー', '## 段ごとに読む参照ファイル', '## 止まる条件（例外）', '## 完了条件',
      '途中で区切るのは `documents/development/development-policy.md` §1.0「承認後の進め方」の例外だけ'],
    'lint-scaffolding': ['## 最重要ルール', '## 実行フロー', '## 段ごとに読むファイル', '## 完了条件', '## 確認の場面と進め方（毎回守る）'],
    'test-design': ['## 実行フロー', '## 段ごとに読むファイル', '## 完了条件', '## 確認の場面と進め方（毎回守る）'],
  };

  it.each(Object.keys(BODY))('%s keeps its every-time rules in SKILL.md itself', (skill) => {
    const body = read(`skills/project/${skill}/SKILL.md`);
    const missing = BODY[skill].filter((marker) => (marker.startsWith('## ')
      ? !body.split('\n').some((line) => line.trim() === marker)
      : !body.includes(marker)));
    expect(missing).toEqual([]);
  });

  it('the stop-point lists leave the common exceptions (X6, X8) open', () => {
    expect(read('skills/project/quality-check/SKILL.md')).toContain('X6（原因不明）・X8（AI が用意できないもの）などの共通の例外は、どの段でも当たる');
    expect(read('skills/project/test-recommendation/SKILL.md')).toContain('X6・X8 などの共通の例外は、どの段でも当たる');
  });

  it('a supplement file never overrides the skill (cycle 1 M)', () => {
    for (const skill of Object.keys(BODY)) {
      expect([skill, read(`skills/project/${skill}/SKILL.md`).includes('食い違えば本スキルが優先する')]).toEqual([skill, true]);
    }
  });

  it('the always-read summaries keep the speed-mode exclusions and the X2 / X3 boundaries (cycle 1 security H)', () => {
    for (const file of ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template', 'templates/cursorrules.template']) {
      const text = read(file);
      expect([file, text.includes('Never for changes to authentication/authorization, billing/payments, database migrations or the harness itself')]).toEqual([file, true]);
      expect([file, text.includes('X2 (release) includes a merge that by itself releases, publishes or deploys to production')]).toEqual([file, true]);
      expect([file, text.includes('pushing a fix for an undisclosed vulnerability to a public repository')]).toEqual([file, true]);
    }
    expect(read('skills/project/quality-check/SKILL.md')).toContain('認証・認可、課金・決済、DB マイグレーション、ハーネス自体の変更には使わない');
    expect(read('shared/documents/development-policy.md')).toContain('認証・認可、課金・決済、DB マイグレーション、ハーネス自体の変更には使わない');
  });

  it('no "<skill> SKILL.md「…」" reference names a section that left the body (cycle 1 M)', () => {
    const heads = (skill) => read(`skills/project/${skill}/SKILL.md`).split('\n').filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#+ /, '').trim());
    const stale = [];
    for (const file of distributed()) {
      for (const m of read(file).matchAll(/`?(quality-check|test-recommendation|lint-scaffolding|test-design)`? SKILL\.md(?:\s*Step\s*[0-9-]+)?\s*[「『]([^」』]+)[」』]/g)) {
        if (!heads(m[1]).some((h) => h.includes(m[2]))) stale.push(`${file}: ${m[0]}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe('links and references (C1a)', () => {
  // Fenced blocks and code spans hold examples, not links.
  const links = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    .match(/\]\(([^)\s]+)\)/g)?.map((m) => m.slice(2, -1)) ?? [];

  it('resolves every relative link in the distributed documents', () => {
    const broken = [];
    for (const f of distributed().filter((rel) => !rel.startsWith('scripts/skill-overlays/'))) {
      for (const target of links(read(f))) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const file = target.split('#')[0];
        if (!fs.existsSync(path.join(ROOT, path.dirname(f), file))) broken.push(`${f} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('links every reference file from its skill body, and every skill names the adopter supplement file (C3k)', () => {
    const dir = path.join(ROOT, 'skills/project');
    for (const name of fs.readdirSync(dir)) {
      if (!fs.existsSync(path.join(dir, name, 'SKILL.md'))) continue;
      const refs = path.join(dir, name, 'references');
      const body = read(`skills/project/${name}/SKILL.md`);
      for (const ref of fs.existsSync(refs) ? fs.readdirSync(refs) : []) {
        expect([name, ref, body.includes(`](references/${ref})`)]).toEqual([name, ref, true]);
      }
      expect([name, body.includes(`導入先の補足ファイル \`documents/development/project/${name}.md\` があれば、その段で読む。`)]).toEqual([name, true]);
    }
  });
});

describe('skill size (C1a)', () => {
  const size = (rel) => {
    const text = read(rel);
    return { bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) };
  };
  const overlaid = fs.readdirSync(path.join(ROOT, 'scripts/skill-overlays'))
    .filter((name) => fs.existsSync(path.join(ROOT, 'scripts/skill-overlays', name, 'SKILL.md')));

  it('keeps each project skill and each overlay-replaced superpowers skill within 15,000 bytes and 500 lines', () => {
    const over = [];
    const targets = [
      ...fs.readdirSync(path.join(ROOT, 'skills/project')).filter((n) => fs.existsSync(path.join(ROOT, 'skills/project', n, 'SKILL.md'))).map((n) => `skills/project/${n}/SKILL.md`),
      ...overlaid.map((n) => `skills/superpowers/${n}/SKILL.md`),
    ];
    for (const rel of targets) {
      const { bytes, lines } = size(rel);
      if (bytes > 15000 || lines > 500) over.push(`${rel}: ${bytes} bytes, ${lines} lines`);
    }
    expect(over).toEqual([]);
  });

  it('keeps each upstream superpowers skill shipped as is within upstream\'s 20,000 bytes', () => {
    const over = [];
    for (const name of fs.readdirSync(path.join(ROOT, 'skills/superpowers'))) {
      const rel = `skills/superpowers/${name}/SKILL.md`;
      if (overlaid.includes(name) || !fs.existsSync(path.join(ROOT, rel))) continue;
      const { bytes } = size(rel);
      if (bytes > 20000) over.push(`${rel}: ${bytes} bytes`);
    }
    expect(over).toEqual([]);
  });
});
