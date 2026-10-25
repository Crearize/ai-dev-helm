# lint-scaffolding: スタック検出とカバレッジマップ作成

本体（`SKILL.md`）の Step 1（スタック検出）と Step 2（カバレッジマップ作成と採否確認）で読む。

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

スキルのディレクトリの [`coverage-map-template.md`](../coverage-map-template.md) を雛形に、**カタログの25カテゴリ（A1〜F2）全行**についてカバレッジマップを作成する。行の省略は認めない。

各行に記録する内容:

| 記録項目 | 内容 |
|---|---|
| このスタックでの実現手段 | Step 1 の検出結果に対応する具体ツール・ルール（カタログの「一般的な実現手段」を読み替える） |
| 事前ビルド資産の有無 | **`lint/` 配下の実在を実際に確認する**（ディレクトリ・ファイルを列挙する。README に記載があっても実在しない資産を「あり」としない） |
| 採用基準 | カタログの 必須 / 推奨 / 任意（テンプレートに転記済み） |
| 🤖 | AI 生成コードで頻発するカテゴリか（テンプレートに転記済み） |

### 採否確認

採否確認（進め方・優先順位（MUST）・不採用時の扱い（MUST））は、本体（`SKILL.md`）の「確認の場面と進め方（毎回守る）」の「採否確認」に従う。
