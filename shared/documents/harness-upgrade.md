# ハーネス簡素化版への更新

必要な製品・環境固有の差分を残したまま、配布物と実際に読み込まれる規則を揃えるための手順です。バージョン番号だけでは更新済みと判定しません。

## 更新前の記録

利用する配布物のリリースまたはコミットを固定します。この変更の公開前に、既存の `3.0.1` を取得して新方針へ更新できたと扱わないでください。配布元チェックアウトで実行する場合の例:

```powershell
node <配布元>/bin/cli.js harness-inventory --dir <導入先> --baseline <比較する版の配布元>
```

JSON を導入先の外へ保存します。`--baseline` は利用者が選んだ比較元であり、ツールは配布物の真正性を検証しません。記録上の旧版と同じ配布物、および更新先の配布物を別々に指定すると、更新漏れと独自変更を調べやすくなります。混在した版や出自不明の差分は未判定のまま残します。

Windows PowerShell 5.1 で JSON を保存するときは `> file.json`（既定 UTF-16）を避け、`| Set-Content -Encoding utf8 -LiteralPath <保存先.json>` を使います。CLI の JSON 入力は UTF-8（先頭 BOM 可）です。

診断はファイルを読み、raw SHA-256 と BOM・改行正規化後の SHA-256 を返します。設定内容を出力せず、導入先を書き換えません。`different` は内容の差であり、不要な改変という意味ではありません。名前などが埋め込まれるルートテンプレートは `rendered_template` とし、単純比較で一致・不一致を断定しません。リンク先の実体を重複排除しますが、外部プラグインがセッション中に読まれた事実までは証明しません。

`AGENTS.override.md` / `CLAUDE.local.md` / `.claude/CLAUDE.md` / `.claude/CLAUDE.local.md` も記録します。親ディレクトリ・ユーザー共通・配下のディレクトリ別の指示、設定から参照される任意の外部 hook は自動解決しません。これらを使う導入先では、診断結果に加えて実際の読込元を確認します。

## 取り込む変更

| 配布元 | 導入先での扱い |
|---|---|
| `templates/CLAUDE.md.template` / `AGENTS.md.template` / `cursorrules.template` | 既存ルートルールへ差分を手動反映。製品固有の節・変数の埋め込みを保護 |
| `shared/documents/development-policy.md` / `quality-policy.md` / `harness-runtime.md` | `documents/development/` の対応文書へ反映。モデル表の参照先を揃える |
| `skills/superpowers/` | 実際の skill 読込元を更新。既存の独自差分は確認して移植。外部 marketplace plugin 直読みではローカルコピー更新だけで完了しない |
| `skills/project/quality-check` / `_schemas` / `self-improvement` / `implementation-report` | `.claude` / `.codex` / `.cursor` の有効な配置・リンク先へ反映。独自の品質要件は維持 |
| `templates/hooks/quality-gate.cjs` | 登録されている hook 実体へ反映。独自ゲートは単純置換せず BOM 修正等を移植し、独自の保護ブランチ・検証を残す |
| `bin/` / `lib/` | CLI を更新。診断・正規化・context 計測を提供する。hook だけのコピーでは新コマンドは追加されない |

同期時のハーネス方針は配布元の `scripts/skill-overlays/`（ハーネスが持つ overlay と、基にした上流ファイルのハッシュ）で管理します。導入先で上流へ手動適用する必要はなく、変換済みの配布物を使います。配布元の同期で上流の変更が overlay の基にしたファイルと合わなければ、エラーに表示されたファイルの差分を確認します。上流とずれた場合、定期同期は Issue を作るか更新します。

通常の `init` は既存ルートルールの全文を新テンプレートに置き換える仕組みではありません。`init` 再実行を禁止しているプロジェクトでは手動反映を維持します。複数ツールが同じ skill を共有している場合は実体とリンクを確認してから更新し、別コピーの場合は必要な全コピーを揃えます。

削除・修正の対象は、エージェントのモデル選択のプロジェクト独自の上書き（出自を問わず。harness-runtime.md の表が正本）と、親の実装禁止、固定委譲、コードを再執筆させる詳細計画、重複レビュー、自己改善の必須完了条件です。ドメインの不変条件、テスト期待値の根拠、実ブラウザ確認、ブランチ・ファイル所有・予算・権限の保護は維持します。Low リスクの QA 1体化と GitHub へのゲート移管は今回の変更に含みません。

## `.ai-dev-helm-new` の取り込み

`init` の再実行後、利用者が編集する前提のファイル（`.claude/rules/`、`.codex/rules/`、`.github/review-*.md`（`review-prompt.md` 以外）、`lint/`）のうち、編集済み、または前回の `init` の記録（`.ai-dev-helm.json` の `files`）が無いもの（3.2.x からの更新など）は上書きされず、隣に `<file>.ai-dev-helm-new` が置かれ、`ACTION REQUIRED` に一覧が出ます。AI が次を行います。オーナーの作業はありません。

1. 各 `.ai-dev-helm-new` を対応するファイルと比べ、プロジェクト独自の内容（lint-scaffolding が書いた節、カスタマイズ）は残し、上流の変更は取り込む。
2. 取り込んだら `.ai-dev-helm-new` を削除する。
3. 変更をコミットする。

スキル・`documents/development/`・`review-prompt.md`・フックはハーネス所有のため、常に上書きされます（独自の変更は `harness-upgrade` の他の節に従い移植する）。

## 更新後の確認

1. 適用元のリリース・コミット、適用前後の診断結果、維持した独自差分を既存の更新記録へ残す。記録上の版だけを先に上げない。
2. 小さな変更を親が直接実装できること、必要な場合だけ委譲されること、自己改善の採否待ちで完了が止まらないことを実際の読込元で確認する。
3. 有効な hook に BOM 付き入力を渡し、通常入力と同じ拒否結果になることを確認する。gate の pure `classify` または捨てられるテストリポジトリで行い、本物の main へ push して試さない。
4. feature の単純な `git commit ... && git push [remote]` は許可、main/master と `git switch main && git push`、`git rebase origin/main main && git push` などは拒否されることを確認する。PowerShell 5.1 では `&&` 自体が未対応なので、文字列として classifier を検証する。
5. 通常の品質チェック、独自ゲート、重要な E2E / 実動作テストが引き続き機能することを確認する。回避策は代替修正が検証できてから整理する。
6. Codex を使う導入先では、`/hooks` で `.codex/hooks.json` のフックを信頼するまで、quality-gate も review-budget も動かない（警告も出ない）。更新で `hooks.json` が変わったら（matcher・command・timeout・順序）、再び信頼する（`.cjs` の中身だけの更新では信頼は外れない）。信頼は Codex の設定の場所（`CODEX_HOME`）ごとに記録されるので、Codex のアカウント・設定の場所を切り替えたら（orca のアカウントの切り替えなど）、切り替えた先でも信頼する。`npx @crearize/ai-dev-helm codex-trust --dir <導入先> [--codex-home <設定の場所>]` で、プロジェクトとフックが信頼されているかを読み取りだけで確かめ、終了コード 0 になるまで対応する。

## 設計ゲートとモデル表の更新

設計完了後のレビュー依頼が省かれる問題と、モデル世代の更新（Claude Opus / Sonnet 5.5、GPT-6.1 Sol）を取り込みます。

- **設計ゲート**: 配布する brainstorming / writing-plans / using-superpowers とレビュー依頼文 2 種、テンプレートの Development Philosophy 2 項・Design Confirmation Rules を反映します。導入先で独自に書き換えた brainstorming がある場合も、「設計完了 → `document-reviewer` による設計レビュー → 設計とレビュー結果をユーザーへ 1 通で示し承認まで止まる」の 3 段と、免除の範囲が development-policy §1.0（承認済み設計の範囲内の修正を含む）に従うことを残します。外部 plugin を直接読む導入先は、その読込元にも同じ変更が必要です。
- **Claude のモデル**: ユーザー設定の `model` は `claude-opus-5-5` へ（`personal --upgrade-model` または対話で確認）。テンプレートやプロジェクト設定に `fable` を既定として書いている箇所は `opus` へ戻し、Fable は難所の格上げに限ります。Opus 5 以前・Sonnet 5 以前・Haiku の指定は削除します。別名が旧版に解決される環境では 5.5 のモデル ID を明示します。
- **Codex のモデル**: `init` / `personal` の再実行で、旧版のまま変更されていない `.codex/agents/helm-*.toml` と、`[agents] default_subagent_model = "gpt-5.6-terra"` を新しい値へ更新し、更新した旨を表示します。`helm-doc-reviewer.toml` と、見た目・編集判断を要する制作用の `helm-visual-producer.toml` が新たに追加されます。プロジェクト独自のモデル指定（制作中心のプロジェクトの実装モデル、Cursor 独自モデル等）は残さず、ハーネスの表に統一します（製品コードが使うモデル ID は対象外）。独自に変更したエージェント定義と、旧既定値以外のモデル指定は保持されるため、`Preserved customized managed role file` と表示されたファイルは手動で確認します。GPT-6 Luna と GPT-5.6 系の指定は残さず、最も軽い作業も `gpt-6.1-sol` / `low` を下限にします。最終品質レビュー（`helm-reviewer`）は `gpt-6-astra` / `high` のままです。

更新後は、小さな実装依頼でも設計レビューの予約・依頼と、ユーザーへのレビュー依頼が行われること、各ツールで実際に選ばれるモデルが上記になっていることを実際の読込元で確認します。

## review-budget の更新（3.3.0）

- phase `production`（制作時のデザインレビュー）と `mutation`（ミューテーション分類の検証）が加わった。独自のローカル回避策（`--phase quality` の読み替え、ミューテーション用の独自スクリプト）は、動作を確かめてから外す。
- `requirements` / `design` / `plan` / `production` の予約は main / master 上で拒否される。先にタスクブランチを作る。
- `HELM_REVIEW:` のマーカーは message / prompt の 1 行目だけが有効。レビュー語を含まない実装の依頼は、予約なしで通る。
- Claude Code の hook の matcher に `SendMessage` が加わった。`init` の再実行で更新される（Codex の matcher は変わらず、信頼の再確認は要らない）。
- 上限を超えるときは、オーナーの承認後にエージェントが `review-budget extend` を実行する。「状態ファイルを退避する」手順は不要になった。
- 配布した hook（`.claude/hooks` と `.codex/hooks`）は全コピーを同時に更新する。古い hook は `extensions` を持つ状態を不正と判定する。

## マージの既定（3.4.1）

3.4.1 から、設計の承認はマージを含む。設計との差異が無ければ AI がマージし、差異があればマージの前に最後の 1 通で確認する（`development-policy.md` §1.0「承認後の進め方」1）。3.4.0 の「プロジェクトの規則がマージを定めていなければマージしない」を前提にしていた導入先は、マージの前にオーナー承認が必要なら、その旨をプロジェクトの規則（CLAUDE.md / AGENTS.md / .cursorrules）に書く（例外 X2 になる）。マージで自動的に本番（客先・利用者に影響する環境）へのリリース・公開・デプロイが走るプロジェクトも X2 として扱われる。

## 3.4.2 の更新

- 本番の DB・本番の決済・実際の客先への送信等を使わない、動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない（名前ではなく、客先・利用者に影響するかで決める）。
- main から本番ブランチ（`release` 等）へ反映する運用の OK の範囲は §1.0「承認後の進め方」8 による。
- 導入先が独自に書いた同じ趣旨の規則（「staging は X2 でない」、本番への反映の範囲の聞き方）は、配布元の文と重なるので、配布元への参照に置き換える。
- `init` の再実行は、`.gitignore` に `.claude/worktrees/`（Claude Code の標準の作業ツリーの置き場所）を足す。
- `init` を再実行しない導入先は、同じ行を手で足す（`git status` の表示に作業ツリーが出ないようにするため。3.4.3 からは、無くてもリモートの無い統合は止まらない）。
- 必要なら（`.gitignore` の更新を統合する前から `git status` の表示を整えたいとき）、`"$(git rev-parse --git-common-dir)/info/exclude"` に `.claude/worktrees/` を足す（追跡されず、すべての作業ツリーに効く）。

## 3.4.3 の更新

- リモートの無い統合の事前確認は、読み取りだけの CLI `ai-dev-helm integrate-check --main <main のチェックアウト>` に変わった（`branch-workflow` の「リモートの無いプロジェクトの取り込み」）。3.4.2 の確認（main のチェックアウトの status が、未追跡ファイルを含めて空であること）は、ユーザーの未追跡ファイル（資料・レポート等）があると毎回止まった。3.4.3 からは、main のチェックアウトが trunk を開いていないこと、その追跡ファイルの未コミットの変更（skip-worktree / assume-unchanged で隠れた変更を含む）、main が feature の祖先でないこと、feature が足すパスにある追跡されていないもの（未追跡・ignore 済みのファイル、それらを含むディレクトリ、ファイルになっている親のパス）だけを、名前つきで出す。祖先でないだけなら止まらず、main を取り込んで quality-check と事前確認をやり直す。関係の無い未追跡ファイルには触れない。リモートの無い導入先は、独自に書いた統合の手順（status を見る・未追跡ファイルを退避する等）を、この CLI を使う配布元の手順への参照に置き換える。
- 「リモートが無い」は、PR を作る remote（通常は origin）の trunk の remote-tracking ref（例: `origin/main`）が無いことを言う。`<remote>/main` があっても、PR を受けない remote（公開用・デプロイ先・バックアップ。push 専用の remote は一度 push すると `<remote>/main` ができる）しか無い導入先は、リモート無しの手順を使い、その remote に feature ブランチを push しない。hook の案内も origin の trunk の追跡 ref（`origin/main` / `origin/master`）の有無で PR とリモート無しを出し分ける。
- 既存の package.json や CI に、`@crearize/` を付けない `npx` で `ai-dev-helm lint` を呼ぶ箇所が残っていれば置き換える（package.json の scripts の中なら `ai-dev-helm lint`、外なら `npx --no ai-dev-helm lint`、導入前や版を固定するなら `npx -y @crearize/ai-dev-helm@<version> …`）。スコープ無しの `npx` は、手元に無いと npm の別の名前を取りに行く。
- `@crearize/ai-dev-helm` を devDependency にしている導入先は、その版を 3.4.3 以上に上げる（古い版の CLI には `integrate-check` が無く、`Unknown argument` になる。出力が `integrate-check:` で始まらなければ判定ではないので、版を固定した `npx -y @crearize/ai-dev-helm@<version> integrate-check …` で実行し直す）。
- `.gitignore` を確かめる。`init` の再実行で `.claude/worktrees/` が足される（3.4.2 の節）。3.4.3 からは、無くてもリモートの無い統合は止まらない（`git status` の表示のため）。
- quality-check の共通コンテキスト（`quality-context`）は、未追跡ファイルを変更に含めず、件数と名前を別の節と WARNING に出す（スナップショットにもコピーしない）。変更に含める新規ファイルは、共通コンテキストを作る前に `git add`（`-N` 可）する。フラグの作成前に `quality-context --check-untracked` で、レビュー時に未追跡だったファイルが変更に入っていないことを確かめ、最後の行が `untracked-check: OK` のときだけフラグを作る（NG なら、変更に属するものは新しいサイクルでレビューをやり直す。属さないユーザーのファイルは消さず、まだ push していない直前のコミットからだけ `git rm --cached` → `git commit --amend` で外し、それより前のコミットや push 済みなら名前を示して止まる。`untracked-check:` で始まらない出力は判定ではないので、`--out` と版を直して実行し直す。quality-check の 4-0 と Step 6）。Step 5 のコミットはパスを指定して行う（`git add -A` を使わない）。

## 計測の範囲

`quality-context --cycle N` は `measurements.json` に生成処理の実測時間と取得時点のファイルハッシュを保存します。並列エージェント時間やタスク全体の時間には換算しません。棚卸し失敗は `inventory_error` に記録し、追加の品質ゲートにしません。

親子別トークン、最初の編集までの時間、人間の待ち時間・介入回数、実際にロードされたルールの記録は、この版では自動取得しません。実行基盤に受け取り口がある場合の連携が今後必要です。未取得値を推測で埋めず、モデルによる手書きの計測を完了条件に追加しません。したがって、この変更だけで工程別の総費用比較が完成したとは扱いません。

`quality-report --input <旧レポート.json>` は既存レポートの正規化結果を stdout、注意事項を stderr へ返します。元ファイルを上書きせず別ファイルへ保存してください。「指摘なし」は空配列、統合元は `sources`、根拠のない裁定・再掲判定は `unknown` とします。失われた検出者や過去の誤指摘判定は復元できません。正規化は通過判定の代わりにはなりません。
