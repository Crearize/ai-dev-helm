# Harness runtime: models and review admission

この文書はモデル選択・レビュー起動の共通規約です。テンプレートと配布スキルから参照し、同じモデル表を重複管理しません。ユーザーが指定した小さいレビュー上限は常に優先します。実装・探索・テストをレビュー回数に含めません。

## 親の実装と委譲の選択

親が直接実装することを認めます。実装のためだけに別モデルへ渡す必要はありません。計画の詳細化、引き継ぎ、再探索、統合、手戻りを含む総労力で選び、独立した課題の並列化やコンテキスト分離に利益があるときに委譲します。委譲する計画には担当範囲・契約・検証方法を記し、実装コードの転記を求めません。

以下は**委譲時の推奨**です。利用可能なモデルとユーザー指定を確認して使います。品質レビューには十分な能力を維持し、仕様・外部契約・実動作など作者と独立した根拠を渡します。別モデルであることだけを独立性の証明にしません。

## 使わないモデル

この方針は、エージェント・サブエージェント・委譲で使うモデルの選択にだけ適用する。製品のコードや設定が呼び出すモデル ID（製品の LLM 機能）は対象外で、書き換えない。

- Claude は **Opus 5.5 / Sonnet 5.5 以降**だけを使う。Opus 5 以前・Sonnet 5 以前・Haiku は、どの作業にも使わない。性能・効率に加え、旧モデルの提供終了で設定が壊れることを避けるため。
- Codex は **GPT-6 Luna を使わない**。最も軽い作業でも `gpt-6.1-sol` / `low` を下限とする。GPT-5.6 系（Sol / Terra / Luna）は移行期間中の旧世代であり、新しい設定に書かない。
- Cursor 独自のモデル（Composer 等）は表に載せず、使わない。Cursor では表の Claude モデルを名前で選ぶ。
- Claude の別名（`opus` / `sonnet` / `fable`）は、Anthropic API ではその系列の最新版を指し、Claude Code の更新で追従する。Task の `model` には別名だけを渡す。別名が旧版に解決される環境（Bedrock 等のクラウド事業者経由、`availableModels` による制限等）では、Task の引数ではなく環境変数や settings（例: `ANTHROPIC_DEFAULT_OPUS_MODEL`）に 5.5 のフル ID を固定する。Codex と Cursor は版を含むモデル名を直接指定するため、新しいモデルが出たらこの表を更新して配布する。

## Claude Code / Cursor のモデル選択

| 作業 | 推奨モデル |
|---|---|
| 設計・計画（メインセッション） | `opus`（Opus 5.5）。Opus を高 effort にしても足りない難所だけ `fable`（Fable 5.1） |
| 設計・計画の文書レビュー | `opus` |
| 設計済みの実装・テスト追加 | `sonnet`（Sonnet 5.5）。判断の難しい課題は `opus` |
| 見た目・編集判断を要する成果物の制作（スライド・画像・UI の見た目、動画の切り抜き候補選定など） | `opus` |
| 探索・設計判断のない文章確認 | `sonnet` |
| 最終品質レビュー（制作時のデザインレビューを含む） | `opus`、利用可能な環境では `gpt-6-astra` / `high` も可 |

Claude の Agent / Task の `model` には別名（`opus` / `sonnet` / `fable`）だけを渡します。フル ID は受け付けません。別名が旧版に解決される環境では、環境変数や settings（例: `ANTHROPIC_DEFAULT_OPUS_MODEL`）で 5.5 のフル ID を固定し、Task の引数には入れません（上の「使わないモデル」を参照）。Cursor では Claude Opus 5.5 / Claude Sonnet 5.5 を名前で選び、旧版を選びません。親モデルの実装可否をこの表で制限しません。

選定根拠（2026-10 時点の公開値）: Opus 5.5 は Anthropic 公表の比較で Fable 5.1 を全項目で上回り（SWE-bench Pro 89.9% 対 81.2%、知識労働の GDPval 1846 対 1735）、トークン単価は Fable の 4 割（$4 / $20 対 $10 / $50）。Sonnet 5.5 は単価が Opus の半分で日常的な実装に向くが、effort を最大にすると出力トークンが増えて 1 タスクあたりの費用が Opus を上回るため、実装では既定の effort を保つ。

## Codex のモデル選択

| 作業 | モデル / effort | 配布するカスタムエージェント |
|---|---|---|
| 設計・計画・高度な判断（メインセッション） | `gpt-6.1-sol` / `high`。Sol で足りない難所だけ `gpt-6-astra` / `high` | `helm-designer` |
| 設計・計画の文書レビュー | `gpt-6.1-sol` / `high` | `helm-doc-reviewer` |
| 設計済みの実装・テスト追加 | `gpt-6.1-sol` / `medium` | `helm-implementer` |
| 見た目・編集判断を要する成果物の制作 | `gpt-6.1-sol` / `high` | `helm-visual-producer` |
| 探索・コンテキスト収集・設計判断のない文章確認 | `gpt-6.1-sol` / `low` | `helm-explorer` |
| 最終品質レビュー（制作時のデザインレビューを含む） | `gpt-6-astra` / `high` | `helm-reviewer` |

- 設計・計画の文書レビューを Sol / high とする理由: 整合性・抜け・契約の確認が中心で、Sol と Astra の差が小さいため。設計のレビューは Sol / high で行い、Astra は最終品質レビューにのみ使う。
- 起動時に利用可能モデルの一覧を確認する。表のモデルが未提供なら、黙って他モデルへ変更せず制約と代替案を報告する。品質レビュー・設計を下位の設定へ落とさない。
- 実際のツール定義を正とする。`spawn_agent` が `reasoning_effort` を受ける環境ではその名前を使う。設定 TOML のキーは `model_reasoning_effort`。`model` と effort の両方を指定する。
- モデル指定の委譲は `fork_turns: "none"`（または必要最小限の履歴）で行う。全履歴フォークでのモデル上書きを前提にしない。課題、対象ファイル、入出力、禁止事項、検証方法を短い依頼に含める。
- `agent_type` を受ける環境では `.codex/agents/helm-*.toml` を選べる。未対応なら上表のモデル・effort を直接指定する。カスタム定義に書かれたモデルが起動時指定を上書きする点に注意する。
- `[agents]` の既定は `gpt-6.1-sol` / `medium`。省略による親モデル継承を避けるための補助であり、役割別指定を省略する理由にはしない。
- 機能の有無はツール一覧で確認する。独立した課題を子へ渡し、親は別の統合作業を進める。子の出力を根拠・テスト結果と照合して統合する。子へ追加レビューや更なる委譲を一律に許可しない。
- スキルは配布先 `.codex/skills` から読み込める。起動時のスキル一覧に現れることを確認し、現れない場合は AGENTS.md の明示パスで必要な SKILL.md を読む。未発見を読み込み済みとして扱わない。

選定根拠（2026-10 時点の公開値）: GPT-6.1 Sol はエージェント型コーディング（DeepSWE 75.2 対 Astra 74.8）と総合指標（AA 指数 52 対 53）で Astra にほぼ並び、1 タスクあたりの費用は約 1/5〜1/7（DeepSWE で $0.65 対 $4.43）。出力トークン数は Astra の約 1.4 倍だが、単価差がそれを上回る。一方、不具合の原因究明（TroubleshootingBench 48.0 対 63.5）とセキュリティ（SEC-Bench Pro 78.8 対 85.4）は Astra が明確に上のため、最終品質レビューは Astra に残す。見た目の判断を伴う制作は、画面操作の評価（OSWorld 2.0: Sol 71.4 対 Astra 73.5）で差が小さいため Sol を high で使い、制作物のレビューは最終品質レビューと同じ Astra とする。制作を委ねるエージェントの名前（task_name 等）と description に「review」「レビュー」を含めない（review-budget がレビューとして数える）。GPT-6.1 Astra は未公開。

下記レビュー制御は両ツール共通です。

## レビューだけを数える

設計・要件・計画・最終品質チェックのレビューは、**起動直前**に一巡を予約する。設計等は通常一巡。必要性が事前に認められる文書レビューのみ初回予約で `--limit 3` を指定できる。ユーザーが「一度だけ」と指定した場合は必ず `--limit 1`。品質レビューの既定の絶対上限は2巡（3.6.0。各巡で何を見るかは quality-check の 4-3「サイクルルール」、上限の値は quality-policy §5 を正とする）。制作時のデザインレビューは phase `production`（既定の上限は2巡）。`quality`・`production` では初回予約の `--limit` に 2 を超える値は指定できない（超えるのはオーナーの承認の後の `extend` だけ）。3.6.0 より前に予約を始めたブランチは、その時の上限（3）のまま読む。ミューテーション分類の検証は phase `mutation`（`falsification-qa` 1 体・上限は 1 に固定）で予約する。`requirements` / `design` / `plan` / `production` の予約はブランチごとなので、main / master 上では拒否される（先にタスクブランチを作る）。工程内の通常テスト、修正、探索、結果待ちは予約不要。

プロジェクトルートで実行（Codexのみのプロジェクトでは `.claude` を `.codex` に置き換える）:

```sh
node .claude/hooks/review-budget.cjs status
node .claude/hooks/review-budget.cjs begin --phase quality --roles integrated-reviewer,falsification-qa
```

正式な呼び方は上の `node .claude/hooks/review-budget.cjs`（Codex のみなら `.codex`）。パッケージ CLI（`npx --no ai-dev-helm review-budget …`。CLI が入っていなければ `npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> review-budget …`）は同じ状態を扱い、`.ai-dev-helm.json` の `reviewBudgetScript`、`.claude/hooks/review-budget.cjs`、`.codex/hooks/review-budget.cjs` の順に見つけたスクリプトへ処理を任せる。どれも無いときだけ同梱のスクリプトを警告つきで使う。未インストールの旧リリースを `npx` で取得して回避しない。

1. チェックが通り、レビューを行う場合にだけ `begin` を呼ぶ。戻り値の `round` はレビュー回数であり、レポートの `total_cycles`（機械チェックを含む工程数）とは別。`quality-context --cycle` には継続中の工程番号を渡す。例えば失敗した3工程の次で初めてレビューする場合、工程番号は4、予約の round は1となる。レビュー開始のために工程番号を1へ戻したり、継続中のレポートやスナップショットを初期化したりしない。
2. 戻り値 `markers` の該当ロールの行（`HELM_REVIEW:…:integrated-reviewer` 等）を **各レビュアーへの message / prompt の先頭にそのまま置く**。起動名も `reviewer` を含む名前にする。Claude の `Agent` / `Task`、Codex の `spawn_agent` で同じ手順を使う。マーカーは message / prompt の**1 行目**に置く（2 行目以降の `HELM_REVIEW:` はマーカーとして扱わない）。実装の依頼で 1 行目にマーカーを書き写さない。レビューでない作業（制作・修正）は、名前と description にレビュー語（review / reviewer / レビュー）を入れない。
3. 共通コンテキスト生成と結果統合は既存 quality-check に従う。初回は `integrated-reviewer`、コード変更なら `falsification-qa`、専門家は `security-engineer` / `requirements-analyst` / `performance-engineer` の最大1体。2巡目以降は `verification-reviewer` と条件付き `falsification-qa`。文書レビューは phase `requirements` / `design` / `plan`、role `document-reviewer`。制作時のデザインレビューは phase `production`（1 巡目 `integrated-reviewer` + 任意で `falsification-qa`、2 巡目以降 `verification-reviewer` + 任意で `falsification-qa`。専門家の席は無い）。ミューテーション分類の検証は phase `mutation`、role `falsification-qa`。
4. 同じ一巡の複数ロールは1回。各ロールの起動情報は一度限り。既存レビュアーへの再検証依頼（`followup_task` / `send_message` / `send_input` / `SendMessage` / Agentの `resume`）も新しい一巡を予約する。待機・結果取得は追加レビューではない。レビュー依頼の追記は起動前にまとめ、起動後の連絡で実質的な再レビューを増やさない。
5. 拒否されたら迂回しない。上限に達したら、`quality`（quality-check）・`production`（制作物の最終品質レビュー）・`design` と `requirements`（設計の承認前のレビュー）は残存事項をオーナーに報告し、判断を待つ。設計の承認後のほかのフェーズ（`plan`・`mutation`）は、追加のレビューを求めずに残った指摘と扱いを記録して進む（`development-policy.md` §1.0「承認後の進め方」5）。実装・探索・通常テストはこの上限では止めない。構造的問題や停滞は別の報告理由であり、無根拠な修正の繰り返しを求めるものではない。

状態は Git common directory の `ai-dev-helm-reviews/<branch-hash>.json` に保存され、再起動・コミット・別ツール・同一ブランチのworktreeで共有される。予約直後に中断した場合も保守的に一巡消費する。**上限を超えるのは、オーナーが会話で明示に承認した後だけ。** 承認されたら、エージェントが `review-budget extend --phase <phase> --rounds <1-3> --reason "<オーナーの承認の文を 10〜500 文字で引用>"` を実行する（`group.limit` は書き換えず、`extensions` に追記して有効な上限を足す。上限に達した phase だけ拡張でき、`mutation` は拡張できない）。承認なしに `extend` を実行しない（自己承認の禁止は変えない）。状態ファイルやロックを手で消したり編集したりしない。ユーザーにコマンドの実行や状態の確認・退避を頼まない。状態ファイルが不正と報告されたときだけ、消さず・編集せず、`status` の出力とパスをオーナーに報告して判断を待つ。並行した PreToolUse / PostToolUse がロックを取り合うときは、hook が最大 2 秒待つ。ロックは古さでは外さない（作成の時刻ではロックが捨てられたと判断できず、外すと次の持ち主のロックを消しうるため。3.7.0）。それでも取れないロックは、AI は手で消さずに待つか、エラーに出たロックのパス（状態ファイルと同じ場所の `<branch-hash>.json.lock`）をオーナーに報告する。取り残されたロック（hook の強制終了・書き込みの失敗の後など）は、ロックのファイルに書かれた `pid` のプロセスがもう無いこと（Windows は `tasklist /FI "PID eq <pid>"`、POSIX は `ps -p <pid>`）を確かめてオーナーに報告し、オーナーが会話で承認した後だけ、エージェントがその `.lock` のファイルだけを消す（状態ファイルの `.json` は消さない。オーナーに消す作業を頼まない）。

## 効く範囲と限界

- 信頼して有効化された `PreToolUse` フックが、マーカー付きレビューと既知のレビュアー名の起動を拒否する。`SubagentStart` は停止に使わない。PostToolUse はレビュアーIDを記録し再開も識別する。
- 「レビュー機能を実装する」のような通常の実装依頼はレビューではない。役割を明確に分ける。状態が壊れた場合、名前・マーカーで識別できるレビューは拒否し、通常の実装・探索は制限しない。
- 未知の不透明なIDだけで再開し追跡状態も読めない場合は、非レビューを一律に止めないため判定対象外となる。レビュアーの明示名とマーカーを必ず使う。
- 親が自分の思考だけでレビューする、レビューを別名の汎用タスクに偽装する、外部CLI経由で起動する、フックを無効化する、状態を書き換える行為までは封じない。完全な改ざん防止や、任意の自然言語からのレビュー自動判定を保証する仕組みではない。
- フックが読み込まれていない／信頼されていない環境では機械的制限は働かない。`status` が読めるだけではフックの有効化証明にならない。無害な試験レビューを起動前に拒否できることを別途確認する。
- 1 つのセッションから複数のリポジトリを統括するとき、hook は統括側のリポジトリでしか働かない。レビューの起動と merge は、対象プロジェクトを作業ディレクトリにした別のセッションで行う。作業ディレクトリ外の worktree にある main への merge は、hook からは見えない。
- **Codex のフックの信頼**: Codex では、`/hooks` で `.codex/hooks.json` のフックを信頼するまで、quality-gate も review-budget も context-handoff も動かない（警告も出ない）。Codex は、新しいフックと定義が変わったフックを、信頼されるまで黙って飛ばす。`hooks.json` を変えたら（matcher・command・timeout・フックの順序）、再び信頼する。信頼のハッシュは登録（イベント・matcher・フックの各欄）だけから作られ、フックが起動する `.cjs` の中身は含まない（Codex 0.156.1 のソースと実機で確認）。そのため、`.cjs` だけの更新では信頼は外れない。信頼は Codex の設定の場所（`CODEX_HOME`）ごとに記録されるので、Codex のアカウント・設定の場所を切り替えたら（orca のアカウントの切り替えなど）、切り替えた先でも信頼する。プロジェクト自体も信頼されている必要がある（信頼されていないプロジェクトの `.codex/` は読まれない）。Windows では、フックの信頼の記録は、Codex を起動したディレクトリの綴り（大文字・小文字）のまま比べられる。
- **確かめ方**: `npx @crearize/ai-dev-helm codex-trust --dir <プロジェクト> [--codex-home <設定の場所>]`。読み取りだけで、Codex の設定には書き込まない。読む場所は `--codex-home` > 環境変数 `CODEX_HOME` > `~/.codex` の順で、読んだ `config.toml` を必ず表示する。orca などが起動したプロセスの中だけで `CODEX_HOME` が設定される環境では、普通の端末からは `~/.codex` を読むので、`--codex-home` で実際の場所を指定する。終了コードは、問題なし 0、`ACTION REQUIRED` 1（プロジェクトかフックが信頼されていない、別の綴りのパスでだけ信頼されている（`--dir` や今いるディレクトリを、記録と違う大文字・小文字で指定した場合も含む）、信頼の後に登録が変わった、無効にされている、信頼が今も有効か確かめられない、Codex が `hooks.json` を読み込めない）、読めない 2（読もうとしたパスを表示。空の `--codex-home`、1 MB を超えるファイルも含む）。git の linked worktree では、Codex と同じく本体（main checkout）側の同じ位置の `.codex/hooks.json` を読み、フックの信頼もそのパスで記録されているかを見る（worktree 側の `hooks.json` は読まれない。worktree の同じ位置に `.codex/` が無いとフックは動かない）。どの `hooks.json` を読んだかを表示する。ハッシュは Codex 0.156.1 と同じ方法で計算する。`/hooks` で信頼済みと表示されているのに「changed since trusted」と出る場合は、Codex の版で計算が変わったものとして `/hooks` の表示を優先する。
- **quality-gate の登録とシェルのツール**: Claude Code では quality-gate を matcher `^(Bash|PowerShell)$` に登録し、PowerShell ツールの実行も判定する（hook は `tool_name` でシェルの読み方を選ぶ）。Codex の `hooks.json` の登録は `Bash` のまま変えない（matcher を変えると Codex のフックの信頼が外れるため）。シェルのツール（`Bash` / `PowerShell`）の呼び出しなのに `tool_input.command` が無い・文字列でない場合は、読めないものとして拒否する（それ以外の読めない入力は従来どおり通し、理由を stderr に出す）。
- **フックの登録ラッパー（Claude Code）**: `.claude/settings.json` の quality-gate / review-budget の登録は、フックの実体を `CLAUDE_PROJECT_DIR`（Claude Code が渡す）→ `git rev-parse --show-toplevel`（5 秒で打ち切り）の順に探し、見つかった `.claude/hooks/<ファイル>` を実行する。git が無い・止まる場合も実体に届き、実体側の fail-closed（現在のブランチを確かめられなければ push / merge 系を止める）が効く。実体がシグナルで終わった場合は止める（exit 2）。`CLAUDE_PROJECT_DIR` が優先されるので、本体の checkout で起動したセッションから worktree に `cd` して作業すると、本体側のフックの実体が動く（判定はペイロードの `cwd` で行う。ただし動くのは本体の checkout にある版の実体なので、worktree 側でフックを更新しても、本体側を更新するまで反映されない）。導入先が `.ai-dev-helm.json` の `gate.script` / `reviewBudgetScript` で自分のゲート・review-budget を宣言したときは、同じ形のラッパーで宣言のパスの実体を実行し、配布の `quality-gate.cjs` / `review-budget.cjs` は写さない（`hook-selftest` は配布の判定表を宣言の実体に当てる。3.7.0）。
- **残存リスク（実体が見つからないとき）**: どちらの場所にもフックの実体が無い場合（`.claude/hooks` が無い古いブランチを checkout した等）、ラッパーは呼び出しを止めずに通し（exit 0）、`systemMessage`（と `additionalContext`）で「フックの実体が見つからず、ゲートが効いていない」と知らせる。止める（exit 2）と、Bash / PowerShell と Agent のすべての呼び出しが止まり、AI が自分で戻せなくなるため。この知らせが出たら、`npx @crearize/ai-dev-helm upgrade` でフックを入れ直して（宣言した実体なら、その実体を戻して）から push / merge・レビューの起動を行う。知らせの末尾に「(git could not find the repository root …)」が付くときは、入れ直しでは直らないことがあるので、先に git が使えるか（PATH・`safe.directory` 等）を確かめる。
- **Codex の名前と code-mode の橋渡し（限界あり）**: review-budget は、Codex の `agent_name`、下線で区切った名前（`integrated_reviewer`）、code-mode の橋渡しのツール名（`collaborationspawn_agent` など `collaboration` で始まる名前）を読む。橋渡しでは `message` が hook に見えないことがあるので、予約の印を `task_name` に `helm_review_<token>_<ロール名の - を _ にしたもの>` の形で載せてよい（同じ印で、席は増えない。`message` にも印があれば、両方が一致しなければ拒否する）。ただし配布の `.codex/hooks.json` の matcher（`^(Agent|Task|spawn_agent|followup_task|send_message|send_input|resume_agent)$`）は変えない（変えると Codex のフックの信頼のやり直しが要るため）ので、`collaboration` で始まるツール名は配布の登録では hook に届かず、この読み取りは効かない。橋渡しを使う導入先は、自分の `.codex/hooks.json` の review-budget の matcher にそれらの名前を足す（`upgrade` は、review-budget を呼ぶ登録が既にあれば matcher を変えない）。
- **残存リスク（Codex の登録ラッパー）**: `.codex/hooks.json` の登録ラッパーは 3.3.0 のまま変えていない（コマンドを変えると、Codex を使う全導入先で `/hooks` の信頼のやり直しが要るため）。そのため Codex では、git が PATH に無い・止まる・作業ディレクトリがリポジトリの外にある場合、ラッパーがフックの実体に届く前に exit 1 で終わり、呼び出しは止められずに通る（fail-open）。
- **状態ファイルの権限（Windows）**: review-budget の状態ディレクトリ・ファイルは `0o700` / `0o600` で作るが、Windows ではこの mode は効かず、親フォルダーの ACL を継承する（同じユーザーの別のプロセスから読める）。review-budget は AI のうっかりを防ぐ仕組みで、security boundary ではない。状態の `receipts` と `agents` は、書き込みのたびに新しい順で 500 件までに剪定する（500 件を超える長寿命ブランチでは、剪定された古いレビュアーへの追加依頼がレビューとして数えられなくなることがある）。
- **quality-gate と入れ子のシェル**: `powershell -Command "…"`・`pwsh -c`・`cmd /c`・`bash -c` などの中に push / merge 等の語が見える形は、単純な形ではないので拒否される（フラグがあっても。push・merge はそれだけを単独のコマンドで実行する）。エンコードした PowerShell のスクリプトと、標準入力から読ませる PowerShell のスクリプトは、語の有無にかかわらず拒否される。この判定はコマンドの文字列を 1 回だけ読む規則で、小文字にし、引用符と行の継続（`\`・バッククォート・`^` の直後の改行）を除いて語に分け、`powershell` / `pwsh`（パス・`.exe` 付きも同じ）の語の後の同じコマンド（`;`・`&`・`|`・括弧・改行まで）に、エンコードしたコマンドの指定（`-e`・`-ec`・`-en`〜`-encodedcommand`。`--` / `/` で始まる形も同じ）か `-command -` / `-c -` があれば拒否する。検索語やメッセージで、名前の後にこれらの指定を書いたコマンドも拒否される。その場合はその文字列を含めずに実行し直す。ゲートは AI の普段の誤操作を止めるためのもので、意図して組み立てた形（展開・エスケープ・Unicode の類似字で名前や指定を書く、変数やファイルからスクリプトを組み立てる、別のマシンの先で起動する等）は対象外とする（hook のヘッダの一覧）。

## 会話の記録の引き継ぎ（context-handoff）

長い会話は、毎回の呼び出しで文脈全体を読み直すので、文脈が大きいまま続けるほど費用がかさむ（1M コンテキストのモデルは、自動コンパクトが約 97 万トークンまで走らない）。区切りで `/clear` か `/compact` をすれば軽くなるが、やり取りが要約に頼るか消える。`.claude/hooks/context-handoff.cjs` は、その前後でやり取りをプログラムで保存して戻す（Codex では `.codex/hooks/context-handoff.cjs`。下の「Codex での動き」）。

| イベント | 動き |
|---|---|
| `Stop` | 直近の呼び出しの入力（`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`）が 300,000 を超えたら（ちょうど 300,000 は含めない）、区切りで `/clear` してよいことを `systemMessage` で知らせる。同じ会話では、超えたときとその後 10 万増えるごとに 1 回。しきい値以下に戻ったとき（コンパクトの後など）としきい値を変えたときは数え直す。使用量が 0 の行（API エラーの `<synthetic>` の応答）と、末尾 4 MB に使用量が無いときは何もしない。しきい値は環境変数 `AI_DEV_HELM_CONTEXT_NOTICE_TOKENS`（`0` で知らせない） |
| `PreCompact` | 記録を保存する（手で打った `/compact` も自動コンパクトも）。きっかけ（手か自動か）と `/compact` に付けた指示を `<会話 ID>.compact.json` にも書く |
| `SessionStart`（compact） | 記録を作り直して保存し（コンパクトの時点で書き込まれていなかった末尾を拾うため）、要点を `additionalContext` で戻す。`.compact.json` が 30 分以内なら、そのきっかけと指示を記録に書き、読んだら消す |
| `SessionEnd`（clear） | 次の会話のための目印を書き、記録を保存する |
| `SessionStart`（clear） | 同じプロジェクト（会話記録のフォルダー。会話の途中で worktree などに移っても変わらない）の 120 秒以内の目印を読み（無ければ最大 5 秒待つ）、前の会話の要点を戻す。使った目印は消す |

- **記録の中身**: 会話記録（jsonl）の本体の流れから抜き出す（要約しない。コンパクトより前の部分も含む）。ユーザーの指示（人が打った発言。task-notification・`<system-reminder>`・ツールの結果は除く。指示の中に貼った `<command-name>` などのタグはそのまま残す）と `AskUserQuestion` への回答（中断・エラーの結果は除く）を原文で新しい順に、直近 5 回のやり取り、変更したファイル、PR と git の操作（直前と同じコマンドは 1 件）、直前のコンパクトの要約。
- **秘密情報**: URL の中の `user:password@`（ASCII のもの。ユーザー名が空でも）と、よくあるトークンの形（`ghp_` 等の GitHub・`github_pat_`・`glpat-`・`sk-ant-` / `sk-proj-` 等と 40 文字以上の `sk-`・Stripe の `sk_live_` / `sk_test_`・`AKIA` / `ASIA`・`npm_`・`xox?-`・`AIza`・`Bearer` の後の値（大文字・小文字を問わず、改行をまたがない）・秘密鍵のブロック（PGP を含む。終わりの行が無いものは、見出しと、`Version:` 等の見出し行と、続く鍵のデータの並び（空白・改行・JSON の `\n` で区切られていてよい）までで、その後の文は残す））は、記録にも戻す要点にも `[REDACTED]` で入れる。形で見分けるので、ほかの形の秘密（JWT 単体、AWS のシークレットキー等）は残る。秘密を貼ってしまったときは、その会話の記録ファイル（下記）も消す。長い文は先に上限（指示 20,000 文字等）で切ってから置き換え、切れ目で途切れた鍵のブロックと、末尾の英数字・記号の並び（最大 200 文字。切れ目で半分になった秘密）を落とす。省略した文字数は元の長さから数える。
- **戻す要点**: Claude Code の上限（1 万文字。超えるとファイルに置かれ先頭 2,000 文字だけになる）に収まるよう、9,000 文字以内（サロゲートペアの途中では切らない）。最新の指示（質問への回答ではなく、ユーザーが打った発言）は、ほかの節で予算が埋まっても縮めて必ず入れる。記録の全文のパスを含み、細部と古い指示はそのファイルを読む。要約と食い違うときは記録を優先する（テンプレートの CLAUDE.md の「Compact Instructions」）。
- **置き場所**: `~/.claude/context-handoff/<会話記録のフォルダー名>/` に `<会話 ID>.md`（記録）・`.notice.json`（Stop の知らせの状態）・`.compact.json`（コンパクトのきっかけ）、`clear-markers/` に目印。リポジトリの外なので、作業ツリーにもコミットにも入らない。フォルダーは 0700、ファイルは 0600 で作る（Windows では効かず、親フォルダーの ACL による）。1 日 1 回、このフックが作った名前のファイル（会話 ID か `unknown` の `.md`・`.notice.json`・`.compact.json`）だけを、置き場所の直下のすべてのフォルダーから、30 日（`~/.claude/settings.json` の `cleanupPeriodDays` がそれより短ければその日数）より古ければ消す（目印は 1 日）。エラーは `errors.log`（1 MB を超えたら空にする）に書く。
- **止め方**: 環境変数 `AI_DEV_HELM_HANDOFF=off` で、保存も戻しも知らせもしない。
- **全体設定と重ねるとき**: 同じファイルを `~/.claude/hooks/` に置いて `~/.claude/settings.json` に `node "<パス>" --scope=global` で登録すると、導入先でないプロジェクトにも効く（`npx @crearize/ai-dev-helm personal` の選択肢 4 がこの写しと登録を行う。再実行しても登録は各イベント 1 回）。`--scope=global` の方は、プロジェクトに `.claude/hooks/context-handoff.cjs` があり、`.claude/settings.json` か `.claude/settings.local.json` に登録があれば何もしない（2 回動かない）。
- **終了コードは常に 0**: PreCompact の exit 2 はコンパクトを取りやめさせ、`Stop` フックの exit 2 は応答を終わらせなくするため。登録のラッパーも、実体が無い・異常終了でも exit 0 にする。実体が無いときは `SessionStart` でだけ知らせる。

Codex での動き（3.7.1）:

- **登録と見分け方**: 同じ本体を `.codex/hooks/context-handoff.cjs` に写し、`.codex/hooks.json` の `PreCompact`・`SessionStart`（matcher `compact|clear`）・`Stop` に登録する。本体は会話記録の先頭の行（`session_meta`）で Codex の rollout と見分け、`response_item` の行から読む（Codex の履歴の形式 Legacy / Paginated のどちらでも同じに読める）。
- **記録の中身**: 人の発言（`role: user` の `message`。AGENTS.md・`<environment_context>` など Codex が差し込む文 — Codex のタグ（`environment_context` のような `_` を含む名前と `skill`）1 つのブロックだけの文と `# AGENTS.md instructions` で始まる文 — は除く。人が打った HTML（`<details>…</details>` など）は残す）、Codex の質問への回答（`<send_user_message_question_reply>` の質問と回答）、直近 5 回のやり取り（`role: assistant` の文）、変更したファイル（apply_patch の `*** Update File:`・`*** Add File:`・`*** Delete File:`・`*** Move to:` の行のパス。パッチに書かれたままの形）、git と gh の操作（シェルの呼び出しのコマンド）、PR（その操作の出力に出た `https://github.com/<owner>/<repo>/pull/<番号>`）。シェルと apply_patch は、Codex 0.163 の既定では `exec` のツールが動かす JavaScript の中の `tools.exec_command({cmd: "…"})`・`tools.shell_command({command: "…"})`・`tools.apply_patch("…")` の呼び出しから、文字列で書かれたコマンド・パッチを読む（`cmd`・`command` はオブジェクトの中のどの位置にあってもよい。変数で渡したものは読めない。スクリプトの文字列（パッチの中身など）やコメントの中に書かれた呼び出しは、実行したものとして数えない（正規表現リテラル `/'/g` などは文字列と見分けるので、その後ろの呼び出しも読む。テンプレートリテラルの `${…}` の中の呼び出しは読めない）。1 つの `exec` の出力は中の呼び出しすべての分なので、その中に git・gh の操作があれば、出力に出た PR をすべて拾う）。`function_call` の `exec_command` などの形も読む。直前のコンパクトの要約は、`compacted` の `message` に文があるときだけ入る（Codex 0.163 では要約は暗号化されていて `message` は空なので、入らない）。
- **`/clear`**: Codex の `SessionEnd` は `/clear` を見分けられず、新しい会話の `SessionStart` より後に動くことがあるので使わない。`Stop` のたびに、そのプロジェクトの最新の会話（rollout のパス）の目印を書き（`codex exec`・MCP サーバーとしての Codex・サブエージェントの会話（`session_meta` の `source` が `exec`・`mcp`・`subagent`）は `/clear` できないので書かない）、`SessionStart`（clear）で 24 時間以内の目印の rollout から記録を作って戻す（使った目印は消す）。Codex の `SessionStart` は次の発言の始めに動くので、要点は `/clear` の後の最初の発言のときに入る。
- **戻す要点**: Codex の既定の上限（2,500 トークン。UTF-8 のバイト数 ÷ 4 で数え、超えるとファイルに置かれる）に収まるよう、9,000 バイト以内に縮める（`additionalContextLimit` は信頼のハッシュの対象なので設定しない）。全文はファイルに書き、パスを添える。
- **置き場所**: `$CODEX_HOME/context-handoff/<git のルートのフォルダー名>-<ハッシュ>/`（`CODEX_HOME` が無ければ `~/.codex`。`/clear` の目印は `clear-markers/<同じ名前>.json`）。フォルダー名は英数字以外を `_` にして 64 文字までに切り、後ろにパス全体の SHA-256 の先頭 16 桁を付ける（日本語の名前のプロジェクトどうしや、同じフォルダー名の別の場所が同じ場所にならないように。深い場所のプロジェクトでも 1 つの名前の上限 255 文字を超えないように）。Windows では、名前もハッシュも小文字にしたパスから作る（`C:\Work` と `c:\work` は同じプロジェクト）。プロジェクトは hook の cwd の `git rev-parse --show-toplevel` で決める（Codex の hook には `CLAUDE_PROJECT_DIR` が無い）。消す期限は 30 日。
- **何もしないとき**: `Stop`・`PreCompact`・`SessionStart`（compact）で、入力の `transcript_path` が null・読めない・まだ空（rollout を探し回らない）、古い圧縮された記録（`.jsonl.zst`）のとき。サブエージェントのコンパクト（`agent_id` がある）。`SessionStart`（clear）は、入力の `transcript_path` によらず目印の rollout から戻す（新しい会話の rollout はまだ書かれていないことがあるため）。文脈の大きさの知らせ（Claude Code の `Stop`）は Codex では出さない。
- **終了コード**: 本体は常に 0 で、`Stop` では何も出力しない。登録は 3.3.0 の Codex のラッパーと同じ形で（文字列は以後変えない）、本体や git が無いときは exit 1 で終わる。Codex は exit 1 を失敗したフックとして表示するだけで、コンパクトも会話もそのまま進む（Codex が終了コードや出力で動きを変えるのは、`Stop` の exit 2（stderr に理由があるとき）と `continue: false` などの JSON だけ）。
- **信頼**: 新しい 3 件は、Codex の起動時の確認（Hooks need review）で利用者が信頼するまで動かない（下の「Codex のフックの信頼」）。各イベントの配列の末尾に足すだけなので、quality-gate・review-budget の信頼と MCP の承認はそのまま。

効く範囲と限界:

- フックから `/clear`・`/compact` は起こせない。打つのはユーザーで、`Stop` フックの知らせが目安になる。
- 会話記録は書き込みが遅れることがあるので、PreCompact と SessionEnd の時点では最後の 1 往復を取りこぼすことがある。コンパクトの後は SessionStart で作り直すので拾える。`/clear` の後は、SessionStart が会話記録を読む時点で書き込まれていれば拾える。
- 同じプロジェクトの 2 つの会話でほぼ同時に `/clear` すると、目印を取り違えることがある（120 秒以内の最新の 1 件を使う）。Codex では、同じプロジェクト（git のルート）で 2 つの会話を並べていると、`/clear` した会話ではなく、最後に応答を終えた会話の記録が戻ることがある。
- `/clear` のたびに会話記録を 2 回読む（SessionEnd で保存し、SessionStart で作り直す。SessionStart が動かなかったときの備え）。数百 MB の会話記録では数秒かかる。
- サブエージェントには入れない（短命で、本体に返るのは最終の文だけのため）。

仕様参照: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)。
