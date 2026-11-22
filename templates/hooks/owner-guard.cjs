#!/usr/bin/env node
'use strict';

// owner-guard（3.8.0、#248、設計 A5）: 質問と作業依頼のガード。Claude Code だけに登録する。
//
// 目的: AI のうっかり（区分の無い質問、調べずに聞く質問、上限の内の延長を聞く質問、ユーザーに操作を頼む応答）を
// その場で差し戻す。意図的な回避は追わない（印を付ければ通る）。読めない入力・状態は通す（fail-open）。
// 依存なし（Node だけ）。差し戻しは必ず JSON を stdout に出して exit 0 で返す（登録のラッパーは本体の終了コードを
// 捨てるので、exit 2 と stderr では差し戻せない）。
//
// PreToolUse（matcher ^AskUserQuestion$）。tool_input.questions の各問いの header を見る:
//   - header の先頭に区分が無い                         -> deny（区分を付けて聞き直す）
//     区分: 業務 客先 費用 資源 取消 範囲 本番 差異 設計 延長 テスト その他
//     形:   「区分」だけ／「区分:…」／「区分：…」（前後の空白は除く）
//   - 延長                                               -> 今のブランチの review-budget の状態で、最後に予約された巡
//     （全フェーズの rounds[].reservedAt の最大）のフェーズが quality か production で、そのフェーズがまだ上限
//     （limit＋オーナーが承認した extend の巡）に達していないときだけ deny。最後の巡が design・requirements・plan・
//     mutation、上限に達した、状態が無い・読めないときは通す。区分の後ろが 全員・停滞・設計・要件 で始まる
//     （延長:全員 = --full、延長:停滞 = X1 の停滞、延長:設計・延長:要件）ときも通す
//   - テスト                                             -> 通して注意（additionalContext）
//   - 業務・客先・範囲で、問いの文に「（調べたもの:」「（調べたもの：」が無い -> deny
//   - questions が読めない・空・判定の途中で失敗した     -> 通す
// Stop:
//   - stop_hook_active が真                              -> 通す（ほかの Stop フックとの無限ループを防ぐ）
//   - last_assistant_message（無ければ transcript_path の末尾の assistant の文）に、ユーザーへの操作の依頼
//     （REQUEST_PATTERNS・BANG_REQUEST）があり、同じ応答に [本人の操作] が無い -> {"decision":"block","reason":…}
//   - 読めない                                           -> 通す

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CLASSES = ['業務', '客先', '費用', '資源', '取消', '範囲', '本番', '差異', '設計', '延長', 'テスト', 'その他'];
// 調べたものを問いの文に書く区分（オーナーしか知らない事実・客先・範囲の増減）。
const LOOKED_CLASSES = new Set(['業務', '客先', '範囲']);
const LOOKED_MARKS = ['（調べたもの:', '（調べたもの：'];
// 延長の差し戻しの対象のフェーズ（review-budget の REVIEW_LIMIT を持つフェーズ）。
const EXTEND_PHASES = ['quality', 'production'];
// 延長のうち、上限の内でも聞いてよいもの（全員のレビュー・X1 の停滞・設計や要件のレビューの延長）。
const EXTEND_ASKABLE = ['全員', '停滞', '設計', '要件'];
const SELF_MARK = '[本人の操作]';
const TAIL_BYTES = 2 * 1024 * 1024;

// ユーザーへの操作の依頼。比べる前に、コードブロック・インラインのコード（〔コード〕に置き換える）・「」『』""“”
// の中・引用の行（>）・表の行（|）を除く（規則や文書の文を引いて述べただけのものを拾わないため）。
// 文面を貼る・写す（コピー・貼り付け）は、オーナーが自分で送る文面の受け渡しにも使うので入れない。
const VERBS = '(?:実行|ログイン|サインイン|入力|クリック|再起動|リロード|インストール|ドラッグ|マージ|プッシュ|設定)';
// ほしい・欲しいは文末だけ（「マージしてほしいと指示があった」「実行してほしい場合は」は依頼ではない）。
const END = '(?=[。．！!？?\\n]|$)';
const ASK = `(?:ください|下さい|もらえますか|もらえませんか|いただけますか|いただけませんか|頂けますか|頂けませんか|くれますか|いただけると|頂けると|ほしい(?:です)?${END}|欲しい(?:です)?${END})`;
const CODE = '〔コード〕';
const REQUEST_PATTERNS = [
  new RegExp(`${VERBS}し(?:直し)?て(?:みて)?${ASK}`),
  new RegExp(`(?:開い|押し|打っ|叩い|入れ)て(?:みて)?${ASK}`),
  new RegExp(`${VERBS}を?(?:お願い(?:します|いたします|できますか)|してください)`),
  new RegExp(`${CODE}\\s*を?(?:お願い(?:します|いたします|できますか))`),
  // 英語は文の先頭（行頭・句点の後）の Please だけ（「エラー: Please run … と出た」は拾わない）。
  /(?:^|[.!?。！？]\s*)(please (?:run|open|log ?in|sign in|click|press|type|enter|paste|restart|reload|install)\b)/im,
];
// Claude Code の `!<コマンド>`（本人がプロンプトで打つコマンド）を、同じ文の中で頼む・促すもの。元の文で探す
// （「設定ファイルに `! npm test` の例を書きました」は拾わない）。
const BANG_REQUEST = /`!\s*[A-Za-z][^`\n]*`[^。！!？?\n]*?(?:ください|下さい|お願い|ほしい|欲しい|できます|られます)/;

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

// header の先頭の区分と、その後ろの文（無ければ ''）。区分が無ければ null。
function headerClass(header) {
  const text = String(header).replace(/^﻿/, '').trim();
  for (const name of CLASSES) {
    if (!text.startsWith(name)) continue;
    const rest = text.slice(name.length).trimStart(); // 区分と区切りの間の空白（「延長 ：全員」）も受ける
    if (rest === '') return { name, label: '' };
    if (rest[0] === ':' || rest[0] === '：') return { name, label: rest.slice(1).trim() };
  }
  return null;
}

// review-budget.cjs の location() と同じ規則で、今のブランチの状態ファイルを読む。読めなければ null。
function readReviewState(cwd) {
  try {
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const common = fs.realpathSync(path.resolve(cwd, git(['rev-parse', '--git-common-dir'])));
    const branch = git(['symbolic-ref', '--quiet', 'HEAD']);
    const file = path.join(common, 'ai-dev-helm-reviews', `${crypto.createHash('sha256').update(branch).digest('hex')}.json`);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || state.version !== 1 || state.branch !== branch || !state.phases || typeof state.phases !== 'object') return null;
    return state;
  } catch {
    return null;
  }
}

// 最後に予約された巡のフェーズ（reservedAt の最大）。巡が無い・時刻が読めない・別のフェーズと同時刻なら null。
function lastRoundPhase(state) {
  let best = null;
  let tie = false;
  for (const [phase, group] of Object.entries(state.phases)) {
    for (const round of (group && Array.isArray(group.rounds) ? group.rounds : [])) {
      const at = round && typeof round.reservedAt === 'string' ? Date.parse(round.reservedAt) : NaN;
      if (!Number.isFinite(at)) continue;
      if (!best || at > best.at) { best = { phase, at }; tie = false; } else if (at === best.at && phase !== best.phase) tie = true;
    }
  }
  return best && !tie ? best.phase : null;
}

// 延長を差し戻すか: 最後の巡のフェーズが quality・production で、そのフェーズがまだ上限に達していないとき。
function extendBelowLimit(state) {
  if (!state) return false;
  const phase = lastRoundPhase(state);
  const group = phase && state.phases[phase];
  if (!EXTEND_PHASES.includes(phase) || !group || !Number.isInteger(group.limit) || !Array.isArray(group.rounds)) return false;
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  const added = extensions.filter((x) => x && x.phase === phase && Number.isInteger(x.rounds)).reduce((sum, x) => sum + x.rounds, 0);
  return group.rounds.length < group.limit + added;
}

function checkQuestion(input) {
  const questions = input.tool_input && input.tool_input.questions;
  if (!Array.isArray(questions) || !questions.length) return;
  const denies = [];
  const notes = [];
  let state;
  questions.forEach((q, index) => {
    if (!q || typeof q !== 'object' || typeof q.header !== 'string') return;
    const where = `問い ${index + 1}（header「${q.header}」）`;
    const cls = headerClass(q.header);
    if (!cls) {
      denies.push(`${where}: header の先頭に区分がありません。区分（${CLASSES.join('・')}）を「区分」「区分:…」「区分：…」の形で付けて聞き直してください（development-policy §1.0 の 9）。`);
      return;
    }
    if (cls.name === '延長') {
      if (EXTEND_ASKABLE.some((label) => cls.label.startsWith(label))) return;
      if (state === undefined) state = readReviewState(input.cwd || process.cwd());
      if (extendBelowLimit(state)) {
        denies.push(`${where}: このブランチで最後に予約したレビュー（quality・production）は、まだ上限の内です。上限の内なので、直した高があれば次の巡を回し、最後の報告に書いてください（聞かない）。X1 の停滞（作りの見直しの後の停滞）は「延長:停滞」、設計・要件のレビューの延長は「延長:設計」「延長:要件」、全員のレビュー（--full）は「延長:全員」の header で聞いてください。`);
      }
      return;
    }
    if (cls.name === 'テスト') {
      notes.push(`${where}: 追加のテストが、有料の API・実 AI を呼ばず、副作用が無く、見込み 30 分以内なら、聞かずに実施して最後の報告に書いてください（quality-policy §2）。当たらないときだけ、このまま聞いてください。`);
      return;
    }
    if (LOOKED_CLASSES.has(cls.name) && !LOOKED_MARKS.some((mark) => String(q.question || '').includes(mark))) {
      denies.push(`${where}: 「${cls.name}」の問いは、聞く前に調べてください。リポジトリの文書・会話に貼られた資料・過去の会話の記録・Drive などのうち、何を見たかを問いの文に「（調べたもの: …）」の形で書いて聞き直してください。調べて答えが分かったなら、聞かずに進めてください。`);
    }
  });
  if (denies.length) {
    writeJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `ai-dev-helm owner-guard: ${denies.join(' ')}` } });
  } else if (notes.length) {
    writeJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `ai-dev-helm owner-guard: ${notes.join(' ')}` } });
  }
}

// transcript の末尾（TAIL_BYTES）から、最後の user の行より後の assistant の文（サブエージェントの行を除く）を読む。
function lastAssistantText(file) {
  if (typeof file !== 'string' || !file) return null;
  const size = fs.statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; } // 先頭の行は途中で切れていることがある
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    if (entry.type === 'user') break;
    if (entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    const texts = typeof content === 'string' ? [content]
      : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
    parts.unshift(...texts);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// 依頼を探す前に、引いて述べただけの部分を除く。
function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, CODE)
    .replace(/「[^「」\n]*」|『[^『』\n]*』|"[^"\n]*"|“[^“”\n]*”/g, ' ')
    .split('\n').filter((line) => !/^\s*[>|]/.test(line)).join('\n');
}

function findRequest(text) {
  const plain = stripQuoted(text);
  for (const pattern of REQUEST_PATTERNS) {
    const m = pattern.exec(plain);
    if (m) return (m[1] || m[0]).trim();
  }
  const bang = BANG_REQUEST.exec(text);
  return bang ? bang[0] : null;
}

function checkStop(input) {
  if (input.stop_hook_active === true) return;
  let text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
  if (text === null) {
    try { text = lastAssistantText(input.transcript_path); } catch { text = null; }
  }
  if (!text || text.includes(SELF_MARK)) return;
  const found = findRequest(text);
  if (!found) return;
  writeJson({
    decision: 'block',
    reason: `ai-dev-helm owner-guard: 最後の応答で、ユーザーに操作を頼んでいます（該当: 「${found}」）。` +
      '承認が要る操作（マージ・本番への反映・取り消せない操作）なら、操作を頼まずに「〜してよいか」と承認を求めてください（確認の区分 C）。' +
      `本人にしかできない操作（MFA・SSO・VPN・本人の確認を必須にしている仕組み等）なら、準備をすべて済ませたうえで、同じ応答に ${SELF_MARK} と理由を書いて、本人の操作だけを 1 回にまとめて頼んでください（区分 D）。` +
      'それ以外は、自分で実行して確かめ、その結果を報告してください（development-policy §1.0「承認後の進め方」10）。',
  });
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    return; // 読めない入力は通す
  }
  if (!input || typeof input !== 'object') return;
  try {
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion') checkQuestion(input);
    else if (input.hook_event_name === 'Stop') checkStop(input);
  } catch {
    // ガードは fail-open（判定の途中の失敗は通す）
  }
}

module.exports = { headerClass, extendBelowLimit, lastRoundPhase, findRequest, lastAssistantText, CLASSES };
if (require.main === module) main();
