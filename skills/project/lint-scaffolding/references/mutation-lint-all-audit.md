# lint-scaffolding: ミューテーション・`lint:all`・本番依存の監査の配線

本体（`SKILL.md`）の Step 3 のうち 3-3・3-4・3-5 で読む（3-1・3-2 は [wiring-assets.md](wiring-assets.md)）。

## Step 3: 配線と補完

### 3-3. ミューテーションテスト設定の配線

`ai-dev-helm init` は事前ビルドのミューテーション設定をプロダクトの `lint/mutation/` 配下に配置している（他の Lint 資産と同じく配置のみで未配線）。対象スタックに事前ビルド資産がある場合は、それを**配線する**（ゼロから生成しない）。詳細な手順・要件は各スタックの `lint/README-<stack>.md`「Mutation testing」節を正とする。

| 資産 | 配線方法 |
|---|---|
| Stryker（nextjs-react → `lint/mutation/stryker.config.mjs` + `stryker.diff.config.mjs` + `changed-ranges.mjs`） | `@stryker-mutator/core` と `@stryker-mutator/vitest-runner`（jest プロダクトは `@stryker-mutator/jest-runner`）と `minimatch`（`changed-ranges.mjs` のファイル判定に使用。pnpm / Yarn PnP では推移的依存が見えないため明示宣言が必要。ワークスペース構成では宣言先が**ワークスペースルート**になる — `lint/README-<stack>.md`「Environment notes」節を正とする）を**プロダクトの devDependency** に追加する。設定は `lint/mutation/` に置いたまま位置引数で指す（StrykerJS に `--configFile` / `--since` オプションは存在しない）。package.json scripts に `mutation:full`（`stryker run lint/mutation/stryker.config.mjs`）/ `mutation:diff`（`stryker run lint/mutation/stryker.diff.config.mjs` — `origin/main` 以降の**変更行**だけを対象にする差分スコープ。ベース ref の既定探索順は quality-policy §2「差分スコープの定義」を正とし、`MUTATION_BASE_REF` で変更可。再計測用に `mutation:diff:incremental`（`cross-env MUTATION_INCREMENTAL=1 stryker run lint/mutation/stryker.diff.config.mjs`）も登録してよい — `test-recommendation`「incremental と再実行」の再計測がこれを使う。指定形は `lint/README-<stack>.md`「Re-measurement」/「Environment notes」を正とする。Windows では `VAR=value` の前置構文が使えない — package.json script から指定するプロダクトは `cross-env` も**プロダクトの devDependency** に追加する。具体的な指定方法は `lint/README-<stack>.md`「Environment notes」節を正とする）を登録する。jest ランナーへの切替やミュータント種別の再有効化は資産を編集せず、資産を spread したプロダクト所有の設定で行う（`lint/README-<stack>.md`「Mutation testing」節） |
| PIT（java-springboot → `lint/mutation/pitest.gradle`） | プラグイン id `info.solidsoft.pitest` を**プロダクトルートの `plugins{}`** に宣言し（`apply from` された `pitest.gradle` 内には置けない）、`apply from: 'lint/mutation/pitest.gradle'` で取り込む。`pitest.gradle` は編集せず（配布物なので `upgrade` で配布元の版と三者マージされ、配布元と同じ行の変更は衝突になるため）、`gradle.properties` に `mutationBasePackage=<ベースパッケージ>` を書く（未設定だとビルドが止まる）。エントリポイントは `pitest.gradle` 自身が登録する Gradle タスク `mutationFull`（全体スコープ）/ `mutationDiff`（`-PmutationDiffBase=origin/main` で**変更クラス**にスコープを絞る）を使う。Gradle のタスク名に `:` は使えないため、JS 側の `mutation:full` / `mutation:diff` とは名前が異なる（`lint/README-<stack>.md`「Mutation testing」節） |

**未カバースタックの生成**: 事前ビルド資産のないスタック（例: React + Hono）は、従来どおり Stryker（JS/TS）/ PIT（Java）の設定を**カタログ基準から生成**して補完する。生成した設定も下記の実実行確認を必須とする。

いずれの場合も、全体スコープと差分スコープのエントリポイント（JS: `mutation:full` / `mutation:diff` の package.json scripts、Java: `mutationFull` / `mutationDiff` の Gradle タスク）を登録し、**選択と配線先をカバレッジマップに記録する**。差分スコープはツールの最小粒度（Stryker は変更行、PIT は変更クラス）であり、変更ファイル全体を対象にしない（`documents/development/quality-policy.md` §2「差分スコープの定義」）。事前ビルド資産があるのに配線せずスキップする場合も、その選択と理由を記録する（`test-recommendation` スキル（`quality-check` Step 5 から参照実行）は未配線のプロダクトではミューテーションを提案せず、`reason: "not_configured"` を記録する）。

**配線完了条件（MUST・Lint 資産と同一の規律）**: ミューテーション配線は、**実際に一度実行して（`mutation:full` / `mutationFull`、またはミュータントが生成される変更を対象にした差分スコープの実行 — 差分スコープは変更行にミュータント点がないと空スコープとして何もせず終了するため、確認には必ずミュータントが生成される対象を選ぶ）、ミュータントが生成されスコアが算出されることを確認するまで「配線完了」としない。** 事前ビルド資産が実実行で検証されて出荷されているのと同じ「数える前に走らせる」規律を配線にも適用する。実行時間バジェットは本スキルに置かず `documents/development/quality-policy.md` §2 を正とする — スコアはレポートに出力され、実行の提案・トリアージは `test-recommendation` スキルが担う（通過判定なし・非ブロック）。

### 3-4. `lint:all` の作成と実行確認

採用した全チェックを束ねる **`lint:all`** を作成する（package.json script を既定とし、package.json がないプロダクトでは Makefile / Gradle タスク等の同等物）。束ねる対象: ESLint / ast-grep / Checkstyle / ArchUnit（テスト経由の場合はビルドタスク）/ 横断リンター、その他採用した全チェック。

`lint:all` の実行確認（MUST）は、本体（`SKILL.md`）の「確認の場面と進め方（毎回守る）」の「`lint:all` の実行確認（Step 3-4）」に従う。

### 3-5. 本番依存の監査（`audit:prod`）の配線

カタログ B3 の「既知脆弱性」を実行できるようにする（static-check-standard の B3 は npm audit を必須とするが、配線されていないと未記入のまま残る）。パッケージマネージャごとに、**本番依存だけ**を監査する script を登録する。`lint:all` には**束ねない**（新しく公開された脆弱性でゲートが止まらないようにする。実行・判断・記録は `quality-check` Step 2「本番依存の監査」が行う）。

| パッケージマネージャ | `audit:prod`（package.json scripts） |
|---|---|
| npm | `"audit:prod": "npm audit --omit=dev --audit-level=high"` |
| pnpm | `"audit:prod": "pnpm audit --prod --audit-level high"` |
| Yarn（berry） | `"audit:prod": "yarn npm audit -A -R --environment production --severity high"` |
| Yarn（classic） | `"audit:prod": "yarn audit --groups dependencies --level high"` |
| Gradle | 標準で本番依存だけを監査する簡単な手段は無い。配線しない場合は「未配線」とし、カバレッジマップの B3 行に AI レビュー担保と、代替（GitHub の Dependabot alerts を `gh api repos/{owner}/{repo}/dependabot/alerts` で確認する等）を記録する。OWASP dependency-check を使う場合は NVD の API キーとキャッシュが要るので、プロジェクトが採用を決めたときだけ配線する |

監査は終了コード 0 を求めない（検出があると非 0 になる）。**実際に一度実行し**、監査が動くこと（レジストリに届く・lockfile が読める）を確かめてから配線完了とする。結果はカバレッジマップの B3 行に記入する（記入例は `coverage-map-template.md`「B3 の記入例」）。

ast-grep の勧告（脆弱性）は npm audit に出ないので、配布元（GitHub の ast-grep/ast-grep）の勧告を見る。
