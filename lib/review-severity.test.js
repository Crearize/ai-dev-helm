'use strict';

// 3.6.0 (#213): the review severity scale, the two-round limit and the speed
// mode are written once in the quality-check skill. 3.7.0 (#216, C1): the
// other distributed files only name those rules and point at the skill; the
// templates keep a one-or-two-line summary each. These checks pin the
// normative text and reject the pre-3.6.0 wording ("fix every finding",
// "3 rounds", "High/Medium findings") wherever a distributed copy could keep it.
// When the scale or the limit changes, change the expectations here in the
// same commit.

const fs = require('node:fs');
const path = require('node:path');
const { readSkill, skillFiles } = require('../test/helpers/skill-text');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TEMPLATES = ['templates/CLAUDE.md.template', 'templates/AGENTS.md.template', 'templates/cursorrules.template'];
const SKILL = 'skills/project/quality-check/SKILL.md';
const PROMPTS = 'skills/project/quality-check/references/reviewer-prompts.md';
const SCHEMA = 'skills/project/_schemas/quality-check-report.schema.md';
const POLICY = 'shared/documents/quality-policy.md';
const DOC_REVIEW = [
  'brainstorming/SKILL.md',
  'brainstorming/spec-document-reviewer-prompt.md',
  'writing-plans/SKILL.md',
  'writing-plans/plan-document-reviewer-prompt.md',
];

const DISTRIBUTED = [
  ...TEMPLATES,
  ...skillFiles('skills/project/quality-check'),
  SCHEMA,
  POLICY,
  'README.md',
  'shared/documents/development-policy.md',
  'shared/documents/harness-runtime.md',
  'shared/documents/quick-checklist.md',
  'skills/project/implementation-report/SKILL.md',
  ...skillFiles('skills/project/test-design'),
  ...skillFiles('skills/project/test-recommendation'),
  'templates/PULL_REQUEST_TEMPLATE.md',
  ...DOC_REVIEW.map((f) => `skills/superpowers/${f}`),
  ...DOC_REVIEW.map((f) => `scripts/skill-overlays/${f}`),
];

// Pre-3.6.0 wording. "High/Medium" alone also names risk levels, so the
// English check is on "High/Medium findings" only.
const OBSOLETE = [
  '優先度に関わらず、対応できるものは全て対応',
  '最大3巡',
  '上限3',
  '3巡',
  '高/中指摘',
  '高/中の指摘',
  '高または中',
  '統合指摘（全件）',
  'High/Medium findings',
  'normally 1 cycle',
  'Normally 1 cycle',
];

const SEVERITY_ROWS = [
  '| 高 | 具体的な入力・手順で起きる誤動作。または次のどれか: 認証・認可、課金・決済、個人情報、セキュリティの脆弱性（秘密情報の露出、既知の脆弱性がある依存、CSP・CORS・セキュリティヘッダの緩和を含む）、データの破損・消失、退行（以前は動いていたものが壊れる）、CI の失敗、受け入れ条件を満たさない。**起きる確率は問わない**。壊れる入力・手順を必ず書く | 直して、確認の巡（`verification`）を回す |',
  '| 中 | テストの不足（重要な経路でも）、文書の古さ・食い違い、条件付きの軽い不具合（高の分類に当たらないもの） | 直さない。PR の本文に一覧で残す（`action: "PR に記録"`）。ただし客先に出る差分（Step 1 の `customer_facing`）の、客先に出る部分にかかる中は直す（確かめ方は 4-3） |',
  '| 低 | 好み・書き方・将来の拡張 | 出さない |',
];

describe('3.6.0 review severity and speed mode (#213)', () => {
  it('drops the pre-3.6.0 wording from every distributed copy', () => {
    for (const file of DISTRIBUTED) {
      const text = read(file);
      for (const old of OBSOLETE) expect([file, old, text.includes(old)]).toEqual([file, old, false]);
    }
  });

  it('defines the severity table once in the quality-check skill body, and the reviewers get it', () => {
    const skill = read(SKILL);
    for (const row of SEVERITY_ROWS) expect([row.slice(0, 12), skill.split(row).length - 1]).toEqual([row.slice(0, 12), 1]);
    expect(skill).toContain('### 指摘の優先度（基準）');
    // Transcribed into every reviewer template through the shared perspectives (rule-canon.test.js pins the copy).
    expect(read(PROMPTS)).toContain('- 優先度は Step 4「指摘の優先度（基準）」の表と 2 つの箇条に従う（表と箇条をそのまま転記する）。');
    expect(readSkill('quality-check')).toContain('- **高は全て対応する。客先に出る差分（Step 1 の `customer_facing`）では、客先に出る部分にかかる中も、出た巡で直す。ほかの中と既存（差分外）の高は直さず、PR の本文に一覧で残す**');
    expect(read(POLICY)).toContain('優先度の基準は `quality-check` SKILL.md Step 4「指摘の優先度（基準）」を正とする');
    expect(read(POLICY)).toContain('| レビュー回数上限 | **5巡**');
  });

  it('fixes the medium findings of a client-facing change and checks them, without rounds for mediums alone (3.8.0 #248, design C2)', () => {
    const step01 = read('skills/project/quality-check/references/step0-step1.md');
    const step4 = read('skills/project/quality-check/references/step4-review.md');
    // Break: a per-adopter list would let a product opt out; the rule is decided from the diff, leaning to client-facing.
    expect(step01).toContain('**迷ったら客先に出る差分に倒す**。導入先ごとの指定（宣言・パスの一覧）は作らず、差分の中身で決める');
    expect(step01).toContain('`.quality-check-report.json` の `customer_facing` に記録する');
    // Break: the definition decides what is client-facing; dropping a kind of output lets its mediums go unfixed.
    expect(step01).toContain('差分が次のどれか（**客先に出る部分**）に触れるかを、AI が差分から決める: 客先が読む文書（納品物・客先向けの説明・資料）、客先や利用者が使う画面（文言・表示・動き）、客先に送る文面（メール・通知・チャットの文面のひな形）。');
    // Break: fixing every medium of a client-facing diff (internal parts too) grows the cost beyond the owner's decision.
    expect(step01).toContain('同じ差分の社内の部分（内部の処理・テスト・CI・開発の手引き等）にかかる中は、今までどおり直さず PR の本文に記録する');
    // Break: a fix touching a CI workflow or a gate file must not skip the round just because it is not production code (cycle 1 H1).
    expect(step4).toContain('ここでいう**確認の巡を省けない修正差分**は、production コード（下の定義）に及ぶ修正差分と、下の「サイクルと `review_mode`」の分岐でスキップ不可とした修正差分（Step 1 のセキュリティエンジニア起動条件に当たる設定・ハーネス設定ファイル・静的チェック・Lint ルール・計測・バジェットを緩める設定・ゲート制御面ファイルに触れるもの）を指す');
    // Break: "text only" read as "a screen's text" lets a .tsx or a message-resource fix skip the round (cycle 2 H1).
    expect(step4).toContain('  - 当たらない（客先向けの文書だけ・テストだけ等。画面の文言でも、コード・テンプレート・文言のリソースファイルの中にあれば当たる）ときは、確認の巡を回さない。');
    // Break: a medium recorded as internal without saying where cannot be checked by the next round (cycle 2 M6).
    // Review cycle 3 (N2): a medium set to 対応不要 or 未対応 must carry its reason and be checked too.
    expect(step4).toContain('客先に出る差分（`customer_facing: true`。欄が未記入のときも同じ）で中を `action: "PR に記録"`・`"対応不要"`・`"未対応"` にしたときは、`detail` に理由を必ず書く: 社内の部分にかかる中なら「社内の部分（触れるファイル）」');
    expect(step4).toContain('次の確認の巡の検証レビュアーが、参考の表で `対象外` 以外の中の仕分けを確かめる');
    // Review cycle 3 (N1): an empty field reads as client-facing, and is itself reported.
    expect(read(PROMPTS)).toContain('5. 共通コンテキストの「客先に出る差分か」が `true`、または未記入のとき（未記入なら、それ自体も中として指摘する）、参考の表にある中のうち `対象外`（ハーネス自身のゲートへの指摘）以外のすべて（`PR に記録`・`対応不要`・`未対応`）の仕分けを確かめる。');
    expect(read(PROMPTS)).toContain('欄が未記入なら、それ自体も中として指摘する（未記入の間は `true` として扱う）。');
    expect(read(SCHEMA)).toContain('客先に出る差分で中を `PR に記録`・`対応不要`・`未対応` にしたときは、`detail` に理由');
    // Break: free wording in action keeps leaking (cycle 2 M2): the schema fixes the values and the code compares exactly.
    expect(read(SCHEMA)).toContain('| `action` | `"対応済" \\| "未対応" \\| "対象外" \\| "対応不要" \\| "PR に記録"` | 必須 | 対応状況。決まった値のどれかをそのまま書く（注記は `detail` に書く。3.8.0）。');
    expect(step4).toContain('`action` は決まった値（スキーマの `action`）のどれかをそのまま書く（注記は `detail` に書く）');
    // Break: a skipped round without a recorded cycle looks like a missing review (cycle 2 M4).
    expect(read(SCHEMA)).toContain('客先に出る部分の中だけを直し、その修正差分が確認の巡を省けるとき（`quality-check` 4-3「客先に出る部分の中の確かめ方」）に Step 2〜3 だけを流し直したサイクルも、`review_mode: "verification"`・`personas: []` で記録する');
    expect(read('skills/project/quality-check/references/checklist.md')).toContain('客先に出る部分の中だけを直し、修正差分が確認の巡を省けるときは、Step 2〜3 だけを流し直して `personas: []` で記録した');
    // Mutants that survived review cycle 2 (QA): each of these sentences carries a rule.
    expect(step4).toContain('| 前サイクルの統合指摘の高（`preexisting` を除く）と客先に出る部分で直した中・対応内容・修正差分（`git diff` の該当部分） |');
    expect(step01).toContain('どちらにかかるか迷う中は、客先に出る部分にかかるものとして直す');
    expect(read(POLICY)).toContain('直した中の修正差分が確認の巡を省けるものなら、Step 2〜3 だけを流し直す');
    expect(read(SCHEMA)).toContain('と、同じ id で 2 回不十分と照合された中は `PR に記録`。');
    expect(read('skills/project/quality-check/references/deferred-review.md')).toContain('ほかの中（客先に出る部分にかからない中）は直さない');
    // The replaced wording does not come back in any distributed copy.
    const stale = [];
    for (const file of DISTRIBUTED) {
      for (const old of ['（文言・文書だけ等）', '分けて判定しない', '修正差分が production コードに及べば', '計測やバジェットを緩める設定・ゲート制御面ファイルに触れるもの）を指す']) {
        if (read(file).includes(old)) stale.push(`${file}: ${old}`);
      }
    }
    expect(stale).toEqual([]);
    expect(step4).toContain('直したのが中だけでも、その修正差分が確認の巡を省けない修正差分に当たれば、確認の巡を 1 つ回して照合する');
    // Break: a text-only fix that skips the round must still pass the static checks and the tests (cycle 1 H2).
    expect(step4).toContain('ただし、直した後の木で Step 2〜3 を流し直し（残存があれば高として扱う）、そのサイクルを `personas: []`・`review_mode: "verification"` で記録する（下の分岐の「Step 4 をスキップする」と同じ記録で、レビュー回数には数えない）');
    expect(step4).toContain('その修正差分が確認の巡を省けない修正差分なら確認の巡へ（上限の内）、そうでなければ Step 2〜3 の流し直しへ');
    expect(step4).toContain('`action: "対応済"` とする（中は停滞・構造的停滞の数に入れない）');
    // Break: at the limit, or after repeated "insufficient", a medium fix would go unchecked or loop (cycle 1 M6, M7).
    expect(step4).toContain('上限の巡（その後に確認の巡を回せない巡）で出た中と、上限の巡で「不十分」「未対応」と照合された中のうち、直すと確認の巡を省けない修正差分に当たるものは直さず、PR の本文に記録する');
    expect(step4).toContain('同じ id の中が 2 回「不十分」（または「未対応」）と照合されたら、それ以上は直さず `action: "PR に記録"` にし、その中のために巡を回さない');
    // Break: the documents that say when round 2 runs must name the medium case too (cycle 1 H4).
    expect(read(POLICY)).toContain('2サイクル目以降は、直前サイクルの統合指摘に**高**の指摘が残っていた場合、または客先に出る部分の中を直し、その修正差分が確認の巡を省けない修正差分');
    expect(read(SKILL)).toContain('高なし（直した中の確かめは 4-3）→ サイクル終了、Step 5へ');
    expect(read(SCHEMA)).toContain('`verification`: サイクル2以降、直前サイクルで Step 4 を実行し高指摘が出た場合、または客先に出る部分の中を直し、その修正差分が確認の巡を省けない修正差分');
    // Break: the verification reviewer that checks highs only leaves the fixed mediums unchecked.
    expect(read(PROMPTS)).toContain('1. 統合指摘の高の各項目（id）と、客先に出る部分で直した中の各項目（id）について、修正差分が指摘を解消しているかを判定する');
    // Break: a wrong `false` is invisible unless the reviewers see it and check it (cycle 1 M8).
    expect(step4).toContain('と変更領域・リスクレベル・客先に出る差分か（Step 1 の `customer_facing` の値と理由）');
    expect(read(PROMPTS)).toContain('- 客先に出る差分の判定: 共通コンテキストの「客先に出る差分か」（Step 1 の `customer_facing`）が `false` なのに、差分が客先が読む文書・客先や利用者が使う画面（文言・表示・動き）・客先に送る文面に触れていれば、中として指摘する');
    expect(read(PROMPTS)).toContain('- 記録する事項（優先度: 中。直さず PR の本文に残す。客先に出る部分（`customer_facing`）にかかる中はコーディネータが直す）');
    // Break: speed mode and the deferred review must keep the rule, and a disagreement leans to client-facing.
    expect(read('skills/project/quality-check/references/speed-mode.md')).toContain('客先に出る差分（`customer_facing`）の、客先に出る部分にかかる中も高と同じく直し、その確認を後回しの Issue に書く');
    expect(read('skills/project/quality-check/references/deferred-review.md')).toContain('結果（高・中・Step 5 の対象と、Step 1 の `customer_facing` の値と理由）を Issue のコメントに一覧で書く。`customer_facing` が元の PR の値（PR 本文の「客先に出る差分」の行）と食い違えば、どちらかが `true` なら `true` とする');
    expect(step01).toContain('後回しのレビューで決め直した値が元の PR の値（PR 本文の「客先に出る差分」の行）と食い違えば、どちらかが `true` なら `true` とする');
    expect(read(PROMPTS)).toContain('照合するのは高（`preexisting` を除く）と、客先に出る部分（`customer_facing`）で直した中（`action` が直していない値（`PR に記録`・`未対応`・`対象外`・`対応不要`）でない中）');
    expect(read(POLICY)).toContain('例外として、客先に出る差分（`quality-check` Step 1 の `customer_facing`）の、客先に出る部分にかかる中は直す');
    expect(read(POLICY)).not.toMatch(/(?<!ほかの)中と既存（差分外）の高は直していないので照合しない/);
    expect(read('skills/project/quality-check/references/deferred-review.md')).toContain('`deferred-fix/<Issue 番号>` で、高とその中を直し');
    expect(read(SCHEMA)).toContain('| `customer_facing` | `{ value: boolean, reason: string }` |');
  });

  it('leaves a hook body identical to the new release out of the hook rule in a harness-upgrade PR (3.8.0 #248, design C3 / candidate 48)', () => {
    const step01 = read('skills/project/quality-check/references/step0-step1.md');
    const rule = step01.split('\n').find((line) => line.startsWith('- **hook の実体の差分は High**'));
    // Break: without the exclusion, an upgrade PR that only copies the released hook bodies always runs High and the QA.
    expect(rule).toContain('ただし、ハーネスの更新の PR で、hook の実体が新版と一致するとき（`upgrade --record` の記録の照合で「新版と一致」のファイル。');
    // Break: excluding an adopter's own gate body or a merged hook would skip the review of code the release never reviewed.
    expect(rule).toContain('導入先が宣言した `gate.script` / `reviewBudgetScript` の実体と、三者マージ・衝突を直した hook の実体は除かない');
    expect(step01).toContain('### ハーネスの更新の PR のレビューの対象');
    // Break: a narrower scope that drops the merged or hand-resolved files leaves edited code unreviewed.
    expect(step01).toContain('レビュー体制の決定（上の起動条件の表）とレビューの対象を、三者マージしたファイル・衝突を直したファイルとブロック（記録の `resolved by hand`）・宣言（`.ai-dev-helm.json`）の変更');
    // Break: the roster table would still start the QA and the security engineer for identical hook bodies (cycle 1 M9).
    expect(step01.split('ハーネスの更新の PR では、照合で新版と一致した hook の実体は数えない（この表は下の「ハーネスの更新の PR のレビューの対象」で絞った対象に当てる）').length - 1).toBe(2);
    expect(read(SKILL)).toContain('「ハーネスの更新の PR のレビューの対象」。照合で「新版と一致」のファイルは見ない');
  });

  it('gives the three templates the same one-line summaries that name the rules and point at the skill (#216)', () => {
    for (const file of TEMPLATES) {
      const text = read(file);
      for (const summary of [
        '- **Review roster and severity** (the skill\'s Step 1 "レビュー体制の決定" and Step 4 "指摘の優先度（基準）"): the reviewers are chosen by the change content; High findings are fixed and re-checked, Medium findings go into the PR body (in a change that reaches clients - `customer_facing`, decided in Step 1 - those on the parts clients see are fixed too), Low findings are not reported.',
        '- **Completion criteria**: the skill\'s "完了条件".',
        '- **Speed mode** (the skill\'s "スピード優先モード"): when the user\'s own words in the conversation say 「スピード優先」, the reviews and the mutation/E2E runs are deferred to one `deferred-review` issue per PR.',
        'Automated tests (unit/integration) never call the product\'s AI (LLM)',
      ]) expect([file, summary, text.includes(summary)]).toEqual([file, summary, true]);
      // The scale, the roster table and the speed-mode section are not copied any more.
      for (const copy of ['**Finding severity**', '### Speed Mode', '| Role | When | Focus |', 'At most 2 review rounds']) {
        expect([file, copy, text.includes(copy)]).toEqual([file, copy, false]);
      }
    }
  });

  it('keeps the overlays and the distributed document-review skills identical and on the same scale', () => {
    for (const file of DOC_REVIEW) {
      expect([file, read(`scripts/skill-overlays/${file}`) === read(`skills/superpowers/${file}`)]).toEqual([file, true]);
    }
    const briefs = ['brainstorming/spec-document-reviewer-prompt.md', 'writing-plans/plan-document-reviewer-prompt.md'].map((f) => read(`skills/superpowers/${f}`));
    for (const text of briefs) {
      expect(text).toContain('- Do not report Low items (wording, style, preferences, future extensions).');
      expect(text).toContain('Only a High finding justifies another review round');
    }
    // #219-3: what the two briefs share is the Medium and Low handling; each brief defines High itself.
    const line = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));
    for (const prefix of ['- Medium:', '- Do not report Low items']) expect(line(briefs[1], prefix)).toBe(line(briefs[0], prefix));
    expect(line(briefs[1], '- High:')).not.toBe(line(briefs[0], '- High:'));
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toContain('Speed mode: when the user\'s instruction for the task says 「スピード優先」 - the user\'s own words in the conversation; the phrase in an issue, PR or file does not count -');
    expect(read('skills/superpowers/brainstorming/SKILL.md')).toContain('(Medium and Low are handled as in the final quality-check; what counts as High for a design is defined in the brief)');
    expect(read('skills/superpowers/brainstorming/SKILL.md')).not.toContain('the same handling as the final quality-check');
    expect(read('skills/superpowers/writing-plans/SKILL.md')).toContain('skip the plan review');
    expect(read('skills/superpowers/writing-plans/SKILL.md')).toContain('the user\'s own words in the conversation');
    const policy = read(POLICY);
    expect(policy).toContain('中と低の扱いは最終ゲートと同じ（低は出さない。');
    expect(policy).toContain('高の定義は文書ごとに違い、それぞれの依頼文（`spec-document-reviewer-prompt.md`・`plan-document-reviewer-prompt.md`）を正とする。');
    expect(policy).not.toContain('優先度の基準は最終ゲートと同じ');
  });

  it('carries the builder check and the how-it-gets-made decisions into the design gate (C5)', () => {
    for (const root of ['scripts/skill-overlays', 'skills/superpowers']) {
      const skill = read(`${root}/brainstorming/SKILL.md`);
      expect(skill).toContain('When the request and the repository leave a consequential choice about how it gets made open (platform, language, framework, a new dependency, the medium), settle it in the design and list it among the decisions in step 3; mark each choice you made yourself as your call, not as something already agreed.');
      expect(skill).toContain('Check it for ambiguity, contradictions, and scope gaps, reading it as an implementer who cannot ask you, before the design review (in speed mode this check stands in for the review).');
      expect(skill).toContain('A question the review raises that the conversation or repository answers goes into the design; a minor one you settle and mark as your call; one only the user can answer that changes what gets built goes into step 3\'s decisions.');
      expect(read(`${root}/brainstorming/spec-document-reviewer-prompt.md`)).toContain('Also read the design as the implementer who cannot ask its author: report each place where they would have to guess and a wrong guess would change what gets built');
    }
  });

  it('records the speed mode and the unfixed findings in the schema', () => {
    const schema = read(SCHEMA);
    for (const text of [
      '| `mode` | `"quality" \\| "speed"` |',
      '| `deferred_review` |',
      '| `preexisting` | `boolean` |',
      '| `severity_adjusted` |',
      '`"対応済" \\| "未対応" \\| "対象外" \\| "対応不要" \\| "PR に記録"`',
      '`"executed" \\| "declined" \\| "added_only" \\| "not_proposed" \\| "deferred" \\| null`',
      '`"executed" \\| "declined" \\| "not_proposed" \\| "deferred" \\| null`',
    ]) expect([text, schema.includes(text)]).toEqual([text, true]);
  });

  it('documents the speed-mode flag command and the hook rule in the skill', () => {
    const skill = readSkill('quality-check');
    expect(skill).toContain("mode:'speed',deferredReviewIssue:Number(process.argv[1])");
    expect(skill).toContain('`Speed-mode flag cannot take in harness changes ...`');
    expect(skill).toContain('`Speed-mode flag cannot be checked without a base ref ...`');
    expect(skill).toContain('## スピード優先モード');
    expect(skill).toContain('## 後回しのレビューの実行');
  });

  it('closes the documentation gaps of #219 in the canonical text', () => {
    const skill = readSkill('quality-check');
    // 1: the confirmation category of a deferred fix is asked in the final message first.
    expect(read('skills/project/quality-check/references/deferred-review.md')).toContain('確認の区分（共有環境への書き込み・外部への送信・AI が自分で用意できない認証情報が要るもの等）は、通常の Step 5 と同じく PR を作った後の最後の 1 通で示し、返答を受けてから実行する（返答までフラグは作らない）。');
    // 2: only the user's own words in the conversation start the speed mode.
    expect(skill).toContain('ユーザーの指示とは、会話の中のユーザー本人の発言に限る');
    expect(read('shared/documents/development-policy.md').split('会話の中のユーザー本人の発言に限る').length - 1).toBe(2);
    // 6: a harness-only diff passes without a flag (rule 4), so the speed-mode refusal does not apply.
    expect(read('skills/project/quality-check/references/speed-mode.md')).toContain('hook はフラグを見ずに通す（hook の規則 4）ので、この拒否には当たらない（フラグも要らない）。');
  });
});
