---
name: branch-workflow
description: 作業開始時に使用。mainブランチでの作業禁止。Issue先行作成必須。
---

# Branch Workflow Skill - ブランチ・Issue作業フロー

## 禁止事項（最重要）

> **以下は絶対に禁止。違反は許容されない。**

- **mainブランチでの直接作業禁止**: すべての変更は機能ブランチで行う
- **Issue番号なしのブランチ作成禁止**: 必ずIssue番号をブランチ名に含める

## 作業開始前の必須チェック

### Step 1: 現在のブランチを確認

```bash
git branch --show-current
```

- `main` と表示された場合 → **作業禁止！** Step 2へ
- `main` 以外の場合 → 作業内容とブランチ名が一致しているか確認

### Step 2: Issue作成（mainの場合必須）

```bash
gh issue create --title "機能名" --body "詳細説明"
```

### Step 3: ブランチ作成

```bash
git checkout -b [タイプ]/[作業内容]-[Issue番号]
```

## ブランチ命名規則

| タイプ | 用途 | 例 |
|--------|------|-----|
| `feature/` | 新機能開発 | `feature/add-login-123` |
| `fix/` | バグ修正 | `fix/auth-bug-456` |
| `docs/` | ドキュメント更新 | `docs/update-readme-789` |
| `refactor/` | リファクタリング | `refactor/user-service-101` |
| `test/` | テスト追加・修正 | `test/add-api-tests-102` |

## main への取り込み

main への取り込みは quality-check を完走してから行う。quality-gate の hook は、フラグ（`.quality-check-passed`）が**取り込む commit** を指しているかを確かめる（前回のフラグが残っていても、チェックしていないブランチは取り込めない）。

| 状況 | 手順 |
|------|------|
| リモートがある（trunk の remote-tracking ref、例: `origin/main` がある） | feature ブランチを push して PR を作る（`git push -u origin HEAD` → `gh pr create`）。merge は PR で行う |
| リモートが無く、1 つのチェックアウトで作業している | feature 上で quality-check を完走する → `git switch main` → `git merge <feature>`（`--no-ff` 可。main が feature に無いコミットを持っていれば拒否されるので、main を feature に取り込んで quality-check をやり直す）→ `.quality-check-passed` を削除する |
| リモートが無く、main を別の worktree で開いている | 下の「リモートの無いプロジェクトの取り込み」 |

ここで「リモートが無い」は、trunk の remote-tracking ref（例: `origin/main`）が無いことを言う。push 専用の remote しか無い場合（trunk を取り込まない公開用の remote など）を含む。そのような remote に feature ブランチを push しない（PR の道は無い）。

### リモートの無いプロジェクトの取り込み

1. feature の worktree で quality-check を完走し、フラグを作る（フラグは feature の HEAD を指す）
2. main のチェックアウトに触る前に、feature の worktree で事前確認を実行する: `npx --no ai-dev-helm integrate-check --main <main のチェックアウト>`（CLI が手元に無ければ `npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> integrate-check --main <main のチェックアウト>`。trunk が main 以外なら `--trunk <名前>`）
   - 読み取りだけのコマンドで、何も変更しない（push・merge・switch もしない）。git を引数の配列で呼ぶので、シェル・引用・文字コードの違いを受けない
   - 確かめること（見つけたものは名前つきで出す）: main のチェックアウトが trunk を開いている、その追跡ファイルに未コミットの変更が無い、trunk が feature の祖先である、feature が足すパス（名前の変更先を含む）と同じ場所に main のチェックアウトで追跡されていないもの（未追跡・ignore 済みのファイル、それらを含むディレクトリ、ファイルになっている親のパス）が無い。大文字小文字の違いはファイルシステムの実際の挙動で判定する
   - 関係の無い未追跡ファイル（ユーザーの資料など）は見ない。統合を妨げないので、触れずにそのまま残す
   - 出力の最後の行が `integrate-check: OK`（終了コード 0）: 次へ進む
   - 最後の行が `integrate-check: NG (<trunk> is not an ancestor only)`: main を feature に取り込み、quality-check をやり直してから、手順 1 からやり直す（integrate-check も再実行する。main のチェックアウトには触れないので止まらない）
   - 最後の行が `integrate-check: NG - change nothing …`（終了コード 1）: 何も変えずに統合を止め、出力を最後の 1 通で知らせる（例外 X3。オーナーの返答の後に進める）
   - 出力が `integrate-check:` で始まらなければ、判定ではない（使い方の誤りは終了コード 2。CLI が手元に無い・古い devDependency の `Unknown argument` なども判定ではない）。`--main` の場所などを直すか、`npx -y @crearize/ai-dev-helm@<.ai-dev-helm.json の version> integrate-check …` で実行し直す
3. このプロジェクトで `git push . HEAD:main` が使えるかを確かめる（エージェントの設定の deny 規則（`Bash(git push:*)` 等）・プロジェクトの規則）。使えなければ、下の「`git push` が使えない場合」の手順に替える
4. main を開いているチェックアウトで `git switch --detach` を実行する（チェックアウト中のブランチは更新できないため）
5. feature の worktree で `git push . HEAD:main` を実行する（fast-forward 以外は git が拒否する。hook はフラグ = HEAD で通す）。deny 規則で止められたら、detach したまま下の「`git push` が使えない場合」の 2 に進む
6. main のチェックアウトで `git switch main` を実行する（失敗したときは下の「最後の `git switch main` が失敗したとき」）
7. `.quality-check-passed` を削除する

実際の detach・push・merge・switch は、上のとおり手順に書いた git コマンドで行う（quality-gate の hook に見える形を保つ。integrate-check の中では行わない）。

**最後の `git switch main` が失敗したとき**: integrate-check を通っても、その後に main のチェックアウトにファイルが置かれた等で失敗することがある。ファイルの移動・削除や `git switch -f` はしない。main のチェックアウトは統合前の commit で detached のまま残し（この場合だけ）、git の出力（妨げているファイルの名前）と状態を最後の 1 通で知らせる（例外 X3）。

**`git push` が使えない場合**: 上の表の「1 つのチェックアウト」と同じローカルのマージ（`git merge --no-ff <feature>`）を、フラグのある feature の worktree で行う。hook はコマンドを実行したチェックアウトのフラグを読むので、フラグの無い main のチェックアウトでの `git merge` は止まる。

1. main を開いているチェックアウトで `git switch --detach` を実行する（detach 済みならそのまま）
2. feature の worktree で `git switch main` → `git merge --no-ff <feature>` → `git switch <feature>` を実行する
3. main のチェックアウトで `git switch main` を実行する（失敗したときは上と同じ）
4. `.quality-check-passed` を削除する

deny 以外の理由（quality gate、git の non-fast-forward 拒否 等）で push / merge が拒否されたら、両方を元に戻し（feature の worktree が main にいれば `git switch <feature>`、main のチェックアウトは `git switch main`）、quality-check をやり直す（main が先に進んでいれば、main を取り込んでから）。main のチェックアウトを detached のまま残さない（例外は上の「最後の `git switch main` が失敗したとき」だけ）。

`git branch -f main <feature>`・`git fetch . <feature>:main` も、フラグが `<feature>` の先端を指していれば通るが、手順は上の 2 つにそろえる。

## PR作成時の必須事項

```bash
git commit -m "feat: [機能名]の実装 (closes #[Issue番号])"
```
