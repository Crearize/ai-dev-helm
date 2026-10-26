# ハーネスの更新（`upgrade`）

導入先のハーネスを新しい版にする手順です。3.7.0 から、更新は `npx @crearize/ai-dev-helm upgrade` 1 つで行います。`upgrade` は、マニフェスト（`.ai-dev-helm.json`）に記録した版の配布物と新しい版の配布物を、同じ構成で描画して比べ、導入先のファイルごとに扱いを決めます。版ごとの移動表は持ちません（旧版の描画をそのまま比較元にするため）。最後に、配布物のすべてのファイルと hook の登録が導入先に入っているかを自動で照合し、入っていないものがあれば終了コード 1 で終わります（「導入されないまま完了になる」ことは無い）。

`init` は初回の導入のためのものです。導入済み（マニフェストがある）のプロジェクトで `init` を実行すると、`upgrade` を案内して何もせずに終わります（`--force` で 3.7.0 より前と同じ上書きの再実行）。

## 更新の手順

AI が行います。オーナーの作業はありません。

1. 更新用のブランチを作る（`chore/harness-<新版>` など）。
2. `npx -y @crearize/ai-dev-helm@<新版> upgrade --plan` で、何が起きるかを確かめる（何も書かない）。扱いの一覧（置換・三者マージ・衝突・新規・削除・削除を保持・seed・宣言で外す・登録の変更）、推した構成（3.7.0 より前のマニフェスト）、「二重登録のおそれ」が出る。
3. `npx -y @crearize/ai-dev-helm@<新版> upgrade --record <導入先の外のファイル>` で更新する。最後に照合が自動で走る。
4. 保留（`pending`）があれば解消する。各 `<file>.ai-dev-helm-new` を対応するファイルと比べ、導入先の独自の内容を残して新版の変更を取り込み、`.ai-dev-helm-new` を消してから `upgrade --resolve <path>` で保留から外す。ルート規則のブロックの衝突（`CLAUDE.md#harness` など）は、`CLAUDE.md.ai-dev-helm-new`（新版のファイル全体）の同じブロックの中身を取り込んで `--resolve CLAUDE.md#harness`。目印が無くて囲めなかったブロックは、下の「初回の移行」の 3 に従って囲んでから `--resolve`。保留を解消したら（hook 本体の衝突を直したときは必ず）、`upgrade` をもう一度実行する（保留のファイルは衝突したときの版を比較元にして比べ直すので、新版の変更が抜けていれば保留のまま残る。hook の登録もここで今の形になり、マニフェストの `complete` が更新される）。`--resolve` は、中身が衝突したときから変わっていない（`.ai-dev-helm-new` を取り込まずに消した）・空のときは拒否する。解消したファイル・ブロックは記録に「resolved by hand」として一覧で出るので、新版の変更を取り込めているかは更新の PR のレビューで確かめる（手でのマージは規則では判定できないため。照合は、衝突したときの中身に戻っていれば未導入にする）。
5. `npx -y @crearize/ai-dev-helm@<新版> upgrade --verify` が終了コード 0 になることを確かめる（未導入 0・保留 0）。
6. `npx -y @crearize/ai-dev-helm@<新版> hook-selftest` が全件通ることを確かめる（hook の判定表に加えて、登録が各 1 回・Codex の登録が呼ぶ実体がある・hook の写しが配布物と一致・スキルの写しが互いに一致）。
7. Codex を使う導入先で `.codex/hooks.json` が変わったら、`/hooks` で信頼し直す（下の「Codex の信頼」）。
8. quality-check（「ハーネスの更新の PR」の扱い — 下）→ PR → マージ。PR の本文に、`--record` の記録の「宣言で外したものの配布元の変更」の一覧を載せる。

### 結果の見方

- **新版と一致**: そのまま。
- **三者マージ**: 導入先が変えたファイルに新版の変更を取り込んだ（`git merge-file`）。照合は、新版で入った変更が残っていることを確かめる。
- **衝突（保留）**: 書き換えず、隣に `<file>.ai-dev-helm-new`（新版）を置き、マニフェストの `pending` に記録する。衝突の目印はファイルに書かない（制御面のファイルが壊れたまま hook が動かないように）。hook の本体（`.claude/hooks/*.cjs` など）は三者マージせず、導入先が変えていれば衝突にして、その hook の登録も更新しない。
- **導入先が消したファイル**: 足す。入れたくない部品は `exclude` に理由を付けて宣言する（下）。
- **配布物から消えたファイル**: 導入先が旧版のままなら消す。変えていれば残して一覧に出す。
- **宣言で外したもの**: 触らない。配布元で変わっていれば、記録に差分付きで出す（止めない）。取り込むかを PR のレビューで判断する。
- **未導入**: どれにも当たらないもの。終了コード 1。`upgrade` をやり直すか、理由があれば宣言する。

比べるときは BOM を除いて改行を LF にそろえ、書き戻すときは導入先のそのファイルの改行（CRLF / LF）と BOM に合わせます。git で管理しているファイルには `.backup.<時刻>` を作りません（git の履歴で戻せるため）。

旧版の配布物は `npm pack` で取ります（3 回まで取り直し、取れなければ何も書かずに終了する）。オフラインのときは、展開した旧版のパッケージを `--base-dir <dir>` で渡します。旧版のパッケージと描画は、版と構成ごとに利用者のキャッシュ（Windows は `%LOCALAPPDATA%\ai-dev-helm\render-cache`、ほかは `$XDG_CACHE_HOME` か `~/.cache` の下の `ai-dev-helm/render-cache`）に残し、同じ版の `--plan`・`upgrade`・`--verify` では作り直しません。キャッシュは実行するコードを含むので、共有の一時フォルダーには置かず、持ち主が自分でない・ほかの利用者が書ける場所なら使いません。

`upgrade` は、マニフェストより古い版では実行しません（新しい版の導入先を古い版で戻さない）。`--plan`・`--verify` と `--resolve` は一緒に使えません。

### ハーネスの更新の PR の quality-check

- 完了条件に「`upgrade --verify` が終了コード 0」を入れる。
- レビューの対象は、三者マージしたファイル・衝突を直したファイル・宣言（`.ai-dev-helm.json`）の変更・導入先の補足ファイル（`documents/development/project/`）だけ。照合で「新版と一致」と分かったファイルは、配布元の quality-check で確認済みなので見ない。共通コンテキストは `--record` の記録からこの範囲を作る。対象が無ければ（すべて新版と一致）、Step 4 は統合レビュアー 1 体が記録と宣言だけを確かめる。
- 「宣言で外したものの配布元の変更」の一覧をレビュアーに渡し、取り込みの要否を見る。

## 構成と宣言（`.ai-dev-helm.json`）

`upgrade` はマニフェストの構成を読み、同じ構成で描画します。引数（`--project-name`・`--tools`・`--stacks`・`--skills`）で上書きできます。配布元が書くキーだけを書き換え、導入先の独自のキー（`reviewBudgetScript` など）は残します。

| キー | 中身 |
|---|---|
| `version` / `upgradedFrom` / `appliedAt` / `complete` | 記録した版・直前の版・適用の時刻・未導入と保留が無いか |
| `tools` / `stacks` / `skillScope` / `skills` / `projectName` | 描画の構成。配布元に無いスタック名（`custom-*`）は、エラーにせずそのスタックの部品を入れないだけ |
| `exclude` | 入れない部品（`{ "part": "lint" | "review-guides" | "superpowers" | <スキル名>, "reason": "…" }`）かパス（`{ "path": "<glob>", "reason": "…" }`） |
| `owned` | 配布元が書かないパス（`{ "path": "<glob>", "reason": "…" }`）。既定で `documents/development/project/**` |
| `seed` | 無いときだけ作るパス。既定で `documents/development/error-codes.md`・`naming-conventions.md`・`coding-rules/**`・`test-recommendation-ledger.md` |
| `pending` | 衝突が残ったファイル（`{ path, baseVersion }`、ルート規則のブロックは `block` 付き） |
| `skillTargets` | スキルの木ごとの置き先（例 `{ "project": [".claude/skills"] }`） |
| `settings.mergeDeny` | `false` で `permissions.deny` をマージしない（下の保護ブランチの拒否も足さない） |
| `gate.script` / `reviewBudgetScript` | 配布の `quality-gate.cjs` / `review-budget.cjs` の代わりに登録する導入先のゲート・review-budget の実体（リポジトリ直下からの相対パス。`.cjs` / `.mjs` / `.js`）。登録は配布と同じ形のラッパーで宣言のパスを呼び、配布の本体は写さない（どれかの登録（Codex など）が配布の写しを呼び続けていれば、その写しは普通の hook 本体として更新・照合する。どの登録も呼ばない写しは更新しないので、宣言した実体が配布の本体を `require` するなら、宣言をやめるか、その実体の側で版をそろえる）。`hook-selftest` は配布の判定表をこの実体に当てる |
| `gate.controlPlane` / `gate.exemptDocs` / `gate.harness` | ゲート制御面・ハーネスのみの免除（文書だけ）・スピードモードのハーネスの分類に足すパスの glob の配列。hook が判定するリポジトリの `.ai-dev-helm.json` から読み、読めない・コミットしていない変更があるときはゲート対象のコマンドを block する（`quality-check`「hook の完全な契約」の「導入先の拡張点」）。`.ai-dev-helm.json` 自体はゲート制御面 |
| `settings.enabledPlugins` | `.claude/settings.json` の `enabledPlugins` に書くプラグインの有効・無効（例 `{ "superpowers@claude-plugins-official": false }`。書いたキーだけを入れ、ほかは残す） |
| `workflow` | 運用の形。`remote: "none"`・`issues: "none"`（リモートなし・Issue なし。development-policy の当てはめが変わる）、`protectedBranches`（main・master のほかに force push を禁じるブランチ。deny と Codex の rules に入る） |
| `apps` | アプリの置き場所（`{ "frontend": "apps/web", "backend": "api" }`）。Cursor の `.mdc` の globs をここから作る（既定は `frontend`・`backend`） |

宣言には理由が必須です。ハーネスの規則を持つファイル（スキルの本体と references、hook、ルート規則、配布文書の本文など、既定の seed 以外の配布物）は `owned` にも `seed` にもできません（`upgrade` が拒否する）。ルート規則（`CLAUDE.md`・`AGENTS.md`・`.cursorrules`）と専用のマージのファイル（`.claude/settings.json`・`.codex/hooks.json`・`.codex/config.toml`・`.codex/agents/`・`.gitignore`）は、`exclude` にもできません（ルート規則は管理ブロックの中だけを扱い、外の製品の節には触れないため。専用のマージは導入先のキーを残すため）。`skillTargets` と `pending` のパスは導入先の中の相対パスに限ります（`..`・絶対パス・`.git` は拒否する）。導入先の製品の内容は、補足ファイル `documents/development/project/<スキル名>.md` に置きます。配布文書（`documents/development/` の `.md`。スキルの中は補足ファイルを使う）の中に導入先の節を残すときは、`<!-- ai-dev-helm:local:start -->` 〜 `<!-- ai-dev-helm:local:end -->` で囲みます。`upgrade` は区切りの中を三者マージの前に取り出し、マージの後に同じ場所（同じ見出しの節の中で、直前の行と同じ行の同じ番目の後。その行が消えていれば節の末尾、その場所がコードブロックの中になっていれば節の末尾で記録に出る、見出しも消えていればファイルの末尾で記録に出る）へ戻します。照合（`--verify`）は区切りの中を除いて比べます。

## 初回の移行（3.6.0 以前から）

1回だけ行います。2 回目からは「更新の手順」だけです。

1. `upgrade --plan` で扱いと推した構成を確かめ、マニフェストに `projectName`・スキルの一覧（custom のとき）・必要な宣言（`exclude`・`owned`・`seed`・`skillTargets`）を足す。`stacks` は実際に入っている部品に直す。
2. スキルに足した独自の節（製品の当てはめ・コマンド・パス・ポート）を `documents/development/project/<スキル名>.md` へ移す（スキルの本体は配布物と一致させる）。
3. ルート規則（`CLAUDE.md`・`AGENTS.md`・`.cursorrules`）のハーネスの節は、`<!-- ai-dev-helm:harness:start -->` 〜 `end`、Skills の節は `ai-dev-helm:skills`、Reference Documents の節は `ai-dev-helm:refs` の管理ブロックになる。`upgrade` は、テンプレートの `##` の見出しが導入先で 1 続きに見つかれば自動で囲む。導入先の節が間に挟まっている・見出しを訳している場合は囲まずに保留にするので、その範囲を目印で囲み（中は新版のテンプレートのブロックにそろえ、導入先の節は目印の外へ出す）、`upgrade --resolve CLAUDE.md#harness` で外す。
4. 導入先の手順書の「版ごとの記録」や、`init` を禁じる規則など、更新の流れの独自の規則は消す（`--record` の記録が置き換える）。
5. 上の「更新の手順」の 3 以降を行う。

## Codex の信頼

Codex を使う導入先では、`/hooks` で `.codex/hooks.json` のフックを信頼するまで、quality-gate も review-budget も context-handoff も動かない（警告も出ない）。`upgrade` は、ゲートと review-budget を呼ぶ登録が既にあれば `.codex/hooks.json` のその登録に一切触れない（matcher も変えない）。context-handoff（3.7.1 から。`PreCompact`・`SessionStart`・`Stop`）は、それを呼ぶ登録の無いイベントにだけ、その配列の末尾に足す（既存の登録の中身と順番は変えないので、今のフックの信頼は外れない）。足した 3 件は、Codex の起動時の確認（Hooks need review）で利用者が信頼する（信頼するまで context-handoff だけが動かない。MCP の承認には影響しない）。無いときだけ足すので、`hooks.json` が変わったら（matcher・command・timeout・順序）、再び信頼する（`.cjs` の中身だけの更新では信頼は外れない）。信頼は Codex の設定の場所（`CODEX_HOME`）ごとに記録されるので、Codex のアカウント・設定の場所を切り替えたら（orca のアカウントの切り替えなど）、切り替えた先でも信頼する。`npx @crearize/ai-dev-helm codex-trust --dir <導入先> [--codex-home <設定の場所>]` で、プロジェクトとフックが信頼されているかを読み取りだけで確かめ、終了コード 0 になるまで対応する。

## 診断（`harness-inventory`）

`upgrade` の前に、配布物と導入先の読込元の差を調べたいときに使います（更新の手順には要りません）。

```powershell
node <配布元>/bin/cli.js harness-inventory --dir <導入先> --baseline <比較する版の配布元>
```

JSON を導入先の外へ保存します。Windows PowerShell 5.1 では `> file.json`（既定 UTF-16）を避け、`| Set-Content -Encoding utf8 -LiteralPath <保存先.json>` を使います。診断はファイルを読み、raw SHA-256 と BOM・改行正規化後の SHA-256 を返します。導入先を書き換えません。`AGENTS.override.md` / `CLAUDE.local.md` / `.claude/CLAUDE.md` / `.claude/CLAUDE.local.md`、親ディレクトリ・ユーザー共通の指示、設定から参照される任意の外部 hook は自動解決しないので、使う導入先では実際の読込元を確認します。

同期時のハーネス方針は配布元の `scripts/skill-overlays/`（ハーネスが持つ overlay と、基にした上流ファイルのハッシュ・一覧）で管理します。導入先で上流へ手動適用する必要はなく、変換済みの配布物を使います。

## 版ごとの補足

以下は各版で変わった規則の要約です。`upgrade` が配布物を入れるので、導入先で手作業の反映は要りません。導入先が独自に書いた同じ趣旨の規則を消すときの手がかりにします。

### 設計ゲートとモデル表の更新

設計完了後のレビュー依頼が省かれる問題と、モデル世代の更新（Claude Opus / Sonnet 5.5、GPT-6.1 Sol）を取り込みます。

- **設計ゲート**: 配布する brainstorming / writing-plans / using-superpowers とレビュー依頼文 2 種、テンプレートの Development Philosophy 2 項・Design Confirmation Rules を反映します。導入先で独自に書き換えた brainstorming がある場合も、「設計完了 → `document-reviewer` による設計レビュー → 設計とレビュー結果をユーザーへ 1 通で示し承認まで止まる」の 3 段と、免除の範囲が development-policy §1.0（承認済み設計の範囲内の修正を含む）に従うことを残します。外部 plugin を直接読む導入先は、その読込元にも同じ変更が必要です。
- **Claude のモデル**: ユーザー設定の `model` は `claude-opus-5-5` へ（`personal --upgrade-model` または対話で確認）。テンプレートやプロジェクト設定に `fable` を既定として書いている箇所は `opus` へ戻し、Fable は難所の格上げに限ります。Opus 5 以前・Sonnet 5 以前・Haiku の指定は削除します。別名が旧版に解決される環境では 5.5 のモデル ID を明示します。
- **Codex のモデル**: `init` / `personal` の再実行で、旧版のまま変更されていない `.codex/agents/helm-*.toml` と、`[agents] default_subagent_model = "gpt-5.6-terra"` を新しい値へ更新し、更新した旨を表示します。`helm-doc-reviewer.toml` と、見た目・編集判断を要する制作用の `helm-visual-producer.toml` が新たに追加されます。プロジェクト独自のモデル指定（制作中心のプロジェクトの実装モデル、Cursor 独自モデル等）は残さず、ハーネスの表に統一します（製品コードが使うモデル ID は対象外）。独自に変更したエージェント定義と、旧既定値以外のモデル指定は保持されるため、`Preserved customized managed role file` と表示されたファイルは手動で確認します。GPT-6 Luna と GPT-5.6 系の指定は残さず、最も軽い作業も `gpt-6.1-sol` / `low` を下限にします。最終品質レビュー（`helm-reviewer`）は `gpt-6-astra` / `high` のままです。

更新後は、小さな実装依頼でも設計レビューの予約・依頼と、ユーザーへのレビュー依頼が行われること、各ツールで実際に選ばれるモデルが上記になっていることを実際の読込元で確認します。

### review-budget の更新（3.3.0）

- phase `production`（制作時のデザインレビュー）と `mutation`（ミューテーション分類の検証）が加わった。独自のローカル回避策（`--phase quality` の読み替え、ミューテーション用の独自スクリプト）は、動作を確かめてから外す。
- `requirements` / `design` / `plan` / `production` の予約は main / master 上で拒否される。先にタスクブランチを作る。
- `HELM_REVIEW:` のマーカーは message / prompt の 1 行目だけが有効。レビュー語を含まない実装の依頼は、予約なしで通る。
- Claude Code の hook の matcher に `SendMessage` が加わった。`init` の再実行で更新される（Codex の matcher は変わらず、信頼の再確認は要らない）。
- 上限を超えるときは、オーナーの承認後にエージェントが `review-budget extend` を実行する。「状態ファイルを退避する」手順は不要になった。
- 配布した hook（`.claude/hooks` と `.codex/hooks`）は全コピーを同時に更新する。古い hook は `extensions` を持つ状態を不正と判定する。

### マージの既定（3.4.1）

3.4.1 から、設計の承認はマージを含む。設計との差異が無ければ AI がマージし、差異があればマージの前に最後の 1 通で確認する（`development-policy.md` §1.0「承認後の進め方」1）。3.4.0 の「プロジェクトの規則がマージを定めていなければマージしない」を前提にしていた導入先は、マージの前にオーナー承認が必要なら、その旨をプロジェクトの規則（CLAUDE.md / AGENTS.md / .cursorrules）に書く（例外 X2 になる）。マージで自動的に本番（客先・利用者に影響する環境）へのリリース・公開・デプロイが走るプロジェクトも X2 として扱われる。

### 3.4.2 の更新

- 本番の DB・本番の決済・実際の客先への送信等を使わない、動作確認用の環境（staging 等）への自動デプロイは X2 に当たらない（名前ではなく、客先・利用者に影響するかで決める）。
- main から本番ブランチ（`release` 等）へ反映する運用の OK の範囲は §1.0「承認後の進め方」8 による。
- 導入先が独自に書いた同じ趣旨の規則（「staging は X2 でない」、本番への反映の範囲の聞き方）は、配布元の文と重なるので、配布元への参照に置き換える。
- `init` の再実行は、`.gitignore` に `.claude/worktrees/`（Claude Code の標準の作業ツリーの置き場所）を足す。
- `init` を再実行しない導入先は、同じ行を手で足す（`git status` の表示に作業ツリーが出ないようにするため。3.4.3 からは、無くてもリモートの無い統合は止まらない）。
- 必要なら（`.gitignore` の更新を統合する前から `git status` の表示を整えたいとき）、`"$(git rev-parse --git-common-dir)/info/exclude"` に `.claude/worktrees/` を足す（追跡されず、すべての作業ツリーに効く）。

### 3.4.3 の更新

- リモートの無い統合の事前確認は、読み取りだけの CLI `ai-dev-helm integrate-check --main <main のチェックアウト>` に変わった（`branch-workflow` の「リモートの無いプロジェクトの取り込み」）。3.4.2 の確認（main のチェックアウトの status が、未追跡ファイルを含めて空であること）は、ユーザーの未追跡ファイル（資料・レポート等）があると毎回止まった。3.4.3 からは、main のチェックアウトが trunk を開いていないこと、その追跡ファイルの未コミットの変更（skip-worktree / assume-unchanged で隠れた変更を含む）、main が feature の祖先でないこと、feature が足すパスにある追跡されていないもの（未追跡・ignore 済みのファイル、それらを含むディレクトリ、ファイルになっている親のパス）だけを、名前つきで出す。祖先でないだけなら止まらず、main を取り込んで quality-check と事前確認をやり直す。関係の無い未追跡ファイルには触れない。リモートの無い導入先は、独自に書いた統合の手順（status を見る・未追跡ファイルを退避する等）を、この CLI を使う配布元の手順への参照に置き換える。
- 「リモートが無い」は、PR を作る remote（通常は origin）の trunk の remote-tracking ref（例: `origin/main`）が無いことを言う。`<remote>/main` があっても、PR を受けない remote（公開用・デプロイ先・バックアップ。push 専用の remote は一度 push すると `<remote>/main` ができる）しか無い導入先は、リモート無しの手順を使い、その remote に feature ブランチを push しない。hook の案内も origin の trunk の追跡 ref（`origin/main` / `origin/master`）の有無で PR とリモート無しを出し分ける。PR を受ける remote が origin 以外の名前の導入先は、hook の案内ではなく branch-workflow の表で判断する。
- 既存の package.json や CI に、`@crearize/` を付けない `npx` で `ai-dev-helm lint` を呼ぶ箇所が残っていれば置き換える（package.json の scripts の中なら `ai-dev-helm lint`、外なら `npx --no ai-dev-helm lint`、導入前や版を固定するなら `npx -y @crearize/ai-dev-helm@<version> …`）。スコープ無しの `npx` は、手元に無いと npm の別の名前を取りに行く。
- `@crearize/ai-dev-helm` を devDependency にしている導入先は、その版を 3.4.3 以上に上げる（古い版の CLI には `integrate-check` が無く、`Unknown argument` になる。出力が `integrate-check:` で始まらなければ判定ではないので、版を固定した `npx -y @crearize/ai-dev-helm@<version> integrate-check …` で実行し直す）。
- `.gitignore` を確かめる。`init` の再実行で `.claude/worktrees/` が足される（3.4.2 の節）。3.4.3 からは、無くてもリモートの無い統合は止まらない（`git status` の表示のため）。
- quality-check の共通コンテキスト（`quality-context`）は、未追跡ファイルを変更に含めず、件数と名前を別の節と WARNING に出す（スナップショットにもコピーしない）。変更に含める新規ファイルは、共通コンテキストを作る前に `git add`（`-N` 可）する。最初の push の前（Step 5 のコミットの後）とフラグの作成前に `quality-context --check-untracked` で、レビュー時に未追跡だったファイルが変更に入っていないことを確かめ、最後の行が `untracked-check: OK` のときだけ push・フラグの作成に進む（NG なら、変更に属するものは新しいサイクルでレビューをやり直す。属さないユーザーのファイルは消さずに外す: ステージしただけなら `git rm --cached` だけ、まだ push していない直前のコミットなら `git rm --cached` → `git commit --amend --no-edit`（そのコミットが NG に出たユーザーのファイルだけなら `git reset --soft HEAD~1` → `git rm --cached`）。それより前のコミットや push 済みなら名前を示して止まる。`untracked-check:` で始まらない出力は判定ではないので、`--out` と版を直して実行し直す。quality-check の 4-0 と Step 6）。Step 5 のコミットはパスを指定して行う（`git add -A` を使わない）。

### 3.5.0 の更新

- `init` の再実行で、`.claude/hooks/context-handoff.cjs` が入り、`.claude/settings.json` の `PreCompact`・`SessionStart`（matcher `compact|clear`）・`SessionEnd`（matcher `clear`）・`Stop` に登録される（既存のユーザーのフックは残る。再実行で重複しない）。コンパクトと `/clear` の前後で会話の記録を保存して戻す（`harness-runtime.md` の「会話の記録の引き継ぎ」）。Codex だけの導入先には何も入らない。
- テンプレートの CLAUDE.md に「Compact Instructions」の節が増えた。導入先の CLAUDE.md にも同じ節を足す（独自の節が既にあれば、同じ趣旨を残して一つにまとめる）。
- 全体設定（`~/.claude/settings.json`）にも同じフックを `--scope=global` で入れている環境では、導入先ではプロジェクトの登録だけが動く。
- 導入先が独自に、コンパクトの前後で記録を残す仕組み（フック・手順）を持っていれば、この仕組みに寄せて消す。

### 3.6.0 の更新

- レビューは最大 2 巡になり、直して確かめるのは高の指摘だけになった（中は PR の本文に残し、低は出させない。優先度の基準は `quality-check` SKILL.md Step 4「指摘の優先度（基準）」）。`review-budget.cjs` は `quality` / `production` の既定の上限を 2 にし、初回の `--limit` に 2 を超える値を拒否する。3.6.0 より前に予約を始めたブランチは上限 3 のまま読む。
- 「スピード優先」モード（`quality-check`「スピード優先モード」）が入った。quality-gate hook はフラグの `mode` を読み、スピードモードのフラグではハーネスの変更を通さない。
- 自動テストで製品の AI を呼ばない原則と、E2E で実 AI を通す判定（quality-policy §3、test-recommendation）。
- `init` は既存の `CLAUDE.md` / `AGENTS.md` / `.cursorrules` を上書きしない。テンプレートの次の部分を導入先に写す: 開発思想の「Automated tests ... never call the product's AI」の行、Quality Check Flow の Step 4、Review Roster の表の Verification Reviewer の行・Completion criteria・「At most 2 review rounds」・Finding severity の行、「Speed Mode (「スピード優先」)」の節、Merge Gate の What passes の括弧書き。導入先に独自のレビューの回数・指摘の対応の規則があれば、ハーネスの規則に寄せて消す。
- PR テンプレート（`.github/PULL_REQUEST_TEMPLATE.md`）に Mode・Deferred review issue・Unaddressed Review Findings の欄を足す。
- 導入先が独自にレビュー結果を照合する仕組み（受領書の検証など）を持っていれば、中の `open` を通し、スピードモードの受領書（レビューの記録が無く、後回しの Issue がある）を受け付けるように合わせる。

### 3.7.0 の更新

- quality-check に「取り込みの再確認」が入った。フラグの後に main を取り込んだ（merge・rebase）だけなら、`quality-context --merge-only`（前回のフラグの commit と比べる）が YES のとき、レビューと追加テストをやり直さず、Step 2〜3 だけでフラグを作り直す（`references/carried-recheck.md`）。導入先が独自に「main の取り込みのたびに品質チェックをやり直す」規則を書いていれば消す。
- 更新は `upgrade` で行う（この文書の前半）。初回の移行（3.6.0 以前から）で、マニフェストに構成と宣言を足し、ルート規則のハーネスの節を管理ブロックにする。`init` の再実行は `--force` が要る。PR テンプレートと `.github/review-prompt.md` は常に上書きから、編集を残す扱い（`init` はハッシュで守り、`upgrade` は三者マージ）になった。
- hook の登録は、コマンドの文字列ではなく呼ぶ実体（`.claude/hooks/<名前>.cjs`）で見分けるようになった。手で書き換えた登録・旧い版の登録は、`upgrade` で今の形の 1 件に置き換わる（導入先が足した `statusMessage` などのキーは残る）。導入先の独自の照合（登録が 1 回か、hook の写しが配布物と同じか）は、`hook-selftest` の照合に置き換えて消す。
- レビュー・品質チェックの規則（優先度の基準、巡の数、検証の巡、スピード優先モード、後回しのレビュー、完了条件、hook の完全な契約）の本文は `quality-check` スキル（本体と `references/`）だけに置くようになった。テンプレート（CLAUDE.md・AGENTS.md・.cursorrules）の「Quality Check Rules」「Design Confirmation Rules」「Autonomy Principles」は、規則の名前・1〜2 行の要約・正本への参照だけになった。導入先のルート規則の同じ節も、テンプレートの新しい節に置き換える（導入先の独自の節は残す）。
- `quality-check`・`test-recommendation`・`lint-scaffolding`・`test-design` は、本体（`SKILL.md`）と、その段で読む `references/` に分かれた。スキルを実コピーで持つ導入先は `references/` も写す。
- 各スキルは、導入先の補足ファイル `documents/development/project/<スキル名>.md` があれば、その段で読む。補足ファイルは製品への当てはめだけを持ち、スキルの規則を緩めない（食い違えばスキルが優先する）。導入先がスキルの本体に足した製品の当てはめ（コマンド・パス・ポートなど）は、このファイルへ移す。
- ゲート制御面に、リポジトリ直下の `.mcp.json` が入った。release-please のリリースの PR の差分は、条件を満たせば免除される（`quality-check`「ハーネスのみ変更の免除」の「リリースの差分の免除」）。
- hook の拡張点（設計 C3h）: 導入先の独自のゲート・review-budget は `gate.script`・`reviewBudgetScript` で宣言し、制御面・免除・スピードモードの分類に足すパスは `gate.controlPlane`・`gate.exemptDocs`・`gate.harness` に書く（上の表）。hook の写しへのローカルパッチ（パターンを足す・実体を差し替える）は、これに移して消す。`.ai-dev-helm.json` はゲート制御面になったので、マニフェストを変える PR（ハーネスの更新の PR を含む）は免除されない。
- 導入先のローカルパッチの取り込み（設計 C3i）: quality-gate は `git push --dry-run` / `-n` をゲート対象から外し、同じコマンドの別の行の `git merge` / `git pull` / `git rebase` を、trunk に届く push / merge の前にあれば拒否するようになった。review-budget はロックを最大 2 秒待ち、古さでロックを外さなくなり（自分のロックは名前を変えてから消す）、Codex の `agent_name`・下線区切りの名前・`collaboration` で始まるツール名を読むようになった（配布の Codex の登録では `collaboration` の名前は届かない — `harness-runtime.md`）。同じ趣旨のパッチを hook の写しに当てていた導入先は、`upgrade` で配布物に置き換えて消す。

## 計測の範囲

`quality-context --cycle N` は `measurements.json` に生成処理の実測時間と取得時点のファイルハッシュを保存します。並列エージェント時間やタスク全体の時間には換算しません。棚卸し失敗は `inventory_error` に記録し、追加の品質ゲートにしません。

親子別トークン、最初の編集までの時間、人間の待ち時間・介入回数、実際にロードされたルールの記録は、この版では自動取得しません。実行基盤に受け取り口がある場合の連携が今後必要です。未取得値を推測で埋めず、モデルによる手書きの計測を完了条件に追加しません。したがって、この変更だけで工程別の総費用比較が完成したとは扱いません。

`quality-report --input <旧レポート.json>` は既存レポートの正規化結果を stdout、注意事項を stderr へ返します。元ファイルを上書きせず別ファイルへ保存してください。「指摘なし」は空配列、統合元は `sources`、根拠のない裁定・再掲判定は `unknown` とします。失われた検出者や過去の誤指摘判定は復元できません。正規化は通過判定の代わりにはなりません。
