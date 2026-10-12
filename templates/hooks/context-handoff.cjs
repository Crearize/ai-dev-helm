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

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');

const INJECT_LIMIT = 9000; // Claude Code moves additionalContext over 10,000 characters into a file
const DEFAULT_NOTICE_TOKENS = 300000;
const NOTICE_STEP = 100000;
const MARKER_MAX_AGE_MS = 120000;
const MARKER_WAIT_MS = 5000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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

function storeRoot() {
  return process.env.AI_DEV_HELM_HANDOFF_DIR || path.join(os.homedir(), '.claude', 'context-handoff');
}

function projectStore(transcriptPath) {
  const name = transcriptPath ? path.basename(path.dirname(transcriptPath)) : 'unknown';
  return path.join(storeRoot(), name.replace(/[^\w.-]/g, '_') || 'unknown');
}

function recordPath(transcriptPath, sessionId) {
  return path.join(projectStore(transcriptPath), `${String(sessionId || 'unknown').replace(/[^\w.-]/g, '_')}.md`);
}

function logError(event, error) {
  try {
    const file = path.join(storeRoot(), 'errors.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > ERROR_LOG_MAX) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${new Date().toISOString()} ${event || '-'} ${(error && error.stack) || error}\n`);
  } catch {
    // Logging must not make the hook fail.
  }
}

function write(output) {
  fs.writeSync(1, JSON.stringify(output));
}

// A project that registers its own copy runs it; the global copy then stays quiet so nothing runs twice.
function deferToProject(input) {
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!dir) return false;
  const hook = path.join(dir, '.claude', 'hooks', 'context-handoff.cjs');
  if (path.resolve(hook).toLowerCase() === path.resolve(__filename).toLowerCase()) return false;
  try {
    return fs.existsSync(hook) && fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8').includes('context-handoff.cjs');
  } catch {
    return false;
  }
}

// ---------- transcript ----------

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…（${s.length - max} 文字省略）` : s;
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
  let text = contentText(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    text = `${command[1].trim()} ${args ? args[1].trim() : ''}`;
  }
  return text.trim();
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
  return raw.replace(/\s*Read the answers carefully[\s\S]*$/, '').trim();
}

async function readTranscript(file) {
  const record = { messages: [], turns: [], files: new Map(), ops: [], prs: new Map(), compactSummary: '', cwd: '', branch: '' };
  if (!file || !fs.existsSync(file)) return record;
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
    if (entry.cwd) record.cwd = entry.cwd;
    if (entry.gitBranch) record.branch = entry.gitBranch;
    const at = entry.timestamp || '';

    if (entry.type === 'pr-link' && entry.prUrl) {
      record.prs.set(entry.prUrl, { at, text: `PR #${entry.prNumber || '?'} ${entry.prUrl}` });
      continue;
    }
    const content = entry.message && entry.message.content;
    if (entry.type === 'user') {
      if (entry.isCompactSummary) {
        record.compactSummary = contentText(content);
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_result' && askIds.has(block.tool_use_id) && !block.is_error) {
            const text = answerText(block);
            // An interrupted call leaves a "[Tool call interrupted ...]" result, which is not an answer.
            if (text && !text.startsWith('[')) record.messages.push({ at, kind: '質問への回答', text: clip(text, MAX_PROMPT_CHARS) });
          }
        }
      }
      if (!isHumanPrompt(entry)) continue;
      const text = promptText(content);
      if (!text) continue;
      record.messages.push({ at, kind: '指示', text: clip(text, MAX_PROMPT_CHARS) });
      current = { at, prompt: text, replies: [] };
      record.turns.push(current);
      if (record.turns.length > RECENT_TURNS) record.turns.shift();
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text && current) current.replies.push(block.text);
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      if (block.name === 'AskUserQuestion') askIds.add(block.id);
      if (EDIT_TOOLS.has(block.name)) {
        const target = input.file_path || input.notebook_path;
        if (target) {
          record.files.delete(target);
          record.files.set(target, at);
        }
      }
      if (SHELL_TOOLS.has(block.name) && typeof input.command === 'string' && OP_RE.test(input.command)) {
        const text = clip(input.command.split(/\r?\n/)[0], 300);
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
  if (meta.instructions) out.push(`- /compact に付けた指示: ${meta.instructions}`);
  out.push(`- 作業ディレクトリ: ${record.cwd || meta.cwd || '-'}`);
  out.push(`- ブランチ: ${record.branch || '-'}`);
  out.push(`- 会話 ID: ${meta.sessionId || '-'}`);
  out.push(`- 会話記録: ${meta.transcriptPath || '-'}`);
  out.push('', 'この記録は会話記録（jsonl）からプログラムで抜き出したもので、要約ではない。', '');

  const messages = [...record.messages].reverse();
  out.push(`## ユーザーの指示と質問への回答（原文・新しい順・${messages.length} 件）`, '');
  messages.forEach((m, i) => out.push(`### ${i + 1}. ${localTime(m.at)}（${m.kind}）`, '', quote(m.text), ''));

  out.push('## 直近のやり取り（古い順）', '');
  for (const turn of record.turns) {
    out.push(`### ユーザー（${localTime(turn.at)}）`, '', quote(clip(turn.prompt, MAX_REPLY_CHARS)), '');
    out.push('### Claude', '', quote(clip(turn.replies.join('\n\n') || '（文の応答なし）', MAX_REPLY_CHARS)), '');
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
    out.push('## 直前のコンパクトの要約', '', quote(clip(record.compactSummary, MAX_PROMPT_CHARS)), '');
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
  if (lastTurn && lastTurn.replies.length) {
    tail.push('## 直前の Claude の応答（途中まで）', clip(lastTurn.replies.join('\n\n'), 1500), '');
  }
  const files = [...record.files.keys()].reverse().slice(0, 20);
  if (files.length) tail.push('## 変更したファイル（新しい順）', ...files.map((f) => `- ${oneLine(f, 200)}`), '');
  const ops = newestOps(record).slice(0, 10);
  if (ops.length) tail.push('## PR と git の操作（新しい順）', ...ops.map((o) => `- ${localTime(o.at)} ${oneLine(o.text, 200)}`), '');
  const tailText = tail.join('\n');

  const title = '## ユーザーの指示と質問への回答（新しい順・原文。長いものは途中まで）';
  let budget = INJECT_LIMIT - head.length - tailText.length - title.length - 120;
  const lines = [];
  const messages = [...record.messages].reverse();
  let omitted = 0;
  for (const m of messages) {
    const line = `- ${localTime(m.at)}（${m.kind}） ${oneLine(m.text, 800)}`;
    if (line.length + 1 > budget) {
      omitted = messages.length - lines.length;
      break;
    }
    lines.push(line);
    budget -= line.length + 1;
  }
  if (omitted) lines.push(`- ほか ${omitted} 件は記録の全文にあります。`);
  const body = messages.length ? [title, ...lines, ''].join('\n') : '';
  const text = `${head}${body}\n${tailText}`.trim();
  return text.length > INJECT_LIMIT ? `${text.slice(0, INJECT_LIMIT - 1)}…` : text;
}

// ---------- store ----------

function prune(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && now - stat.mtimeMs > RETENTION_MS) fs.unlinkSync(file);
    }
  } catch {
    // Pruning is best effort.
  }
}

async function saveRecord(meta) {
  const record = await readTranscript(meta.transcriptPath);
  const file = recordPath(meta.transcriptPath, meta.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderRecord(record, meta), 'utf8');
  prune(path.dirname(file));
  return { record, file };
}

function markerFile(cwd) {
  const key = path.resolve(String(cwd || '')).toLowerCase();
  return path.join(storeRoot(), 'clear-markers', `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
}

function writeMarker(input) {
  const file = markerFile(input.cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    at: Date.now(),
  }));
}

async function takeMarker(cwd) {
  const file = markerFile(cwd);
  const deadline = Date.now() + MARKER_WAIT_MS;
  for (;;) {
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - Number(marker.at) <= MARKER_MAX_AGE_MS) {
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

// ---------- events ----------

function noticeThreshold() {
  const raw = process.env.AI_DEV_HELM_CONTEXT_NOTICE_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_NOTICE_TOKENS;
  const value = Number(raw);
  return Number.isFinite(value) ? value : DEFAULT_NOTICE_TOKENS;
}

function lastContextTokens(file) {
  if (!file || !fs.existsSync(file)) return 0;
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
      if (!usage) continue;
      return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    } catch {
      // The first line of the tail may be cut.
    }
  }
  return 0;
}

function notice(input) {
  const threshold = noticeThreshold();
  if (threshold <= 0) return;
  const tokens = lastContextTokens(input.transcript_path);
  const state = path.join(projectStore(input.transcript_path), `${String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_')}.notice.json`);
  if (tokens < threshold) {
    if (fs.existsSync(state)) fs.unlinkSync(state);
    return;
  }
  const band = Math.floor((tokens - threshold) / NOTICE_STEP);
  let last = -1;
  try {
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    // A changed threshold starts the count again.
    if (Number(saved.threshold) === threshold) last = Number(saved.band);
  } catch {
    last = -1;
  }
  if (Number.isFinite(last) && last >= band) return;
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ band, threshold, tokens, at: Date.now() }));
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
    if (event === 'Stop') {
      notice(input);
    } else if (event === 'PreCompact') {
      const reason = input.trigger === 'manual' ? 'compact-manual' : 'compact-auto';
      const instructions = input.custom_instructions || '';
      // SessionStart (compact) rebuilds the record and reads these back, since its input has no trigger.
      const trigger = recordPath(input.transcript_path, input.session_id).replace(/\.md$/, '.compact.json');
      fs.mkdirSync(path.dirname(trigger), { recursive: true });
      fs.writeFileSync(trigger, JSON.stringify({ reason, instructions, at: Date.now() }));
      await saveRecord({ ...base, reason, instructions });
    } else if (event === 'SessionEnd' && input.reason === 'clear') {
      writeMarker(input);
      await saveRecord({ ...base, reason: 'clear' });
    } else if (event === 'SessionStart' && input.source === 'compact') {
      let saved = {};
      const trigger = recordPath(input.transcript_path, input.session_id).replace(/\.md$/, '.compact.json');
      try {
        saved = JSON.parse(fs.readFileSync(trigger, 'utf8'));
        fs.unlinkSync(trigger);
      } catch {
        saved = {};
      }
      const fresh = Date.now() - Number(saved.at) <= 30 * 60 * 1000;
      await restore({ ...base, reason: fresh && saved.reason ? saved.reason : 'compact', instructions: fresh ? saved.instructions || '' : '' });
    } else if (event === 'SessionStart' && input.source === 'clear') {
      const marker = await takeMarker(input.cwd);
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

module.exports = { readTranscript, renderRecord, renderInjection, lastContextTokens, INJECT_LIMIT };
