---
name: lint-scaffolding
description: init 直後またはスタック変更時に実行。静的チェック基準カタログ（A1〜F2）を判断基準に、プロダクトへ決定的チェック（Lint / 静的解析）を選択・配線・補完し、カバレッジマップ（採否台帳）と `lint:all` コマンドを整備する。
---

# Lint Scaffolding Skill - 決定的チェック層の配線

## 最重要ルール

**機械判定できるものは AI レビューに委ねず、決定的チェック（Lint / 静的解析）にする。** 何を担保すべきかの基準はカタログ `documents/development/static-check-standard.md`（A1〜F2 の25カテゴリ）が定義する。カタログは基準であり実行機構ではない — **本スキルがその実行機構（プロダクトへの配線）である。**

- 成果物は3つ: **カバレッジマップ（採否台帳）**・**`lint:all` コマンド**・**レビューガイドへの反映**
- カテゴリを採用しない場合も「AI レビュー担保」に割り当てて理由を記録する。**チェック自体が黙って消えることは許さない**（カタログ §3）
- 配線した Lint 資産は**実際に実行して動くことを確認するまで配線完了としない**
- `quality-check` スキルの Step 2 は、`lint:all` が定義されていればそれを静的チェックコマンドとして使う（`quality-check` SKILL.md 側に規定済み）。本スキルはその `lint:all` を整備する側である

数値（修正サイクル上限・ミューテーションの実行時間バジェット等）は本スキルに置かない。`documents/development/quality-policy.md` §2 / §5 を正とする。

---

## 前提: 事前ビルド Lint 資産

`ai-dev-helm init` がプロダクトの `lint/` 配下に事前ビルド資産を配置している（配置のみで未配線 — コピーされただけではビルドに影響しない）。

```
lint/
  README.md                 # 資産全体の説明
  README-<stack>.md         # スタック別の配線ガイド（選択したスタック分のみ）
  ast-grep/
    <category>/             # 汎用ルールグループ（async / error-handling / hardcode / security / test-quality）
    <stack>/                # スタック固有ルール（例: nextjs-react/）
  eslint/                   # ESLint flat-config プリセット + カスタムルール（nextjs-react）
  checkstyle/               # Checkstyle プリセット（java-springboot）
  archunit/                 # ArchUnit テストクラステンプレート（java-springboot）
```

どのディレクトリが存在するかは init 時のスタック選択に依存する。**Step 2 では README の記述ではなく `lint/` 配下の実在を確認すること。**

---

## 実行フロー

```
Step 1: スタック検出（package.json / ビルド設定から技術要素を特定）
  ↓
Step 2: カバレッジマップ作成と採否確認（カタログ25カテゴリ全行、ユーザーと採否を決定）
  ↓
Step 3: 配線と補完（事前ビルド資産の配線 / 未カバー分の生成 / lint:all 作成 → 実行確認）
  ↓
Step 4: 登録と除外（CLAUDE.md 登録 / レビューガイド反映 / カバレッジマップ保存）
```

---

## Step 1: スタック検出

プロダクトの構成ファイルから技術要素を特定する。この結果が Step 2 の採用基準判定（「推奨（該当技術があるプロダクト）」の該当有無）の根拠になる。

| 確認対象 | 特定できる技術要素 |
|---|---|
| `package.json`（dependencies / devDependencies / scripts） | 言語（TS/JS）、FW（Next.js / React / Hono / Express 等）、DB アクセス層（Prisma / Drizzle 等）、テストランナー（Vitest / Jest 等） |
| `tsconfig.json` | TypeScript の有無・strict 設定（型安全カテゴリの実現手段に影響） |
| `build.gradle` / `pom.xml` | Java / Kotlin、Spring Boot、JPA/jOOQ、テスト構成 |
| `pyproject.toml` / `requirements.txt` | Python 系スタック |
| `next.config.*` / `vite.config.*` 等 | フロントエンド（UI）の有無（F1 の格上げ判定に使う） |
| `docker-compose.yml` / マイグレーションディレクトリ | DB の有無（D1 クエリ品質の該当判定に使う） |
| リポジトリ構成（モジュール分割・レイヤーディレクトリ） | C1 / C2（レイヤー境界・循環依存）の該当判定 |

検出例: React + Hono + Prisma / Next.js 単体 / Spring Boot + JPA。**複数スタックが混在するモノレポでは領域ごとに検出結果を分けて記録する。**

---

## Step 2: カバレッジマップ作成と採否確認

同ディレクトリの [`coverage-map-template.md`](coverage-map-template.md) を雛形に、**カタログの25カテゴリ（A1〜F2）全行**についてカバレッジマップを作成する。行の省略は認めない。

各行に記録する内容:

| 記録項目 | 内容 |
|---|---|
| このスタックでの実現手段 | Step 1 の検出結果に対応する具体ツール・ルール（カタログの「一般的な実現手段」を読み替える） |
| 事前ビルド資産の有無 | **`lint/` 配下の実在を実際に確認する**（ディレクトリ・ファイルを列挙する。README に記載があっても実在しない資産を「あり」としない） |
| 採用基準 | カタログの 必須 / 推奨 / 任意（テンプレートに転記済み） |
| 🤖 | AI 生成コードで頻発するカテゴリか（テンプレートに転記済み） |

### 採否確認

採否は**カテゴリ / ルールグループ単位で判断できる形にしたうえで、1 通のメッセージに纏めて確認する**。全カテゴリを 必須 / 推奨 / 任意 の区分順に並べた 1 つの表にし、行ごとに「カテゴリ名・チェック内容の例・事前ビルド資産の有無・採用基準・🤖・推奨（採用 / 不採用）」を示して、ユーザーが行単位で採否を答えられるようにする（「全て推奨どおり」の一括回答も可）。区分ごとに分けて順に確認したり、カテゴリごとに往復したりしない。回答から派生した確認のみ 2 巡目可。不採用の扱いは下記「不採用時の扱い（MUST）」に従う。再実行時は「再実行（冪等性）」節のとおり、再確認対象の行だけを表に載せる。

**優先順位（MUST）** — カタログ §1 の規定:

1. **必須カテゴリを先に満たす。** 導入コストの制約でカテゴリを絞る場合も、必須カテゴリが最優先
2. **同一採用基準の中では 🤖 カテゴリから先に配線する**
3. **🤖 は採用基準を飛び越えない。** 🤖 付きの推奨カテゴリが、🤖 なしの必須カテゴリに優先することはない

**不採用時の扱い（MUST）** — カタログ §3 / §4 の規定:

- カテゴリを採用しない場合は、カバレッジマップ上で**「AI レビュー担保」に割り当て、理由を記録する**。レビューガイド側に観点として残す（Step 4-2）。チェック自体が消えることはない
- 「推奨（該当技術があるプロダクト）」で該当技術がない場合は「不採用（該当技術なし）」として理由を記録する（この場合は AI レビュー担保への割当ても不要 — チェック対象自体が存在しないため）
- ルールを弱めて通すことは認めない。グループ単位で不採用にし、理由を記録する（`lint/README.md` の規定）。**不採用の恒久的な担保はカバレッジマップへの記録 + `sgconfig.yml`（等のツール設定）に含めないことである。package 管理された `lint/` ディレクトリの削除は恒久オプトアウトにならない — init 再実行で復元される**

---

## Step 3: 配線と補完

### 3-1. 事前ビルド資産の配線

採用が決まったグループについて、資産種別ごとに配線する。詳細な手順・要件は各 README（`lint/README.md`、`lint/README-<stack>.md`）を正とする。

| 資産 | 配線方法 |
|---|---|
| ast-grep（`lint/ast-grep/<dir>/`） | プロダクトルートに `sgconfig.yml` を作成し、`ruleDirs` に**採用したディレクトリのみ**を列挙する。`@ast-grep/cli` を devDependency に追加する（ハーネス本体の依存ではなくプロダクト側に導入する） |
| ESLint（`lint/eslint/`） | プロダクトの `eslint.config.mjs` から `./lint/eslint/harness.config.mjs` を import し、プロダクト固有の上書きは**プリセットより下**に置く。プリセットは `projectService: true` を使うため**プロダクトの `tsconfig.json` が必須**（詳細は `lint/README-nextjs-react.md`）。不採用グループはプリセットの下で該当ルールを off にする |
| Checkstyle（`lint/checkstyle/`） | Gradle の `checkstyle` プラグインを追加し `configFile` を `lint/checkstyle/checkstyle.xml` に向ける（`lint/README-java-springboot.md`）。不採用グループはグループコメント単位で削除する |
| ArchUnit（`lint/archunit/`） | `archunit-junit5` を testImplementation に追加し、テンプレートを `src/test/java/` 配下へコピーして `__BASE_PACKAGE__` をプロダクトのベースパッケージに置換する（`lint/README-java-springboot.md`） |
| 横断リンター | `@crearize/ai-dev-helm` を devDependency に追加し、`npx ai-dev-helm lint` を組み込む。プロダクトルートに `.ai-dev-helm-lint.json` を生成し、カバレッジマップの採否に応じて各チェック（secrets / commented-code / todo-deadline / import-exists / file-naming / branch-naming / commit-message）の `enabled` と `exclude` グロブを設定する。終了コードは 0 = 問題なし / 1 = 違反あり / 2 = 実行エラー |

配線対象の資産は package 管理されている（init 再実行で上書きされる）。**プロダクト固有の調整は資産ファイルの編集ではなく、自プロダクトの設定側（ESLint の上書き・sgconfig の選択等）で行う。**

**抑制機構を配線するときのチェックリスト（#118）**

Checkstyle の `SuppressWarningsFilter`、ESLint の `eslint-disable`、ast-grep の `ignores` 等、**抑制機構**（あるチェックを個別に黙らせる仕組み）を配線するときは、配線と同時に次の6点を点検し、機械検出で塞ぐ。下流の実測（Checkstyle 行単位抑制、#117）では、これを配線前に列挙していれば1サイクルで閉じられたはずの抜け道が、後から2サイクルにわたって順次指摘された。

1. **全抑制値**（`all` 等の特別値）を書けるか → 機械検出で禁止する
2. **他チェック名**を書けるか（前置の有無・大小・別名） → 許可表記を1つに固定し、それ以外を機械検出で禁止する
3. **宣言スコープ**（型宣言・フィールド・ファイル）に付けられるか → 最小宣言以外を機械検出で禁止する
4. **非リテラル値**（定数参照・連結・テキストブロック）を書けるか → リテラル以外を機械検出で禁止する
5. 抑制機構**自身**を検査するチェック（Checkstyle の `SuppressWarnings` チェック等）が、その抑制機構に**自己抑制**されないか → されるなら検出は機構の外（ast-grep 等）に置く
6. 上記を**スパイクで実測**（検出すべきサンプル／検出してはいけないサンプルの両方）してから配線し、結果をカバレッジマップの「残差」に記録する

**原則: 抑制の配線と歯止めのルールは1セットで設計する。** 抑制機構だけを配線し歯止めを後回しにしない（`stacks/java-springboot/lint/checkstyle/checkstyle.xml` の `SuppressWarningsFilter` / `SuppressWarningsHolder` 配線と `shared/lint/ast-grep/error-handling/` の対ルール3本が、この6点を満たした配線の実例）。

### 3-2. 未カバー分の生成

事前ビルド資産がないスタック固有の必要分（例: React + Hono のような未カバー組み合わせ）は、**カタログの「チェック内容の例」を基準に ast-grep ルール等を生成**して補完する。

**生成ルールの配置（MUST）**: 生成したルールは、**package 管理された `lint/ast-grep/` の外にあるプロダクト所有ディレクトリ（例: `lint/product/ast-grep/`）に置き、`sgconfig.yml` の `ruleDirs` に追加する。** `lint/ast-grep/` 配下（`ast-grep/<category>/` や `ast-grep/<stack>/`）には決して置かない — このツリーは init 再実行でリリース版の内容に上書きされるため、生成ルールが失われうる。`lint/product/` は init が触れないため再実行後も残る（`lint/README.md`「Generated rules」の規定）。

**生成ルールの検証（MUST）**: 生成したルールは、**違反サンプルと適合サンプルの両方に対して実際に実行し、違反サンプルで検出・適合サンプルで無検出となることを確認するまで「担保」として数えない。** ハーネスの事前ビルド資産が実実行で検証されて出荷されているのと同じ規律を、その場で生成したルールにも適用する。生成ルールには対応するカタログ番号を付記する（どのカテゴリの具体化かを辿れるようにする — カタログ §1）。

**ast-grep `files:` / `ignores:` の解決基準と sandbox 検証（#103）**: `files:` / `ignores:` を持つルールを検証するときは、次の実測知見（ast-grep 0.45.1）に基づいて検証する。誤ったモデルで検証すると「エラーも警告も出ないまま一律0件」（silent-0）になり、それを「擬陽性なし」と誤読しうる。

- **単一ルールモード**（`ast-grep scan --rule <file> <target>`）: グロブ照合のルートは常に**ルールファイル自身のディレクトリ**。`sgconfig.yml` は一切参照されない
- **プロジェクトモード**（`ast-grep scan`）: ルートは **cwd から上方探索して見つかる `sgconfig.yml` のディレクトリ**。見つからなければエラー終了する（沈黙しない）
- sandbox 検証は**「sandbox を cwd にして相対 `.` を渡す」を標準手順とする**
- **0件を期待する負のコントロールは、陽性コントロール（確実に検出される違反）と同一ファイルに同居させ、走査到達を先に証明してから読む**（0件は「非検出」と「走査未到達」を区別できない）
- 行内抑止（`ast-grep-ignore`）を含むファイルが走査対象なら、`--error=unused-suppression` が `files:` 解決失敗のカナリアになる（解決に失敗すると消費されない抑止として鳴る）
- パス基準の仮説検証は「**ルール位置 × ターゲット種別 × cwd**」を直交させた全組み合わせで回す（片方ずつ振ると要因が交絡し、部分的にだけ正しいモデルを掴む）

### 3-3. ミューテーションテスト設定の配線

`ai-dev-helm init` は事前ビルドのミューテーション設定をプロダクトの `lint/mutation/` 配下に配置している（他の Lint 資産と同じく配置のみで未配線）。対象スタックに事前ビルド資産がある場合は、それを**配線する**（ゼロから生成しない）。詳細な手順・要件は各スタックの `lint/README-<stack>.md`「Mutation testing」節を正とする。

| 資産 | 配線方法 |
|---|---|
| Stryker（nextjs-react → `lint/mutation/stryker.config.mjs` + `stryker.diff.config.mjs` + `changed-ranges.mjs`） | `@stryker-mutator/core` と `@stryker-mutator/vitest-runner`（jest プロダクトは `@stryker-mutator/jest-runner`）と `minimatch`（`changed-ranges.mjs` のファイル判定に使用。pnpm / Yarn PnP では推移的依存が見えないため明示宣言が必要。ワークスペース構成では宣言先が**ワークスペースルート**になる — `lint/README-<stack>.md`「Environment notes」節を正とする）を**プロダクトの devDependency** に追加する。設定は `lint/mutation/` に置いたまま位置引数で指す（StrykerJS に `--configFile` / `--since` オプションは存在しない）。package.json scripts に `mutation:full`（`stryker run lint/mutation/stryker.config.mjs`）/ `mutation:diff`（`stryker run lint/mutation/stryker.diff.config.mjs` — `origin/main` 以降の**変更行**だけを対象にする差分スコープ。ベース ref の既定探索順は quality-policy §2「差分スコープの定義」を正とし、`MUTATION_BASE_REF` で変更可。再計測用に `mutation:diff:incremental`（`cross-env MUTATION_INCREMENTAL=1 stryker run lint/mutation/stryker.diff.config.mjs`）も登録してよい — `test-recommendation`「incremental と再実行」の再計測がこれを使う。指定形は `lint/README-<stack>.md`「Re-measurement」/「Environment notes」を正とする。Windows では `VAR=value` の前置構文が使えない — package.json script から指定するプロダクトは `cross-env` も**プロダクトの devDependency** に追加する。具体的な指定方法は `lint/README-<stack>.md`「Environment notes」節を正とする）を登録する。jest ランナーへの切替やミュータント種別の再有効化は資産を編集せず、資産を spread したプロダクト所有の設定で行う（`lint/README-<stack>.md`「Mutation testing」節） |
| PIT（java-springboot → `lint/mutation/pitest.gradle`） | プラグイン id `info.solidsoft.pitest` を**プロダクトルートの `plugins{}`** に宣言し（`apply from` された `pitest.gradle` 内には置けない）、`apply from: 'lint/mutation/pitest.gradle'` で取り込む。`pitest.gradle` 内の `__BASE_PACKAGE__` をプロダクトのベースパッケージに置換する。エントリポイントは `pitest.gradle` 自身が登録する Gradle タスク `mutationFull`（全体スコープ）/ `mutationDiff`（`-PmutationDiffBase=origin/main` で**変更クラス**にスコープを絞る）を使う。Gradle のタスク名に `:` は使えないため、JS 側の `mutation:full` / `mutation:diff` とは名前が異なる（`lint/README-<stack>.md`「Mutation testing」節） |

**未カバースタックの生成**: 事前ビルド資産のないスタック（例: React + Hono）は、従来どおり Stryker（JS/TS）/ PIT（Java）の設定を**カタログ基準から生成**して補完する。生成した設定も下記の実実行確認を必須とする。

いずれの場合も、全体スコープと差分スコープのエントリポイント（JS: `mutation:full` / `mutation:diff` の package.json scripts、Java: `mutationFull` / `mutationDiff` の Gradle タスク）を登録し、**選択と配線先をカバレッジマップに記録する**。差分スコープはツールの最小粒度（Stryker は変更行、PIT は変更クラス）であり、変更ファイル全体を対象にしない（`documents/development/quality-policy.md` §2「差分スコープの定義」）。事前ビルド資産があるのに配線せずスキップする場合も、その選択と理由を記録する（`test-recommendation` スキル（`quality-check` Step 5 から参照実行）は未配線のプロダクトではミューテーションを提案せず、`reason: "not_configured"` を記録する）。

**配線完了条件（MUST・Lint 資産と同一の規律）**: ミューテーション配線は、**実際に一度実行して（`mutation:full` / `mutationFull`、またはミュータントが生成される変更を対象にした差分スコープの実行 — 差分スコープは変更行にミュータント点がないと空スコープとして何もせず終了するため、確認には必ずミュータントが生成される対象を選ぶ）、ミュータントが生成されスコアが算出されることを確認するまで「配線完了」としない。** 事前ビルド資産が実実行で検証されて出荷されているのと同じ「数える前に走らせる」規律を配線にも適用する。実行時間バジェットは本スキルに置かず `documents/development/quality-policy.md` §2 を正とする — スコアはレポートに出力され、実行の提案・トリアージは `test-recommendation` スキルが担う（通過判定なし・非ブロック）。

### 3-4. `lint:all` の作成と実行確認

採用した全チェックを束ねる **`lint:all`** を作成する（package.json script を既定とし、package.json がないプロダクトでは Makefile / Gradle タスク等の同等物）。束ねる対象: ESLint / ast-grep / Checkstyle / ArchUnit（テスト経由の場合はビルドタスク）/ 横断リンター、その他採用した全チェック。

**実行確認（MUST）**: `lint:all` を実際に実行し、**全体が通る（または既存コードの既知違反を検出する）ことを確認するまで配線完了としない。** 既知違反が出た場合はユーザーに提示し、「その場で修正する / 違反を残したまま導入して以後のコミットで解消する」の判断を仰ぐ。実行時エラー（設定不正・ツール未解決等）は違反検出ではなく配線の失敗として扱い、解消するまで先に進まない。

---

## Step 4: 登録と除外

### 4-1. 静的チェックコマンドの登録

`lint:all` を **CLAUDE.md の静的チェックコマンドとして登録する**。`AGENTS.md` / `.cursorrules` が存在するプロダクトでは同内容を反映する（ツール間で登録内容を食い違わせない）。これにより `quality-check` Step 2 が `lint:all` を決定的チェック層として実行するようになる。

### 4-2. レビューガイドへの反映

**本節がレビューガイドへの記載形式の定義である**（カタログ §4 はこの形式を参照する）。

**Lint 担保済み項目の除外**: 各 `.github/review-*.md` の末尾に次の節を設け、Lint 担保に割り当てたカテゴリを列挙する:

```markdown
## Lint 担保済み項目（AI レビュー対象外）

- <カタログ番号> <カテゴリ名> — 担保手段: <資産参照>
```

`<資産参照>` は配線した実体を指す（例: `lint/eslint/harness.config.mjs` の correctness グループ、`lint/ast-grep/security/`、`.ai-dev-helm-lint.json` の secrets チェック）。この節に載せてよいのは**実際に配線・実行確認済み（Step 3-4 完了）のカテゴリだけ**である。

**全担保のみ列挙（MUST）**: この「Lint 担保済み項目（AI レビュー対象外）」節に載せてよいのは、**配線した Lint 資産がそのカテゴリのカタログ「チェック内容の例」を丸ごとカバーするカテゴリだけ**である。資産がカテゴリの一部しかカバーしない**部分担保**カテゴリ（例: B2 は `lint/ast-grep/security/` が eval / 弱いハッシュ / TLS 検証無効化 / シェルコマンドインジェクションのみ、E2 / A3 / C6 も一部のみ）は**この節に載せない**。載せると未担保範囲（SQL/XSS 等）が全レビューから黙って抜け落ちる。部分担保のカテゴリは代わりに、該当レビューガイド本文の関連観点に `（Catalog: <番号> — Lint 部分担保: <未担保範囲>）` を付記し、未担保範囲を AI レビューが引き続きカバーするようにする。カバレッジマップ側では採用状況を `部分担保（Lint + AI レビュー）` とし、担保手段に Lint 担保分、理由・参照に AI レビューへ残す残差を記録する（`coverage-map-template.md`）。

**AI レビュー担保項目の明示**: 逆に、カバレッジマップで「AI レビュー担保」に割り当てたカテゴリは、該当レビューガイド本文の関連チェック項目に `（Catalog: <番号>）` を付記する。ガイドに対応する既存項目がない場合はチェック項目として追記する。これによりレビューガイドとカタログの対応が双方向に辿れる。

### 4-3. カバレッジマップの保存

完成したカバレッジマップを **`documents/development/lint-coverage-map.md`** に保存する。これが**採否台帳**であり、以後の正となる:

- ルールを追加・削除・不採用に変更するたびに更新する（更新規律はテンプレート末尾の節を参照）
- `quality-check` Step 4 の体制レビュー（統合レビュアー・QA・専門家）は、このマップで Lint 担保に割当済みの項目をレビュー対象外とする（マップが存在しないプロダクトでは何も除外されない）

---

## 完了条件

- [ ] カバレッジマップに**25カテゴリ全行**の採否（採用 / 不採用 / AI レビュー担保）と理由が記録され、`documents/development/lint-coverage-map.md` に保存されている
- [ ] 採用した全チェックを束ねる `lint:all` が存在し、**実際に実行して**全体が通る（または既知違反を検出する）ことを確認した
- [ ] その場で生成したルールは違反 / 適合サンプルへの実実行で検証済みである
- [ ] ミューテーション設定の選択（配線 / 生成 / スキップ）がカバレッジマップに記録されている。配線・生成時は全体 / 差分スコープのエントリポイント（JS: `mutation:full` / `mutation:diff`（再計測用の `mutation:diff:incremental` は任意）、Java: `mutationFull` / `mutationDiff`）を登録し、**実際に一度実行してミュータント生成とスコア算出を確認済み**である
- [ ] `lint:all` が CLAUDE.md（および存在すれば AGENTS.md / .cursorrules）に静的チェックコマンドとして登録されている
- [ ] 各 `.github/review-*.md` に「Lint 担保済み項目（AI レビュー対象外）」節が反映され、AI レビュー担保カテゴリに `（Catalog: <番号>）` が付記されている

---

## 再実行（冪等性）

本スキルは**再実行可能**である。スタック変更（FW・DB アクセス層の追加/変更）、init 再実行による資産更新、カテゴリ採否の見直し時に再実行する。

- **既存の `documents/development/lint-coverage-map.md` が過去の採否決定の正である。** 再実行時はまず既存マップを読み、決定済みの行はユーザーに再確認せず引き継ぐ（変更があった技術要素に関わる行のみ再確認する）
- 配線済みの資産は再配線しない。差分（新規採用・不採用への変更・資産の更新）のみを適用する
- 再実行後も Step 3-4 の実行確認と Step 4 の反映（レビューガイド・カバレッジマップの更新）を必ず行う
- **`ai-dev-helm init` の再実行は `.github/review-*.md` を無条件で上書きする（`copyFilesSync` による。これらは package 管理されたレビューガイドである）。** そのため init を再実行したプロダクトでは、Step 4-2 がそれらのファイルに書いた「## Lint 担保済み項目（AI レビュー対象外）」節と本文の `（Catalog: <番号>）` 付記が失われる。init 再実行後は、カバレッジマップ（`documents/development/lint-coverage-map.md` — init は**上書きしない**）を正として、この節と付記を再生成すること。**「配線済みは再配線しない」ルールはこの節には適用しない** — レビューガイドは資産ではなく init が毎回上書きする生成物であり、init 再実行のたびにマップから作り直す必要がある
