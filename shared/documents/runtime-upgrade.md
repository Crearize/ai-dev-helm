# ランタイムのメジャー版を上げるとき（Node.js）

Node.js のメジャー版を上げるとき（例: 22 → 26）に確かめることの一覧。2026-10 に導入先 10 件を Node 26.12.1 へそろえた作業で、共通して出たものをまとめている。版を上げる作業の計画に、当てはまる項目を入れる。

## パッケージマネージャー

- **Node 25 以降は corepack が同梱されない。** `corepack enable` を使う Dockerfile・ホスティングのビルドコマンド（Render の Build Command など）・CI は、先に `npm install -g corepack@<版>` を実行する（`node:26` の公式イメージにも corepack は無い）。PC の `~/bin/pnpm` などの corepack のシムも動かなくなるので、入れ直す。
- **`engines` だけでは止まらない。** pnpm も npm も、`engines` に合わない Node では警告を出すだけで続ける。インストールを失敗させたいときは、npm は `.npmrc` に `engine-strict=true`、pnpm は `pnpm-workspace.yaml` に `engineStrict: true` を書く。
- **pnpm のストアはハードリンクで共有される。** worktree の `node_modules` のファイルを直接書き換えると、同じストアを使う別のチェックアウトにも変更が及ぶ。依存に手を入れるときは `pnpm patch` を使う。

## テストと実行時の挙動

- **Node 25 以降は標準の Web Storage がある。** テストで jsdom / happy-dom の `localStorage` が Node の標準のものに覆われ、大量に落ちることがある。テストの実行器に `--no-webstorage`（古い版では `--no-experimental-webstorage`）を渡す。サーバー側（`next start` など）では `sessionStorage` がプロセス全体で 1 つになり、利用者の間で値が共有されるおそれがあるので、起動にも同じ指定を付けるか、使っていないことを確かめる。
- **ESLint の `import/order` などの並べ替えの結果が、Node の版で変わることがある。** 版を上げた後に lint の自動修正の差分が出たら、規則の不具合ではなく並びの変化かを確かめる。
- **Playwright のブラウザを入れ直すと、共有のキャッシュから使われていない古い版が消える。** 古い Playwright を使う別のプロジェクトでは、ブラウザの入れ直しが要る。

## CI と実行環境の版

- **`actions/setup-node` の `node-version: '22'` のような大まかな指定は、ランナーのキャッシュにある古い版を使うことがある**（修正版の 22.23.4 ではなく 22.23.2 が使われた例がある）。セキュリティ修正を確実に入れたいときは `check-latest: true` を付けるか、完全な版（`22.23.4`）を書く。
- **ホスティングの環境変数がリポジトリの指定より優先されることがある。** Render の `NODE_VERSION` は `.node-version` より優先されるので、リポジトリを直しても実行環境の版は変わらない。ビルドコマンドを先に替え、`NODE_VERSION` は本番への反映と同時に替える、という順番にする。Blueprint の同期より先にデプロイが始まり、古い版で一度ビルドされた例もある。
- **版を書いている場所をすべて直す。** `.node-version` / `.nvmrc`・`package.json` の `engines`・Dockerfile の基のイメージ・CI の `node-version`・ホスティングの環境変数・開発環境の手順書を、同じ版にそろえる。

## 確かめ方

- 版を上げた後、ローカルと CI の両方で、ビルド・静的チェック・テストを実行する。テストが大量に落ちたら、まず上の Web Storage を疑う。
- 本番に反映する前に、動作確認用の環境（staging）で、実際に使われている Node の版を確かめる（ログやヘルスチェックの出力など）。
