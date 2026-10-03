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

設計・要件・計画・最終品質チェックのレビューは、**起動直前**に一巡を予約する。設計等は通常一巡。必要性が事前に認められる文書レビューのみ初回予約で `--limit 3` を指定できる。ユーザーが「一度だけ」と指定した場合は必ず `--limit 1`。品質レビューの既定の絶対上限は3巡。制作時のデザインレビューは phase `production`（既定の上限は3巡）、ミューテーション分類の検証は phase `mutation`（`falsification-qa` 1 体・上限は 1 に固定）で予約する。`requirements` / `design` / `plan` / `production` の予約はブランチごとなので、main / master 上では拒否される（先にタスクブランチを作る）。工程内の通常テスト、修正、探索、結果待ちは予約不要。

プロジェクトルートで実行（Codexのみのプロジェクトでは `.claude` を `.codex` に置き換える）:

```sh
node .claude/hooks/review-budget.cjs status
node .claude/hooks/review-budget.cjs begin --phase quality --roles integrated-reviewer,falsification-qa
```

正式な呼び方は上の `node .claude/hooks/review-budget.cjs`（Codex のみなら `.codex`）。パッケージ CLI の `ai-dev-helm review-budget …` は同じ状態を扱い、`.ai-dev-helm.json` の `reviewBudgetScript`、`.claude/hooks/review-budget.cjs`、`.codex/hooks/review-budget.cjs` の順に見つけたスクリプトへ処理を任せる。どれも無いときだけ同梱のスクリプトを警告つきで使う。未インストールの旧リリースを `npx` で取得して回避しない。

1. チェックが通り、レビューを行う場合にだけ `begin` を呼ぶ。戻り値の `round` はレビュー回数であり、レポートの `total_cycles`（機械チェックを含む工程数）とは別。`quality-context --cycle` には継続中の工程番号を渡す。例えば失敗した3工程の次で初めてレビューする場合、工程番号は4、予約の round は1となる。レビュー開始のために工程番号を1へ戻したり、継続中のレポートやスナップショットを初期化したりしない。
2. 戻り値 `markers` の該当ロールの行（`HELM_REVIEW:…:integrated-reviewer` 等）を **各レビュアーへの message / prompt の先頭にそのまま置く**。起動名も `reviewer` を含む名前にする。Claude の `Agent` / `Task`、Codex の `spawn_agent` で同じ手順を使う。マーカーは message / prompt の**1 行目**に置く（2 行目以降の `HELM_REVIEW:` はマーカーとして扱わない）。実装の依頼で 1 行目にマーカーを書き写さない。レビューでない作業（制作・修正）は、名前と description にレビュー語（review / reviewer / レビュー）を入れない。
3. 共通コンテキスト生成と結果統合は既存 quality-check に従う。初回は `integrated-reviewer`、コード変更なら `falsification-qa`、専門家は `security-engineer` / `requirements-analyst` / `performance-engineer` の最大1体。2巡目以降は `verification-reviewer` と条件付き `falsification-qa`。文書レビューは phase `requirements` / `design` / `plan`、role `document-reviewer`。制作時のデザインレビューは phase `production`（1 巡目 `integrated-reviewer` + 任意で `falsification-qa`、2 巡目以降 `verification-reviewer` + 任意で `falsification-qa`。専門家の席は無い）。ミューテーション分類の検証は phase `mutation`、role `falsification-qa`。
4. 同じ一巡の複数ロールは1回。各ロールの起動情報は一度限り。既存レビュアーへの再検証依頼（`followup_task` / `send_message` / `send_input` / `SendMessage` / Agentの `resume`）も新しい一巡を予約する。待機・結果取得は追加レビューではない。レビュー依頼の追記は起動前にまとめ、起動後の連絡で実質的な再レビューを増やさない。
5. 拒否されたら迂回しない。上限に達したら残存事項をオーナーに報告し、判断を待つ。実装・探索・通常テストはこの上限では止めない。構造的問題や停滞は別の報告理由であり、無根拠な修正の繰り返しを求めるものではない。

状態は Git common directory の `ai-dev-helm-reviews/<branch-hash>.json` に保存され、再起動・コミット・別ツール・同一ブランチのworktreeで共有される。予約直後に中断した場合も保守的に一巡消費する。**上限を超えるのは、オーナーが会話で明示に承認した後だけ。** 承認されたら、エージェントが `review-budget extend --phase <phase> --rounds <1-3> --reason "<オーナーの承認の文を 10〜500 文字で引用>"` を実行する（`group.limit` は書き換えず、`extensions` に追記して有効な上限を足す。上限に達した phase だけ拡張でき、`mutation` は拡張できない）。承認なしに `extend` を実行しない（自己承認の禁止は変えない）。状態ファイルやロックを手で消したり編集したりしない。ユーザーにコマンドの実行や状態の確認・退避を頼まない。状態ファイルが不正と報告されたときだけ、消さず・編集せず、`status` の出力とパスをオーナーに報告して判断を待つ。ロックは、作成から 10 分を超え、書いたプロセスが存在しないときに hook が自動で外す。それ以外のロックは、手で消さずに待つか報告する。

## 効く範囲と限界

- 信頼して有効化された `PreToolUse` フックが、マーカー付きレビューと既知のレビュアー名の起動を拒否する。`SubagentStart` は停止に使わない。PostToolUse はレビュアーIDを記録し再開も識別する。
- 「レビュー機能を実装する」のような通常の実装依頼はレビューではない。役割を明確に分ける。状態が壊れた場合、名前・マーカーで識別できるレビューは拒否し、通常の実装・探索は制限しない。
- 未知の不透明なIDだけで再開し追跡状態も読めない場合は、非レビューを一律に止めないため判定対象外となる。レビュアーの明示名とマーカーを必ず使う。
- 親が自分の思考だけでレビューする、レビューを別名の汎用タスクに偽装する、外部CLI経由で起動する、フックを無効化する、状態を書き換える行為までは封じない。完全な改ざん防止や、任意の自然言語からのレビュー自動判定を保証する仕組みではない。
- フックが読み込まれていない／信頼されていない環境では機械的制限は働かない。`status` が読めるだけではフックの有効化証明にならない。無害な試験レビューを起動前に拒否できることを別途確認する。
- 1 つのセッションから複数のリポジトリを統括するとき、hook は統括側のリポジトリでしか働かない。レビューの起動と merge は、対象プロジェクトを作業ディレクトリにした別のセッションで行う。作業ディレクトリ外の worktree にある main への merge は、hook からは見えない。
- **Codex のフックの信頼**: Codex では、`/hooks` で `.codex/hooks.json` のフックを信頼するまで、quality-gate も review-budget も動かない（警告も出ない）。Codex は、新しいフックと定義が変わったフックを、信頼されるまで黙って飛ばす。`hooks.json` を変えたら（matcher・command・timeout・フックの順序）、再び信頼する。信頼のハッシュは登録（イベント・matcher・フックの各欄）だけから作られ、フックが起動する `.cjs` の中身は含まない（Codex 0.156.1 のソースと実機で確認）。そのため、`.cjs` だけの更新では信頼は外れない。信頼は Codex の設定の場所（`CODEX_HOME`）ごとに記録されるので、Codex のアカウント・設定の場所を切り替えたら（orca のアカウントの切り替えなど）、切り替えた先でも信頼する。プロジェクト自体も信頼されている必要がある（信頼されていないプロジェクトの `.codex/` は読まれない）。Windows では、フックの信頼の記録は、Codex を起動したディレクトリの綴り（大文字・小文字）のまま比べられる。
- **確かめ方**: `npx @crearize/ai-dev-helm codex-trust --dir <プロジェクト> [--codex-home <設定の場所>]`。読み取りだけで、Codex の設定には書き込まない。読む場所は `--codex-home` > 環境変数 `CODEX_HOME` > `~/.codex` の順で、読んだ `config.toml` を必ず表示する。orca などが起動したプロセスの中だけで `CODEX_HOME` が設定される環境では、普通の端末からは `~/.codex` を読むので、`--codex-home` で実際の場所を指定する。終了コードは、問題なし 0、`ACTION REQUIRED` 1（プロジェクトかフックが信頼されていない、別の綴りのパスでだけ信頼されている（`--dir` や今いるディレクトリを、記録と違う大文字・小文字で指定した場合も含む）、信頼の後に登録が変わった、無効にされている、信頼が今も有効か確かめられない、Codex が `hooks.json` を読み込めない）、読めない 2（読もうとしたパスを表示。空の `--codex-home`、1 MB を超えるファイルも含む）。git の linked worktree では、Codex と同じく本体（main checkout）側の同じ位置の `.codex/hooks.json` を読み、フックの信頼もそのパスで記録されているかを見る（worktree 側の `hooks.json` は読まれない。worktree の同じ位置に `.codex/` が無いとフックは動かない）。どの `hooks.json` を読んだかを表示する。ハッシュは Codex 0.156.1 と同じ方法で計算する。`/hooks` で信頼済みと表示されているのに「changed since trusted」と出る場合は、Codex の版で計算が変わったものとして `/hooks` の表示を優先する。
- **quality-gate と入れ子のシェル**: `powershell -Command "…"`・`pwsh -c`・`cmd /c`・`bash -c` などの中に push / merge 等の語が見える形は、単純な形ではないので拒否される（フラグがあっても。push・merge はそれだけを単独のコマンドで実行する）。エンコードした PowerShell のスクリプトと、標準入力から読ませる PowerShell のスクリプトは、語の有無にかかわらず拒否される。この判定はコマンドの文字列だけを見る規則で、構造（どのコマンドの引数か、クォートの中か、別のシェルに渡すスクリプトか）は読まない。書かれたままの文字列と、行の継続（`\`・バッククォート・`^` の直後の改行）を詰めた文字列（シェルごとの継続を 1 種類ずつ詰めたものと、3 種類とも詰めたもの）の両方で読み（継続にならないシェルで、次の行の `powershell` が前の語にくっついて見落とされないようにするため）、空になりうる展開（`$@`・`$*`・`${x}`・`$x`・cmd の `%x%` など）を取り除いた読み方でも判定する（どれかの読み方で当たれば拒否。どの読み方も文字列の長さに比例する時間で終わる）。`powershell` / `pwsh` の語があり、その後にエンコードしたコマンドの指定か単独の `-` がある（単独の `-` は展開を取り除かない読み方でだけ見る。`-Name "$a-$b"` は拒否しない）、それより前にパイプがある、入力のリダイレクトがある、のどれかで拒否する。そのため、検索語やメッセージでこれらに触れるだけのコマンド、同じコマンドの前の方にパイプがあって後で PowerShell のスクリプトを実行するコマンドなども、わざと拒否する（取りこぼしより過剰な拒否を選ぶ）。その場合は PowerShell の文字列を含めずに実行し直すか、コマンドを分ける。文字コードによるエスケープ・ブレース展開・`Start-Process -ArgumentList`・`ssh` / `docker exec` の先で起動するもの・変数やファイルから組み立てたスクリプトは、この規則の外にある。`Invoke-Expression`・`Start-Process`（`-ArgumentList` を含む）・`ssh` / `docker exec` 経由の起動・スクリプトブロック・`-File` のファイルの中身・ほかの言語の実行・`eval` / `source`・`xargs` / `find -exec`・エイリアスや関数・環境変数の展開は中身を読まない（hook のヘッダの一覧。意図的な回避は規則で禁止する）。

仕様参照: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)。
