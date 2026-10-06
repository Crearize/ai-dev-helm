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
2. main のチェックアウトに触る前に、次の 4 つを確かめる
   - 追跡ファイルに未コミットの変更が無いこと: `git -C <main のチェックアウト> status --porcelain --untracked-files=no` が空
   - feature が足すパスに、main のチェックアウトの未追跡ファイル（ignore 済みのものを含む）が無いこと。手順は下の「未追跡ファイルの確認」
   - feature の worktree で `git merge-base --is-ancestor main HEAD` が成功すること。失敗したら detach せず、main を feature に取り込み、quality-check をやり直してから統合する
   - このプロジェクトで `git push . HEAD:main` が使えること（エージェントの設定の deny 規則（`Bash(git push:*)` 等）・プロジェクトの規則）。使えなければ、下の「`git push` が使えない場合」の手順に替える

   最初の 2 つのどちらかに当たれば、detach せずに統合を止める（ユーザーの作業中の変更に触れない。例外 X3）。最後の 1 通で知らせるのは、当たった件数と feature 側のパスだけにする。
3. main を開いているチェックアウトで `git switch --detach` を実行する（チェックアウト中のブランチは更新できないため）
4. feature の worktree で `git push . HEAD:main` を実行する（fast-forward 以外は git が拒否する。hook はフラグ = HEAD で通す）。deny 規則で止められたら、detach したまま下の「`git push` が使えない場合」の 2 に進む
5. main のチェックアウトで `git switch main` を実行する（出力は捨てて終了コードだけを見る。下の「最後の `git switch main` が失敗したとき」）
6. `.quality-check-passed` を削除する

**未追跡ファイルの確認**: main のチェックアウトの未追跡ファイルの一覧は出さない（ユーザーの作業中のファイル・顧客データの名前を会話に出さない）。ほかの未追跡ファイル（ユーザーの資料など）は統合を妨げないので、触れずにそのまま残す。feature のパスだけを指定して、件数だけを数える。

1. feature の worktree で、feature が足すパスの一覧を取る: `git -c core.quotePath=false diff --name-only --no-renames --diff-filter=A main...HEAD`（`--no-renames` で名前の変更先も、`core.quotePath=false` で日本語の名前もそのまま出る）
2. 一覧が空なら、この確認はしない（パスを付けない `git ls-files --others` は、未追跡ファイルをすべて出してしまう）
3. 空でなければ、パスごとに `git -C <main のチェックアウト> ls-files --others -- ":(literal,icase)<パス>" | wc -l`（PowerShell は `| Measure-Object`）で件数だけを数える。`literal` は `[id]` のような文字を glob にしない（別の名前に当たって出力されるのを防ぐ）。`icase` は大文字小文字の違いも拾う（Windows・macOS）。`--exclude-standard` は付けない（ignore 済みのユーザーのファイルも上書きから守る）。パスが main 側でディレクトリになっている場合も、その中のファイルが数えられて止まる。`ls-files` に `--pathspec-from-file` は無いので、パスは引数で渡す

**最後の `git switch main` が失敗したとき**: 確認を通っても、確認で見えない衝突（feature が足すパスの親が main 側ではファイルになっている等）で失敗することがある。失敗の出力には main 側のファイルの名前が出るので、出力は捨てて終了コードだけを見る（`git -C <main のチェックアウト> switch main >/dev/null 2>&1`）。失敗したら、ユーザーのファイルには触れない。main のチェックアウトは統合前の commit で detached のまま残し（この場合だけ）、失敗したことと feature 側のパスを最後の 1 通で知らせる（例外 X3）。

**`git push` が使えない場合**: 上の表の「1 つのチェックアウト」と同じローカルのマージ（`git merge --no-ff <feature>`）を、フラグのある feature の worktree で行う。hook はコマンドを実行したチェックアウトのフラグを読むので、フラグの無い main のチェックアウトでの `git merge` は止まる。

1. main を開いているチェックアウトで `git switch --detach` を実行する（detach 済みならそのまま）
2. feature の worktree で `git switch main` → `git merge --no-ff <feature>` → `git switch <feature>` を実行する
3. main のチェックアウトで `git switch main` を実行する（出力の扱いと失敗したときは上と同じ）
4. `.quality-check-passed` を削除する

deny 以外の理由（quality gate、git の non-fast-forward 拒否 等）で push / merge が拒否されたら、両方を元に戻し（feature の worktree が main にいれば `git switch <feature>`、main のチェックアウトは `git switch main`）、quality-check をやり直す（main が先に進んでいれば、main を取り込んでから）。main のチェックアウトを detached のまま残さない（例外は上の「最後の `git switch main` が失敗したとき」だけ）。

`git branch -f main <feature>`・`git fetch . <feature>:main` も、フラグが `<feature>` の先端を指していれば通るが、手順は上の 2 つにそろえる。

## PR作成時の必須事項

```bash
git commit -m "feat: [機能名]の実装 (closes #[Issue番号])"
```
