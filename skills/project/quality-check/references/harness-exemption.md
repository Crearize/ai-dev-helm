# quality-check: ハーネスのみ変更の免除

本体の Step -1（quality-check 自体を省けるか）で読む。Step 6 のフラグの性質と hook の「通す条件」も、ここで定めるハーネスファイルとゲート制御面を使う。

## ハーネスのみ変更の免除

変更差分（`git diff --name-only <基準 ref>...HEAD`。基準 ref は `origin/main`、無ければ `origin/master`、リモート追跡の trunk が 1 つも無いときだけローカルの `main`、`master`。hook と `quality-context` も同じ規則）が**1件以上あり、かつ全て以下のハーネスファイル**に該当する場合、quality-check 自体が不要（hook も同じハーネスファイル集合を基準に免除を判定するため、通常はフラグ作成も不要。下記のゲートパラメータ・カーブアウトに該当する差分は除く）:

- `CLAUDE.md` / `AGENTS.md`（任意の階層）
- `.cursorrules`
- 次のディレクトリの下の**文書**（拡張子 `.md` / `.mdc`）だけ: `.claude/**` / `.codex/**` / `.cursor/**`、`skills/project/**` / `skills/superpowers/**`、`documents/development/coding-rules/**`（H-47。スクリプト・設定ファイル（`.cjs` / `.js` / `.sh` / `.json` / `.toml` など）は実行物なので免除しない）
- `.github/review-*.md`
- 導入先が `.ai-dev-helm.json` の `gate.exemptDocs` で足した文書（`.md` / `.mdc` だけ。「hook の完全な契約」の「導入先の拡張点」）

ただしハーネス設定ファイル（`CLAUDE.md` / `AGENTS.md` / `.cursorrules`）の差分がゲートパラメータ（quality-check の実行時間バジェット。キー名は `documents/development/quality-policy.md` §2「上書きの契約」の `Quality Gate Overrides` 記法）の変更を含む場合、この免除は適用しない。この場合は本スキルを実行し（Step 1 のレビュー体制の決定に従うレビュー）、フラグを作成する。hook 側もこのカーブアウトを免除判定に反映するため、フラグなしでのマージはブロックされうる。

同様に、**ゲート制御面**に触れる差分もこの免除の対象外とする: `skills/project/quality-check/**`・`skills/project/_schemas/**`・`skills/project/test-recommendation/**`（Step 5 は完了条件の構成要素であり、判定・提示・実行・記録の規定は同スキルを単一ソースとするため）・Design Gate を定める `skills/superpowers/brainstorming/**`・`skills/superpowers/writing-plans/**`（H-21）・`.claude/skills` の下のこれらのスキル（`project/` の有無を問わない）と `.claude/skills` のリンクノード自体（`init` はこれをシンボリックリンクとして作成するため、1 パスの張り替えで quality-check ツリー全体が差し替わる。スキルを実コピーで持つ導入先では、ほかのスキルの文書は上の免除に従う — H-48）・`.claude/hooks` のツリーとその `.codex/**`・`.cursor/**` コピー・`.claude` / `.codex` / `.cursor` の **`agents/` `commands/` `prompts/` `rules/` ディレクトリ**（`.claude/agents/*.md` はサブエージェントの system prompt / モデル定義、`commands/*.md` はセッションに読み込まれるプロンプト、`.cursor/rules/*.mdc` は init が生成し全セッションに自動読込されるルール、`.codex/prompts/` も同様にセッションへ読み込まれるプロンプトのため）・`.github/review-*.md`・hook 登録ファイル（`.codex/hooks.json` と `.claude` / `.cursor` の同等物）・`.codex/config.toml`（ファイル全体 — inline `[hooks]` テーブル・`[features]` の hook 無効化・`[[rules]]` の deny 判定を持ち得る）・MCP 登録ファイル（リポジトリ直下の `.mcp.json`（Claude Code のプロジェクトの MCP 設定）・`.claude/mcp.json` / `.codex/mcp.json` / `.cursor/mcp.json` — MCP サーバー定義は command/args 実行の登録であり hooks.json と同クラス）・`.ai-dev-helm.json`（ファイル全体。導入先のゲートの設定と、差し替えたゲート・review-budget の宣言を持つため）・導入先が `gate.controlPlane` で足したパスと `gate.script` / `reviewBudgetScript` の実体（「hook の完全な契約」の「導入先の拡張点」）**および hook 登録を担う `.claude/settings.json` と `.claude/settings.local.json`（Claude Code は両方を読み、後者が高優先度）**。これら2ファイルは**ファイル全体**が制御面である — hook はキー単位の解析をしないため、`hooks` ブロック・`disableAllHooks` / `allowManagedHooksOnly` の hook 無効化キー・`permissions.deny` ルールリスト（破壊的コマンドガードを支える deny 層）に限らず、**`permissions.allow` のみの変更もブロックする**（登録を外す・無効化する・deny 層を弱めれば実体を守っても同じため）。パスのマッチは大文字小文字を区別しない（Windows/macOS では `.claude/Hooks/...` は `.claude/hooks/...` と同一ファイル）。これらはゲートそのものを構成するファイルであり、開発中レビューの廃止（quality-policy §5.5）後は本スキルが唯一のレビュー地点となるため、レビュー0回での変更を許さない（Step 1 のレビュー体制の決定に従うレビューを実施しフラグを作成する。本カーブアウトは hook が強制する — 該当差分はフラグなしでのマージ・push が `Gate control-plane changed:` でブロックされる）。

README や `documents/` 配下の利用者向けドキュメントはハーネスファイルに**含まれない**（統合レビュアーの対象）。

## リリースの差分の免除（release-please のリリースの PR）

release-please が作るリリースの PR は、次の条件を**すべて**満たすときだけ、ハーネスのみ変更の免除と同じ扱いで quality-check が不要になる（hook もフラグ無しで通す）。判定は差分の中身だけで行い、ブランチ名では判定しない。

- 取り込む差分のファイルが、固定の 4 つ `CHANGELOG.md`・`package.json`・`package-lock.json`・`.release-please-manifest.json` だけ。`release-please-config.json` の `extra-files`（`pom.xml` など）は免除に含めない（依存の変更がうっかり通るのを防ぐため）
- `package.json` の変化が最上位の `version` だけ。`package-lock.json` の変化が最上位と `packages[""]` の `version` だけ（`resolved`・`integrity`・依存の追加・削除・範囲の変化があれば免除しない）。`.release-please-manifest.json` の変化が版の値だけ（キーは同じ）。hook は変更前後のファイルを JSON として読んで比べる（行の形では判定しない。入れ子の `"version"` キー — `version` という名前の依存、`version` スクリプト、`node_modules/<pkg>` の版 — の変化は免除しない）

免除が効くのは、基準 ref からの差分（リリースの PR のブランチをチェックアウトして `gh pr merge` / push する）と、トランクへの `git merge` / 早送りで取り込む範囲。main のチェックアウトでは基準 ref からの差分が空なので、`gh pr merge` には効かない（リリースの PR のブランチから実行する）。フラグの後の差分には効かない（品質チェックの後に足したコミットは、リリースのファイルだけでも品質チェックをやり直す）。
