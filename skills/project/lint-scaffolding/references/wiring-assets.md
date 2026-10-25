# lint-scaffolding: 事前ビルド資産の配線と未カバー分の生成

本体（`SKILL.md`）の Step 3 のうち 3-1・3-2 で読む（3-3〜3-5 は [mutation-lint-all-audit.md](mutation-lint-all-audit.md)）。

## Step 3: 配線と補完

### 3-1. 事前ビルド資産の配線

採用が決まったグループについて、資産種別ごとに配線する。詳細な手順・要件は各 README（`lint/README.md`、`lint/README-<stack>.md`）を正とする。

| 資産 | 配線方法 |
|---|---|
| ast-grep（`lint/ast-grep/<dir>/`） | プロダクトルートに `sgconfig.yml` を作成し、`ruleDirs` に**採用したディレクトリのみ**を列挙する。`@ast-grep/cli` を devDependency に追加する（ハーネス本体の依存ではなくプロダクト側に導入する）。スクリプトから CLI を起動するときは `npx ast-grep` を使わず（壊れた導入では無関係の `ast-grep@0.1.0` を取得する）、次の順で解決する: (1) プラットフォーム別パッケージの実行ファイル（`@ast-grep/cli-win32-x64-msvc/ast-grep.exe` など）、(2) `@ast-grep/cli/ast-grep` の JS shim を `node` で起動（Windows では npm が shim を実行ファイルに置き換えないため、`.exe` が無い導入でもこれで動く）、(3) Windows のみ `node_modules/.bin/ast-grep.cmd` を `cmd /d /s /c` で起動（`.cmd` は Node から直接 spawn できない）。実例は `lib/lint-assets.test.js` の `resolveAstGrepCommand`（#160） |
| ESLint（`lint/eslint/`） | プロダクトの `eslint.config.mjs` から `./lint/eslint/harness.config.mjs` を import し、プロダクト固有の上書きは**プリセットより下**に置く。プリセットは `projectService: true` を使うため**プロダクトの `tsconfig.json` が必須**（詳細は `lint/README-nextjs-react.md`）。不採用グループはプリセットの下で該当ルールを off にする |
| Checkstyle（`lint/checkstyle/`） | Gradle の `checkstyle` プラグインを追加し `configFile` を `lint/checkstyle/checkstyle.xml` に向ける（`lint/README-java-springboot.md`）。不採用グループはグループコメント単位で削除する |
| ArchUnit（`lint/archunit/`） | `archunit-junit5` を testImplementation に追加し、テンプレートを `src/test/java/` 配下へコピーして `__BASE_PACKAGE__` をプロダクトのベースパッケージに置換する（`lint/README-java-springboot.md`） |
| 横断リンター | `@crearize/ai-dev-helm` を devDependency に追加し、package.json の scripts から `ai-dev-helm lint` を呼ぶ形で組み込む（scripts の外で直接呼ぶときは `npx --no ai-dev-helm lint`。`@crearize/` も `--no` も付けない `npx` は、手元に無いと npm の別の名前を取りに行くので使わない）。プロダクトルートに `.ai-dev-helm-lint.json` を生成し、カバレッジマップの採否に応じて各チェック（secrets / commented-code / todo-deadline / import-exists / file-naming / branch-naming / commit-message）の `enabled` と `exclude` グロブを設定する。終了コードは 0 = 問題なし / 1 = 違反あり / 2 = 実行エラー |

branch-naming の既定 `pattern` は Issue 番号を要求しない。番号を必須にしたい導入先は `.ai-dev-helm-lint.json` の `branch-naming.pattern` を上書きする（例: `^(feat|fix|chore|docs|refactor|test|ci|perf)/[a-z0-9._-]+-[0-9]+$`。`feat/foo-bar` は違反、`feat/foo-bar-123` は通る）。

配線対象の資産は package 管理されている（init 再実行で上書きされる）。**プロダクト固有の調整は資産ファイルの編集ではなく、自プロダクトの設定側（ESLint の上書き・sgconfig の選択等）で行う。**

**抑制機構を配線するときのチェックリスト（#118）**

Checkstyle の `SuppressWarningsFilter`、ESLint の `eslint-disable`、ast-grep の `ignores` 等、**抑制機構**（あるチェックを個別に黙らせる仕組み）を配線するときは、配線と同時に次の7点を点検し、機械検出で塞ぐ。下流の実測（Checkstyle 行単位抑制、#117）では、これを配線前に列挙していれば1サイクルで閉じられたはずの抜け道が、後から2サイクルにわたって順次指摘された。

1. **全抑制値**（`all` 等の特別値）を書けるか → 機械検出で禁止する
2. **他チェック名**を書けるか（前置の有無・大小・別名） → 許可表記を1つに固定し、それ以外を機械検出で禁止する
3. **宣言スコープ**（型宣言・フィールド・ファイル）に付けられるか → 最小宣言以外を機械検出で禁止する
4. **非リテラル値**（定数参照・連結・テキストブロック）を書けるか → リテラル以外を機械検出で禁止する
5. 抑制を宣言する**構文そのもの**を別の書き方にできるか（完全修飾名 `@java.lang.SuppressWarnings`、名前の区切りの間の空白・コメント等） → 歯止めのルールは表記ではなく構文の要素で照合し、別の書き方を機械検出から漏らさない（#160）
6. 抑制機構**自身**を検査するチェック（Checkstyle の `SuppressWarnings` チェック等）が、その抑制機構に**自己抑制**されないか → されるなら検出は機構の外（ast-grep 等）に置く
7. 上記を**スパイクで実測**（検出すべきサンプル／検出してはいけないサンプルの両方）してから配線し、結果をカバレッジマップの「残差」に記録する

**原則: 抑制の配線と歯止めのルールは1セットで設計する。** 抑制機構だけを配線し歯止めを後回しにしない（`stacks/java-springboot/lint/checkstyle/checkstyle.xml` の `SuppressWarningsFilter` / `SuppressWarningsHolder` 配線と `shared/lint/ast-grep/error-handling/` の対ルール3本が、この7点を満たした配線の実例）。

### 3-2. 未カバー分の生成

事前ビルド資産がないスタック固有の必要分（例: React + Hono のような未カバー組み合わせ）は、**カタログの「チェック内容の例」を基準に ast-grep ルール等を生成**して補完する。

**生成ルールの配置（MUST）**: 生成したルールは、**package 管理された `lint/ast-grep/` の外にあるプロダクト所有ディレクトリ（例: `lint/product/ast-grep/`）に置き、`sgconfig.yml` の `ruleDirs` に追加する。** `lint/ast-grep/` 配下（`ast-grep/<category>/` や `ast-grep/<stack>/`）には決して置かない — このツリーは init 再実行でリリース版の内容に上書きされるため、生成ルールが失われうる。`lint/product/` は init が触れないため再実行後も残る（`lint/README.md`「Generated rules」の規定）。

**生成ルールの検証（MUST）**: 生成したルールは、**違反サンプルと適合サンプルの両方に対して実際に実行し、違反サンプルで検出・適合サンプルで無検出となることを確認するまで「担保」として数えない。** ハーネスの事前ビルド資産が実実行で検証されて出荷されているのと同じ規律を、その場で生成したルールにも適用する。生成ルールには対応するカタログ番号を付記する（どのカテゴリの具体化かを辿れるようにする — カタログ §1）。

**ast-grep `files:` / `ignores:` の解決基準と sandbox 検証（#103）**: `files:` / `ignores:` を持つルールを検証するときは、次の実測知見（ast-grep 0.45.1・0.51.0）に基づいて検証する。誤ったモデルで検証すると「エラーも警告も出ないまま一律0件」（silent-0）になり、それを「擬陽性なし」と誤読しうる。

- **単一ルールモード**（`ast-grep scan --rule <file> <target>`）: グロブ照合のルートは常に**ルールファイル自身のディレクトリ**。`sgconfig.yml` は一切参照されない
- **プロジェクトモード**（`ast-grep scan`）: ルートは **cwd から上方探索して見つかる `sgconfig.yml` のディレクトリ**。見つからなければエラー終了する（沈黙しない）
- sandbox 検証は**「sandbox を cwd にして相対 `.` を渡す」を標準手順とする**
- **0件を期待する負のコントロールは、陽性コントロール（確実に検出される違反）と同一ファイルに同居させ、走査到達を先に証明してから読む**（0件は「非検出」と「走査未到達」を区別できない）
- 行内抑止（`ast-grep-ignore`）を含むファイルが走査対象なら、`--error=unused-suppression` が `files:` 解決失敗のカナリアになる（解決に失敗すると消費されない抑止として鳴る）
- パス基準の仮説検証は「**ルール位置 × ターゲット種別 × cwd**」を直交させた全組み合わせで回す（片方ずつ振ると要因が交絡し、部分的にだけ正しいモデルを掴む）
