'use strict';

// Guards the review roster introduced in #131: the distributed harness
// documents (templates, skill, schema, policies, README) must all describe
// the same roster - integrated reviewer + falsification QA + at most one
// specialist (Security > Requirements > Performance) + verification reviewer
// from cycle 2 - so that a partial edit cannot leave one distribution
// describing the pre-#131 six-role parallel review.
//
// The checks are fixed-string / structural on purpose: they pin the
// normative text (SKILL.md Step 1 / Step 4) and the copies that consumers
// sync (templates), and they reject the old vocabulary wherever it could
// reappear. When the roster changes, change the expectations here in the
// same commit.

const fs = require('node:fs');
const path = require('node:path');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
// Normalise CRLF so an autocrlf checkout on Windows sees the same text.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TEMPLATES = [
  'templates/CLAUDE.md.template',
  'templates/AGENTS.md.template',
  'templates/cursorrules.template',
];
const SKILL = 'skills/project/quality-check/SKILL.md';
const SCHEMA = 'skills/project/_schemas/quality-check-report.schema.md';
const README = 'README.md';
const QUALITY_POLICY = 'shared/documents/quality-policy.md';
const QUICK_CHECKLIST = 'shared/documents/quick-checklist.md';
const DEVELOPMENT_POLICY = 'shared/documents/development-policy.md';

// Every file that was rewritten for #131 and could carry the old wording.
const ALL_ROSTER_FILES = [
  ...TEMPLATES,
  SKILL,
  SCHEMA,
  README,
  QUALITY_POLICY,
  DEVELOPMENT_POLICY,
  QUICK_CHECKLIST,
  'shared/documents/static-check-standard.md',
  'shared/review-guides/review-performance.md',
  'shared/review-guides/review-requirements.md',
  'skills/project/implementation-report/SKILL.md',
  'skills/project/lint-scaffolding/SKILL.md',
  'skills/project/lint-scaffolding/coverage-map-template.md',
  'skills/project/test-design/SKILL.md',
  'skills/project/test-recommendation/SKILL.md',
  'templates/PULL_REQUEST_TEMPLATE.md',
  'templates/hooks/quality-gate.cjs',
];

// The closed set of role names (SKILL.md Step 4 役割定義 / schema personas).
const ROLES = [
  '統合レビュアー',
  'QAエンジニア（ファルシフィケーション型）',
  'セキュリティエンジニア',
  '要件・仕様整合性レビュアー',
  'パフォーマンスエンジニア',
  '検証レビュアー',
];
const CONCERNS = ['design', 'security', 'performance', 'requirements', 'docs', 'falsification'];
const SPECIALIST_PRIORITY = 'Security > Requirements > Performance';

// Expected Role / When / Focus cells of the template roster table. `when` is
// either the exact cell text or a RegExp the cell must match.
const EXPECTED_ROSTER_ROWS = [
  {
    role: 'Integrated Reviewer',
    when: 'Every cycle that runs Step 4',
    focus: 'Design and maintainability first (SOLID/DRY, layer responsibilities, dependencies, whole-change consistency, side effects), then a mandatory checklist pass on security, performance, requirements alignment and documentation consistency - each concern reported explicitly',
  },
  {
    role: 'Falsification QA',
    when: 'Any code change (tests and config included; any path, regardless of area - docs-only and declarative infra-only diffs excluded)',
    focus: 'Inputs and scenarios that prove the implementation wrong, test-oracle validity, edge cases, error handling',
  },
  {
    role: `Specialist (at most one: ${SPECIALIST_PRIORITY})`,
    when: /^Security: .*lockfile-only updates; gate control plane, harness config, CI workflows or dependency files trigger Security even in a docs-only diff\. Requirements: .* Performance: /,
    focus: 'Single-concern deep dive with its review guide; concerns not dispatched become emphasized concerns for the integrated reviewer',
  },
  {
    role: 'Verification Reviewer',
    when: 'Cycles 2+ (joined by Falsification QA when the fix diff touches production code under a security trigger)',
    focus: 'Checks the fix diff against the consolidated findings list and hunts new High findings',
  },
];

// Old vocabulary. Whitespace-insensitive and case-insensitive where Latin,
// because the documents write "6 ペルソナ" / "Multi-persona" as naturally as
// "6ペルソナ" / "Multi-Persona". `personas` / `persona_selection_basis` (report
// field names) do not match any of these.
const OBSOLETE_WORDING = [
  /multi[-\s]?persona/i,
  /6\s*-?\s*personas?\b/i,
  /ペルソナ/,
  /適用判定表/,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rosterTable(content) {
  const header = '| Role | When | Focus |';
  const first = content.indexOf(header);
  expect(first, 'roster table header present').toBeGreaterThan(-1);
  expect(content.indexOf(header, first + 1), 'exactly one roster table').toBe(-1);
  const rest = content.slice(first);
  const end = rest.indexOf('\n\n');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function tableRows(table) {
  return table
    .split('\n')
    .slice(2) // header + separator
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

// Japanese role names inside backticks on one line.
function backtickedRoles(line) {
  const names = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => ROLES.includes(t));
  return [...new Set(names)]; // a row may mention a role twice; the set is what is closed
}

function lineContaining(content, marker) {
  const line = content.split('\n').find((l) => l.includes(marker));
  expect(line, `line containing ${marker}`).toBeDefined();
  return line;
}

describe('review roster (#131): templates', () => {
  it('carry one roster table with the expected Role / When cells', () => {
    for (const rel of TEMPLATES) {
      const rows = tableRows(rosterTable(read(rel)));
      expect(rows.map((r) => r[0]), rel).toEqual(EXPECTED_ROSTER_ROWS.map((r) => r.role));
      EXPECTED_ROSTER_ROWS.forEach((expected, i) => {
        const when = rows[i][1];
        if (expected.when instanceof RegExp) expect(when, `${rel}: ${expected.role}`).toMatch(expected.when);
        else expect(when, `${rel}: ${expected.role}`).toBe(expected.when);
        expect(rows[i][2], `${rel}: ${expected.role} focus`).toBe(expected.focus);
      });
    }
  });

  it('carry an identical roster table', () => {
    const tables = TEMPLATES.map((rel) => rosterTable(read(rel)));
    expect(tables[1]).toBe(tables[0]);
    expect(tables[2]).toBe(tables[0]);
  });

  it('state the docs-only exception and the re-verification cycle rule', () => {
    for (const rel of TEMPLATES) {
      const content = read(rel);
      expect(content, rel).toContain(
        'docs-only = the integrated reviewer alone, unless gate control-plane files, harness config files, CI workflows or dependency files changed (then Security joins)',
      );
      expect(content, rel).toContain('a re-verification after new High findings counts as a new cycle');
    }
  });
});

describe('review roster (#131): quality-check SKILL.md (normative)', () => {
  const skill = read(SKILL);

  it('has the Step 1 roster decision section with its three rows', () => {
    expect(skill).toContain('\n### レビュー体制の決定\n');
    expect(skill).toMatch(/^\| 統合レビュアー \| Step 4 を実行する全サイクル/m);
    expect(skill).toMatch(/^\| QAエンジニア（ファルシフィケーション型） \| コード変更（テスト・設定を含む）がある場合は常に。/m);
    expect(skill).toMatch(/^\| 専門家（最大 1 体） \| 下表の優先順位で最初に該当した 1 体のみ。/m);
  });

  it('orders the specialists Security > Requirements > Performance', () => {
    expect(skill).toMatch(/^\| 1 \| セキュリティエンジニア \| /m);
    expect(skill).toMatch(/^\| 2 \| 要件・仕様整合性レビュアー \| /m);
    expect(skill).toMatch(/^\| 3 \| パフォーマンスエンジニア \| /m);
  });

  it('keeps the QA and Security conditions aligned with the template wording', () => {
    const qaRow = lineContaining(skill, '| QAエンジニア（ファルシフィケーション型） | コード変更');
    expect(qaRow).toContain('領域判定の結果に依らない');
    expect(qaRow).toContain('docs のみ');
    const securityRow = lineContaining(skill, '| 1 | セキュリティエンジニア |');
    expect(securityRow).toContain('この列挙は領域判定に優先する');
    expect(securityRow).toContain('lockfile');
    expect(securityRow).toContain('ゲート制御面ファイル');
  });

  it('defines every role once in the Step 4 role table and closes the set', () => {
    for (const role of ROLES) {
      expect(skill, role).toMatch(new RegExp(`^\\| ${escapeRe(role)}(（[^|]*）)? \\| `, 'm'));
    }
    const closedSet = backtickedRoles(lineContaining(skill, 'の 6 語に閉じる'));
    expect(closedSet).toEqual(ROLES);
  });

  it('describes the shared context pack and its integrity check', () => {
    expect(skill).toContain('#### 4-0. 共通コンテキストの生成');
    expect(skill).toContain('`<scratchpad>/quality-check/cycle-<N>/context.md`');
    expect(skill).toContain('**完全性の証跡**');
    expect(skill).toContain('「共通コンテキストが実差分と不一致（欠落・過剰ファイル: …）」を優先度 高 の指摘として即座に報告');
  });

  it('runs falsification QA alongside the verification reviewer under a security trigger', () => {
    const verificationRow = lineContaining(skill, '| `verification` |');
    expect(verificationRow).toContain('QAエンジニア（ファルシフィケーション型）1 体を併走');
    expect(lineContaining(skill, '修正差分が **production コードに及ぶ**')).toContain('QAエンジニア（ファルシフィケーション型）1 体を併走');
    expect(skill).toContain('**この再検証は新しいサイクル（Step 2 から）として数え**');
  });

  it('pins the cycle-2+ skip condition and the production-code definition', () => {
    const skipLine = lineContaining(skill, '修正差分が**テスト・フォーマット・セキュリティに無関係な設定のみ**');
    expect(skipLine).toContain('**列挙は Step 1 の起動条件を正とし、ここには転記しない**');
    expect(skipLine).toContain('ハーネス設定ファイル');
    expect(skipLine).toContain('スキップ不可');
    const prodDef = lineContaining(skill, 'ここでいう **production コード**は、Step 1「コード変更」の定義のうちテストコードを除いたもの');
    expect(prodDef).toContain('抑止コメント');
    expect(prodDef).toContain('production コード該当として扱う');
    expect(prodDef).toContain('判定根拠（差分行の内訳）を `cycles[].notes` に記録する');
    expect(lineContaining(skill, '2. 変更ファイル一覧（')).toContain('**実行出力そのもの**');
  });
});

describe('review roster (#131): report schema', () => {
  const schema = read(SCHEMA);

  it('lists the closed set of role names on the personas row', () => {
    const personasRow = lineContaining(schema, '| `personas` |');
    expect(backtickedRoles(personasRow)).toEqual(ROLES);
  });

  it('mirrors the cycle-2+ skip and QA co-run rules on the personas row', () => {
    const personasRow = lineContaining(schema, '| `personas` |');
    expect(personasRow).toContain('セキュリティに無関係な設定のみ');
    expect(personasRow).toContain('ハーネス設定ファイル');
    expect(personasRow).toContain('`QAエンジニア（ファルシフィケーション型）` を併走');
  });

  it('defines review_mode as full | verification', () => {
    const row = lineContaining(schema, '| `review_mode` |');
    expect(row).toContain('`"full" \\| "verification"`');
  });

  it('defines concern with the six values and requires it for reviewer findings', () => {
    const row = lineContaining(schema, '| `concern` |');
    for (const concern of CONCERNS) expect(row, concern).toContain(`"${concern}"`);
    expect(row).toContain('| 必須（レビュアー由来の指摘） |');
  });
});

describe('review roster (#131): copies reference the same roster', () => {
  it('README names the roles and the docs-only exception', () => {
    const readme = read(README);
    for (const role of ['統合レビュアー', 'QAエンジニア（ファルシフィケーション型）', 'セキュリティエンジニア', '検証レビュアー']) {
      expect(readme, role).toContain(role);
    }
    expect(readme).toContain('ゲート制御面に触れる場合はセキュリティエンジニアが加わる');
    expect(readme).toContain('ゲート制御面ファイル・ハーネス設定ファイル・CI ワークフロー・依存関係ファイルに触れる場合はセキュリティエンジニアが加わります');
    expect(lineContaining(readme, '| **検証レビュアー** |')).toContain('反証型 QA を併走');
  });

  it('quality-policy defers to Step 1 and describes the verification review', () => {
    const policy = read(QUALITY_POLICY);
    expect(policy).toContain('体制レビュー');
    expect(policy).toContain('Step 1「レビュー体制の決定」');
    expect(policy).toContain('検証レビュアー 1 体による検証レビュー');
    expect(policy).toContain('再検証は新しいサイクルとして数え');
    expect(policy).toContain('反証型 QA 1 体を併走');
    expect(policy).toContain('セキュリティに無関係な設定のみ');
  });

  it('quick-checklist and development-policy name the roster', () => {
    expect(read(QUICK_CHECKLIST)).toContain('Review roster completed');
    expect(read(QUICK_CHECKLIST)).toContain('Security joins even a docs-only diff that touches gate control-plane files, harness config, CI workflows or dependency files');
    expect(read(DEVELOPMENT_POLICY)).toContain('体制レビュー（統合レビュアー');
  });
});

describe('review roster (#131): obsolete wording', () => {
  it('does not survive in any roster document', () => {
    for (const rel of ALL_ROSTER_FILES) {
      const content = read(rel);
      for (const wording of OBSOLETE_WORDING) {
        expect(content, `${rel} must not match ${wording}`).not.toMatch(wording);
      }
    }
  });

  it('would catch the old vocabulary in its natural spellings', () => {
    const samples = ['6 ペルソナ', '6ペルソナ', 'Multi-persona review', 'multi persona', '6-persona', '6 personas', 'マルチペルソナ', 'QA エンジニアペルソナ', '適用判定表'];
    for (const sample of samples) {
      expect(OBSOLETE_WORDING.some((w) => w.test(sample)), sample).toBe(true);
    }
    for (const allowed of ['personas', 'persona_selection_basis', '`persona`']) {
      expect(OBSOLETE_WORDING.some((w) => w.test(allowed)), allowed).toBe(false);
    }
  });
});
