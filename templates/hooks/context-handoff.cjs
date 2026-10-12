#!/usr/bin/env node
'use strict';

// context-handoff: keeps a program-extracted record of the conversation across /compact and /clear.
//
//   Stop                     -> when the context is large, tell the user that /clear is safe at a break
//   PreCompact               -> save the record (user instructions verbatim, answers, recent turns, files, git / PR)
//   SessionStart (compact)   -> rebuild the record and put its key points back (additionalContext)
//   SessionEnd (clear)       -> leave a marker for the next session, then save the record
//   SessionStart (clear)     -> read the marker and put the previous conversation's key points back
//
// The record is extracted from the transcript, not summarized by a model. It never blocks: every path exits 0
// (exit 2 on PreCompact would stop compaction, and on Stop would keep the turn going). Errors go to errors.log.
// With --scope=global (registered in ~/.claude/settings.json) it does nothing when the project registers its own copy.
// AI_DEV_HELM_HANDOFF=off turns the whole hook off.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const INJECT_LIMIT = 9000; // Claude Code moves additionalContext over 10,000 characters into a file
const DEFAULT_NOTICE_TOKENS = 300000;
const NOTICE_STEP = 100000;
const MARKER_MAX_AGE_MS = 120000;
const MARKER_WAIT_MS = 5000;
const COMPACT_TRIGGER_MAX_AGE_MS = 30 * 60 * 1000;
const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 4 * 1024 * 1024;
const RECENT_TURNS = 5;
const MAX_PROMPT_CHARS = 20000;
const MAX_REPLY_CHARS = 4000;
const MAX_FILES = 100;
const MAX_OPS = 50;
const ERROR_LOG_MAX = 1024 * 1024;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const OP_RE = /\b(?:git\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|switch|checkout\s+-b|worktree\s+add|tag|rebase)|gh\s+(?:pr|issue|release)|npm\s+(?:publish|version))\b/;
const NOT_PROMPT_RE = /^(?:<task-notification>|<local-command-|<bash-input>|<bash-stdout>|Caveat:|\[Request interrupted)/;
// Files this hook writes (named by Claude Code's session id, a UUID, or "unknown"); pruning never touches anything else.
const OWN_FILE_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|unknown)\.(?:md|notice\.json|compact\.json)$/i;

// Secrets that are easy to paste by mistake. The record and the restored context carry [REDACTED] instead.
// The patterns are bounded or anchored on a fixed prefix; run them through cleanText, which caps the text first, so
// they stay fast on long pastes.
const SECRET_PATTERNS = [
  // user:password@ in a URL (ASCII only; the user may be empty and the password may itself contain "@").
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)(?:(?![/?#:@])[\x21-\x7e])*:(?:(?![/?#])[\x21-\x7e])+@/gi, '$1[REDACTED]@'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9]{40,}/g, '[REDACTED]'],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[REDACTED]'],
  [/\b([Bb]earer[ \t]+)[A-Za-z0-9._~+/-]{20,}=*/g, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g, '[REDACTED]'],
];
// A key block whose end was cut off.
const OPEN_KEY_RE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/;
const TAIL_DROP_MAX = 200;

function redact(text) {
  return SECRET_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), String(text || ''));
}

// Cap at max first, then redact: redaction only shortens text, so nothing from beyond the cap can slide in, and long
// pastes are never scanned in full. A secret cut in half at the cap may survive the patterns, so an unterminated key
// block and a trailing run of ASCII non-space characters (the half of a token or password) are dropped. The omitted
// count is taken from the original length (total, when the caller kept only the start of a longer text).
function cleanText(text, max, total) {
  const s = String(text || '');
  const full = Math.max(Number(total) || 0, s.length);
  if (full <= max) return redact(s);
  const head = redact(cut(s, max)).replace(OPEN_KEY_RE, '[REDACTED]');
  let end = head.length;
  while (end > 0 && head.length - end < TAIL_DROP_MAX && /[\x21-\x7e]/.test(head[end - 1])) end -= 1;
  const kept = head.slice(0, end);
  return `${kept}…（${full - kept.length} 文字省略）`;
}

// ---------- store ----------

// AI_DEV_HELM_HANDOFF_DIR is for tests. Pruning only removes this hook's own file names, wherever it points.
function storeRoot() {
  return path.resolve(process.env.AI_DEV_HELM_HANDOFF_DIR || path.join(os.homedir(), '.claude', 'context-handoff'));
}

// A path segment from outside input: never '', '.' or '..', so files stay inside the store.
function safeName(raw) {
  const name = String(raw || '').replace(/[^\w.-]/g, '_');
  return /^\.*$/.test(name) ? 'unknown' : name;
}

function projectStore(transcriptPath) {
  return path.join(storeRoot(), safeName(transcriptPath ? path.basename(path.dirname(String(transcriptPath))) : ''));
}

function sessionFile(transcriptPath, sessionId, ext) {
  return path.join(projectStore(transcriptPath), `${safeName(sessionId)}${ext}`);
}

// The record holds the user's own words, so it is readable by the user only (POSIX; Windows inherits the folder ACL).
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 });
}

function logError(event, error) {
  try {
    const file = path.join(storeRoot(), 'errors.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size > ERROR_LOG_MAX) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${new Date().toISOString()} ${event || '-'} ${(error && error.stack) || error}\n`, { mode: 0o600 });
  } catch {
    // Logging must not make the hook fail.
  }
}

// Keep records no longer than Claude Code keeps transcripts (cleanupPeriodDays), and at most 30 days.
function retentionMs() {
  let days = RETENTION_DAYS;
  try {
    const value = Number(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).cleanupPeriodDays);
    if (Number.isFinite(value) && value > 0) days = Math.min(days, value);
  } catch {
    // No readable settings: keep the default.
  }
  return days * 24 * 60 * 60 * 1000;
}

// At most once a day, remove this hook's own old files from every project folder of the store, and stale markers.
function prune() {
  try {
    const root = storeRoot();
    const stamp = path.join(root, '.last-prune');
    if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < PRUNE_INTERVAL_MS) return;
    writePrivate(stamp, String(Date.now()));
    const limit = Date.now() - retentionMs();
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(root, dir.name);
      const markers = dir.name === 'clear-markers';
      for (const name of fs.readdirSync(folder)) {
        if (!(markers ? name.endsWith('.json') : OWN_FILE_RE.test(name))) continue;
        const file = path.join(folder, name);
        // One unreadable or vanished file must not stop the rest.
        try {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && stat.mtimeMs < (markers ? Date.now() - PRUNE_INTERVAL_MS : limit)) fs.unlinkSync(file);
        } catch {
          // Skip it.
        }
      }
    }
  } catch (error) {
    logError('prune', error);
  }
}

function write(output) {
  fs.writeSync(1, JSON.stringify(output));
}

// A project that registers its own copy runs it; the global copy then stays quiet so nothing runs twice.
function deferToProject(input) {
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!dir) return false;
  const hook = path.join(String(dir), '.claude', 'hooks', 'context-handoff.cjs');
  if (path.resolve(hook).toLowerCase() === path.resolve(__filename).toLowerCase()) return false;
  if (!fs.existsSync(hook)) return false;
  return ['settings.json', 'settings.local.json'].some((name) => {
    try {
      return fs.readFileSync(path.join(String(dir), '.claude', name), 'utf8').includes('context-handoff.cjs');
    } catch {
      return false;
    }
  });
}

// ---------- transcript ----------

// Cut at most n UTF-16 units without splitting a surrogate pair (a lone surrogate can break the API request).
function cut(text, n) {
  const s = String(text);
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${cut(s, max)}…（${s.length - max} 文字省略）` : s;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') return '[画像]';
    return '';
  }).filter(Boolean).join('\n');
}

function promptText(content) {
  let text = contentText(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // A slash command is recorded as tags at the start; tags quoted inside an instruction stay as they are.
  if (/^<command-(?:name|message)>/.test(text)) {
    const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (command) text = `${command[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  return text;
}

function isHumanPrompt(entry) {
  if (entry.isMeta || entry.isCompactSummary || entry.toolUseResult) return false;
  const content = entry.message && entry.message.content;
  if (Array.isArray(content) && content.some((block) => block && block.type === 'tool_result')) return false;
  if (entry.origin && typeof entry.origin === 'object') return entry.origin.kind === 'human';
  const text = contentText(content).trimStart();
  return Boolean(text) && !NOT_PROMPT_RE.test(text);
}

function answerText(block) {
  const raw = typeof block.content === 'string' ? block.content : contentText(block.content);
  const tail = raw.indexOf('Read the answers carefully');
  return (tail >= 0 ? raw.slice(0, tail) : raw).trim();
}

async function readTranscript(file) {
  const record = { messages: [], turns: [], files: new Map(), ops: [], prs: new Map(), compactSummary: '', cwd: '', branch: '' };
  if (typeof file !== 'string' || !file || !fs.existsSync(file)) return record;
  const askIds = new Set();
  let current = null;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"pr-link"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    if (typeof entry.cwd === 'string') record.cwd = entry.cwd;
    if (typeof entry.gitBranch === 'string') record.branch = entry.gitBranch;
    const at = entry.timestamp || '';

    if (entry.type === 'pr-link' && entry.prUrl) {
      record.prs.set(entry.prUrl, { at, text: cleanText(`PR #${entry.prNumber || '?'} ${entry.prUrl}`, 300) });
      continue;
    }
    const content = entry.message && entry.message.content;
    if (entry.type === 'user') {
      if (entry.isCompactSummary) {
        record.compactSummary = cleanText(contentText(content), MAX_PROMPT_CHARS);
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && askIds.has(block.tool_use_id) && !block.is_error) {
            const text = answerText(block);
            // An interrupted call leaves a "[Tool call interrupted ...]" result, which is not an answer.
            if (text && !text.startsWith('[')) record.messages.push({ at, kind: '質問への回答', text: cleanText(text, MAX_PROMPT_CHARS) });
          }
        }
      }
      if (!isHumanPrompt(entry)) continue;
      const raw = promptText(content);
      if (!raw) continue;
      record.messages.push({ at, kind: '指示', text: cleanText(raw, MAX_PROMPT_CHARS) });
      // Replies keep only their start (and their full length for the omitted count); they are cleaned when rendered.
      current = { at, prompt: cleanText(raw, MAX_REPLY_CHARS), replyText: '', replyLength: 0 };
      record.turns.push(current);
      if (record.turns.length > RECENT_TURNS) record.turns.shift();
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text && current) {
        const add = `${current.replyLength ? '\n\n' : ''}${block.text}`;
        current.replyLength += add.length;
        if (current.replyText.length < MAX_REPLY_CHARS) current.replyText += add;
      }
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      if (block.name === 'AskUserQuestion') askIds.add(block.id);
      if (EDIT_TOOLS.has(block.name)) {
        const target = input.file_path || input.notebook_path;
        if (typeof target === 'string' && target) {
          record.files.delete(target);
          record.files.set(target, at);
        }
      }
      if (SHELL_TOOLS.has(block.name) && typeof input.command === 'string' && OP_RE.test(input.command)) {
        const text = cleanText(input.command.split(/\r?\n/)[0], 300);
        const last = record.ops[record.ops.length - 1];
        if (last && last.text === text) last.at = at;
        else record.ops.push({ at, text });
      }
    }
  }
  return record;
}

// ---------- rendering ----------

function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quote(text) {
  return String(text).split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function newestOps(record) {
  const prs = [...record.prs.values()];
  return [...prs, ...record.ops].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function reasonLabel(reason) {
  return { 'compact-manual': 'コンパクト（/compact）', 'compact-auto': '自動コンパクト', compact: 'コンパクト', clear: '/clear' }[reason] || reason;
}

function renderRecord(record, meta) {
  const out = [];
  out.push('# 会話の記録（context-handoff）', '');
  out.push(`- 作った時刻: ${localTime(new Date().toISOString())}`);
  out.push(`- きっかけ: ${reasonLabel(meta.reason)}`);
  if (meta.instructions) out.push(`- /compact に付けた指示: ${cleanText(meta.instructions, 2000).replace(/\s+/g, ' ')}`);
  out.push(`- 作業ディレクトリ: ${record.cwd || meta.cwd || '-'}`);
  out.push(`- ブランチ: ${record.branch || '-'}`);
  out.push(`- 会話 ID: ${meta.sessionId || '-'}`);
  out.push(`- 会話記録: ${meta.transcriptPath || '-'}`);
  out.push('', 'この記録は会話記録（jsonl）からプログラムで抜き出したもので、要約ではない。秘密情報らしい文字列は [REDACTED] に置き換えている。', '');

  const messages = [...record.messages].reverse();
  out.push(`## ユーザーの指示と質問への回答（原文・新しい順・${messages.length} 件）`, '');
  messages.forEach((m, i) => out.push(`### ${i + 1}. ${localTime(m.at)}（${m.kind}）`, '', quote(m.text), ''));

  out.push('## 直近のやり取り（古い順）', '');
  for (const turn of record.turns) {
    out.push(`### ユーザー（${localTime(turn.at)}）`, '', quote(turn.prompt), '');
    out.push('### Claude', '', quote(turn.replyLength ? cleanText(turn.replyText, MAX_REPLY_CHARS, turn.replyLength) : '（文の応答なし）'), '');
  }

  const files = [...record.files.keys()].reverse().slice(0, MAX_FILES);
  out.push(`## 変更したファイル（新しい順・${files.length} 件）`, '');
  files.forEach((f) => out.push(`- ${f}`));
  out.push('');

  const ops = newestOps(record).slice(0, MAX_OPS);
  out.push(`## PR と git の操作（新しい順・${ops.length} 件）`, '');
  ops.forEach((o) => out.push(`- ${localTime(o.at)} \`${o.text}\``));
  out.push('');

  if (record.compactSummary) {
    out.push('## 直前のコンパクトの要約', '', quote(record.compactSummary), '');
  }
  return `${out.join('\n')}\n`;
}

function oneLine(text, max) {
  return clip(String(text).replace(/\s+/g, ' ').trim(), max);
}

function renderInjection(record, meta, file) {
  const head = [
    `[context-handoff] 直前の${reasonLabel(meta.reason)}の前の会話の記録です（会話記録からプログラムで抜き出したもの。要約ではありません）。`,
    `記録の全文: ${file}`,
    '細部と古い指示はこのファイルを Read で読んでください。要約と食い違うときは、この記録を優先してください。',
    `作業ディレクトリ: ${record.cwd || meta.cwd || '-'} / ブランチ: ${record.branch || '-'}`,
    '',
  ].join('\n');

  const tail = [];
  const lastTurn = record.turns[record.turns.length - 1];
  if (lastTurn && lastTurn.replyLength) {
    // Quoted, so text the reply copied from a file cannot pose as a heading of this context.
    tail.push('## 直前の Claude の応答（途中まで）', quote(cleanText(lastTurn.replyText, 1500, lastTurn.replyLength)), '');
  }
  const files = [...record.files.keys()].reverse().slice(0, 20);
  if (files.length) tail.push('## 変更したファイル（新しい順）', ...files.map((f) => `- ${oneLine(f, 200)}`), '');
  const ops = newestOps(record).slice(0, 10);
  if (ops.length) tail.push('## PR と git の操作（新しい順）', ...ops.map((o) => `- ${localTime(o.at)} ${oneLine(o.text, 200)}`), '');
  const tailText = tail.join('\n');

  const title = '## ユーザーの指示と質問への回答（新しい順・原文。長いものは途中まで）';
  let budget = INJECT_LIMIT - head.length - tailText.length - title.length - 120;
  const messages = [...record.messages].reverse();
  const prefixOf = (m) => `- ${localTime(m.at)}（${m.kind}） `;
  const chosen = new Map();
  // The newest instruction (not an answer) always goes in, shortened to what is left; then newest first while they fit.
  const must = messages.find((m) => m.kind === '指示') || messages[0];
  if (must) {
    let line = `${prefixOf(must)}${oneLine(must.text, 800)}`;
    if (line.length + 1 > budget) line = `${prefixOf(must)}${oneLine(must.text, Math.max(200, budget - prefixOf(must).length - 20))}`;
    chosen.set(must, line);
    budget -= line.length + 1;
  }
  for (const m of messages) {
    if (m === must) continue;
    const line = `${prefixOf(m)}${oneLine(m.text, 800)}`;
    if (line.length + 1 > budget) break;
    chosen.set(m, line);
    budget -= line.length + 1;
  }
  const lines = messages.filter((m) => chosen.has(m)).map((m) => chosen.get(m));
  const omitted = messages.length - chosen.size;
  if (omitted) lines.push(`- ほか ${omitted} 件は記録の全文にあります。`);
  const body = messages.length ? [title, ...lines, ''].join('\n') : '';
  const text = `${head}${body}\n${tailText}`.trim();
  return text.length > INJECT_LIMIT ? `${cut(text, INJECT_LIMIT - 1)}…` : text;
}

// ---------- events ----------

async function saveRecord(meta) {
  const record = await readTranscript(meta.transcriptPath);
  const file = sessionFile(meta.transcriptPath, meta.sessionId, '.md');
  writePrivate(file, renderRecord(record, meta));
  prune();
  return { record, file };
}

// The marker is keyed by the transcript folder (the project Claude Code was started in), which /clear keeps even when
// the conversation moved to another directory such as a worktree.
function markerFile(transcriptPath) {
  return path.join(storeRoot(), 'clear-markers', `${safeName(transcriptPath ? path.basename(path.dirname(String(transcriptPath))) : '')}.json`);
}

function writeMarker(input) {
  writePrivate(markerFile(input.transcript_path), JSON.stringify({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    at: Date.now(),
  }));
}

async function takeMarker(input) {
  const file = markerFile(input.transcript_path);
  const deadline = Date.now() + MARKER_WAIT_MS;
  for (;;) {
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - Number(marker.at) <= MARKER_MAX_AGE_MS && marker.sessionId !== input.session_id) {
        fs.unlinkSync(file);
        return marker;
      }
    } catch {
      // Not written yet (SessionEnd may still be running) or unreadable.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function noticeThreshold() {
  const raw = process.env.AI_DEV_HELM_CONTEXT_NOTICE_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_NOTICE_TOKENS;
  const value = Number(raw);
  return Number.isFinite(value) ? value : DEFAULT_NOTICE_TOKENS;
}

// The input size of the main conversation's last API call, or null when the tail holds none (then nothing changes).
function lastContextTokens(file) {
  if (typeof file !== 'string' || !file || !fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString('utf8').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry.type === 'assistant' && !entry.isSidechain && entry.message && entry.message.usage;
      // An API error leaves a "<synthetic>" message whose usage is all zero; it says nothing about the context.
      if (!usage || entry.message.model === '<synthetic>') continue;
      const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      if (tokens > 0) return tokens;
    } catch {
      // The first line of the tail may be cut.
    }
  }
  return null;
}

function notice(input) {
  const threshold = noticeThreshold();
  if (threshold <= 0) return;
  const tokens = lastContextTokens(input.transcript_path);
  if (tokens === null) return;
  const state = sessionFile(input.transcript_path, input.session_id, '.notice.json');
  if (tokens <= threshold) {
    if (fs.existsSync(state)) fs.unlinkSync(state);
    return;
  }
  const band = Math.floor((tokens - threshold - 1) / NOTICE_STEP);
  let last = -1;
  try {
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    // A changed threshold starts the count again.
    if (Number(saved.threshold) === threshold) last = Number(saved.band);
  } catch {
    last = -1;
  }
  if (Number.isFinite(last) && last >= band) return;
  writePrivate(state, JSON.stringify({ band, threshold, tokens, at: Date.now() }));
  write({
    systemMessage: `文脈が約 ${Math.round(tokens / 10000)} 万トークンになっています。区切りのよいところで /clear すると、会話の記録を引き継いだまま軽くできます（context-handoff）。`,
  });
}

async function restore(meta) {
  const { record, file } = await saveRecord(meta);
  if (!record.messages.length && !record.turns.length) return;
  write({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: renderInjection(record, meta, file) } });
}

async function main() {
  if (String(process.env.AI_DEV_HELM_HANDOFF || '').toLowerCase() === 'off') return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const event = input.hook_event_name;
  try {
    if (process.argv.includes('--scope=global') && deferToProject(input)) return;
    const base = { sessionId: input.session_id, transcriptPath: input.transcript_path, cwd: input.cwd };
    const trigger = sessionFile(input.transcript_path, input.session_id, '.compact.json');
    if (event === 'Stop') {
      notice(input);
    } else if (event === 'PreCompact') {
      const reason = input.trigger === 'manual' ? 'compact-manual' : 'compact-auto';
      const instructions = typeof input.custom_instructions === 'string' ? input.custom_instructions : '';
      // SessionStart (compact) rebuilds the record and reads these back, since its input has no trigger.
      writePrivate(trigger, JSON.stringify({ reason, instructions: cleanText(instructions, 2000), at: Date.now() }));
      await saveRecord({ ...base, reason, instructions });
    } else if (event === 'SessionEnd' && input.reason === 'clear') {
      writeMarker(input);
      await saveRecord({ ...base, reason: 'clear' });
    } else if (event === 'SessionStart' && input.source === 'compact') {
      let saved = {};
      try {
        saved = JSON.parse(fs.readFileSync(trigger, 'utf8'));
        fs.unlinkSync(trigger);
      } catch {
        saved = {};
      }
      const fresh = Date.now() - Number(saved.at) <= COMPACT_TRIGGER_MAX_AGE_MS;
      await restore({ ...base, reason: fresh && saved.reason ? saved.reason : 'compact', instructions: fresh ? saved.instructions || '' : '' });
    } else if (event === 'SessionStart' && input.source === 'clear') {
      const marker = await takeMarker(input);
      if (marker) await restore({ sessionId: marker.sessionId, transcriptPath: marker.transcriptPath, cwd: marker.cwd, reason: 'clear' });
    }
  } catch (error) {
    logError(event, error);
  }
}

if (require.main === module) {
  main().catch((error) => logError('main', error)).finally(() => {
    process.exitCode = 0;
  });
}

module.exports = { readTranscript, renderRecord, renderInjection, lastContextTokens, redact, cut, prune, INJECT_LIMIT };
