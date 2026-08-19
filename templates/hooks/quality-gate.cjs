#!/usr/bin/env node
'use strict';

// PreToolUse hook: gate merges into main/master (and direct pushes to
// main/master) behind a passing quality check.
//
// The .quality-check-passed flag is JSON written by /quality-check:
//   { "branch": "<branch at check time>", "commit": "<HEAD sha at check time>" }
// `branch` is informational only — authorization uses `commit` alone.
// The flag is NOT consumed here. It stays valid while everything that changed
// after flag.commit is a harness file; /quality-check deletes and recreates
// it on each run.
//
// Gated commands (nothing else is touched):
//   - gh pr merge ...
//   - git merge ...            while the current branch is main/master
//   - git push targeting main/master (explicit refspec or current branch)
// Pushes to feature branches always pass.
//
// Failure policy: git failures during command detection (not a repo, empty
// branch name) fail open; verification failures after a command is confirmed
// gated (unresolvable source tip, gh errors) fail closed.
//
// Every git/gh invocation goes through execFileSync with an argv array: no
// shell is ever involved. Refs and paths taken from the command line or from
// a diff would otherwise be interpreted by the shell — cmd.exe expands `%VAR%`
// even inside double quotes, `>` redirects before the hook has decided
// anything, and POSIX shells run backtick/`$()` substitutions.
//
// Implemented in Node (a documented prerequisite of ai-dev-helm) so the hook
// works identically on Windows (cmd/PowerShell), macOS, and Linux.

const fs = require('fs');
const { execFileSync } = require('child_process');

const FLAG_FILE = '.quality-check-passed';

// Subcommand detection anywhere in the command line, including chained
// commands, subshells, and `git -C <dir> ...`. Group 2 captures the argument
// segment up to the next shell operator.
const GIT_PUSH_RE = /(^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?push\b([^;&|()]*)/;
const GIT_MERGE_RE = /(^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?merge\b([^;&|()]*)/;
const GH_PR_MERGE_RE = /(^|[;&|(])\s*gh\s+pr\s+merge\b([^;&|()]*)/;
const MERGE_CONTROL_RE = /\s--(abort|continue|quit|skip)\b/;

// Harness config files that may carry a `### Quality Gate Overrides` block
// (quality-policy.md §2「上書きの契約」). Spread into HARNESS_PATTERNS below so
// the two lists cannot drift apart.
const GATE_CONFIG_PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /^\.cursorrules$/,
];

// Merges/pushes whose entire (non-empty) diff matches these paths skip the
// gate. Aligned with the self-improvement skill's reflection targets, minus
// user-facing docs (README/docs/documents stay under the reduced review).
// Exception: changes to gate parameters never skip the gate — see
// GATE_PARAM_KEYS below.
const HARNESS_PATTERNS = [
  ...GATE_CONFIG_PATTERNS,
  /^\.claude\//,
  /^\.codex\//,
  /^\.cursor\//,
  /^skills\/(project|superpowers)\//,
  /^\.github\/review-[^/]*\.md$/,
  /^documents\/development\/coding-rules\//,
];

// The only recognized gate-parameter keys, per quality-policy.md §2
// 「上書きの契約」. A change to any of them is excluded from the harness-only
// exemption: weakening a threshold must never merge unchecked.
const GATE_PARAM_KEYS = [
  'mutation_threshold_high',
  'mutation_threshold_medium',
  'mutation_budget_minutes',
];
// Tolerant key matcher: markdown prose renders the same key with different
// case and word separators (`Mutation_Threshold_High`, `mutation-threshold-
// high`, `Mutation Threshold High`), and a reader recognizes all of them as
// the same declaration. Matching only the canonical spelling let every
// variant land as "declares nothing". Applied to already-normalized
// (lowercased, whitespace-collapsed) text.
const GATE_PARAM_KEY_RES = GATE_PARAM_KEYS.map((k) => ({
  key: k,
  re: new RegExp(k.replace(/_/g, '[-_ ]'), 'i'),
}));
const GATE_PARAM_KEY_RE = new RegExp(
  `(?:${GATE_PARAM_KEYS.map((k) => k.replace(/_/g, '[-_ ]')).join('|')})`,
  'i'
);
// `### Quality Gate Overrides` at any heading level, any case/separator.
const QGO_HEADING_RE = /quality[-_\s]*gate[-_\s]*overrides/i;

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
// Markdown decoration that can dress up a heading (ATX hashes, emphasis,
// backticks, setext underlines, table pipes) without changing what it says.
const HEADING_DECORATION_RE = /[`*_#|=~-]/g;

const MAX_BUFFER = 32 * 1024 * 1024;
// Blobs above this are not parsed: a harness config file that large is not a
// legitimate override declaration, and guessing at it is worse than a
// predictable fail-closed answer.
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

// Global deadline for the whole hook. Claude Code kills the hook at its
// configured timeout (settings.json.template pins 30s); every git call clamps
// its own timeout to what is left, so a pathological repo degrades into
// "cannot verify" (fail closed) instead of the hook being killed mid-decision.
const DEADLINE = Date.now() + 20000;

function remainingBudget() {
  return DEADLINE - Date.now();
}

function runGit(args, timeoutMs, encoding) {
  const budget = remainingBudget();
  if (budget <= 0) return null; // Out of budget: treat as unverifiable.
  try {
    return execFileSync('git', args, {
      encoding,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.min(timeoutMs, budget),
      maxBuffer: MAX_BUFFER,
    });
  } catch {
    return null;
  }
}

// Resolved once: pins every subsequent git call to the repository root so the
// hook's cwd cannot change what a path means. `diff.relative=false` is forced
// for the same reason — with `diff.relative` configured true and the hook
// running from a subdirectory, `git diff --name-only` emits paths relative to
// that subdirectory, and HARNESS_PATTERNS then matches the wrong things.
let repoTopResolved = false;
let repoTop = null;
function gitPrefix() {
  if (!repoTopResolved) {
    repoTopResolved = true;
    const out = runGit(['rev-parse', '--show-toplevel'], 2000, 'utf8');
    repoTop = out === null ? null : out.trim() || null;
  }
  return repoTop
    ? ['-C', repoTop, '-c', 'diff.relative=false']
    : ['-c', 'diff.relative=false'];
}

function tryGit(args, timeoutMs = 2000) {
  const out = runGit([...gitPrefix(), ...args], timeoutMs, 'utf8');
  return out === null ? null : out.trim();
}

function tryGitBuf(args, timeoutMs = 2000) {
  return runGit([...gitPrefix(), ...args], timeoutMs, 'buffer');
}

function gitOk(args, timeoutMs = 2000) {
  const budget = remainingBudget();
  if (budget <= 0) return false;
  try {
    execFileSync('git', [...gitPrefix(), ...args], {
      stdio: 'ignore',
      timeout: Math.min(timeoutMs, budget),
    });
    return true;
  } catch {
    return false;
  }
}

function tryGh(args, timeoutMs = 3000) {
  const budget = remainingBudget();
  if (budget <= 0) return null;
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.min(timeoutMs, budget),
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch {
    return null;
  }
}

function isMainBranch(name) {
  return name === 'main' || name === 'master';
}

function positionalArgs(segment) {
  return segment
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'));
}

function pushTargetsMain(command, branch) {
  // Scan every push segment in the command line, not just the first one:
  // `git push origin feature && git push origin main` must gate on the second.
  const segments = command.matchAll(new RegExp(GIT_PUSH_RE.source, 'g'));
  for (const m of segments) {
    // First positional arg is the remote; the rest are refspecs.
    const refspecs = positionalArgs(m[2]).slice(1);
    if (refspecs.length === 0) {
      if (isMainBranch(branch)) return true;
      continue;
    }
    const hit = refspecs.some((spec) => {
      const dst = spec.includes(':') ? spec.split(':').pop() : spec;
      return isMainBranch(dst.replace(/^\+/, '').replace(/^refs\/heads\//, ''));
    });
    if (hit) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Reading a harness config file at a rev
// --------------------------------------------------------------------------

const revExistsCache = new Map();
const pathProbeCache = new Map();
const overrideStateCache = new Map();

function revExists(rev) {
  if (!revExistsCache.has(rev)) {
    revExistsCache.set(rev, tryGit(['cat-file', '-t', rev]) !== null);
  }
  return revExistsCache.get(rev);
}

// Is `file` in the tree at `rev`? true / false / null (unknowable).
// A single-path pathspec probe rather than a full `ls-tree -r` listing: the
// evidence is identical but the cost is O(path) instead of O(repo), so the
// answer cannot start flipping on repo size in a large monorepo. `--` keeps a
// path that begins with `-` a path; `-z` keeps it verbatim rather than
// git-quoted.
function pathPresentAt(rev, file) {
  const key = `${rev}\0${file}`;
  if (!pathProbeCache.has(key)) {
    const out = tryGit(['ls-tree', '-z', rev, '--', file], 5000);
    pathProbeCache.set(key, out === null ? null : out.length > 0);
  }
  return pathProbeCache.get(key);
}

// Decode a blob to text. A harness config file is legitimately authorable in
// UTF-16 (Windows editors) — reading those bytes as UTF-8 turned every key
// into mojibake and made the declaration invisible. Anything with an embedded
// NUL that is not UTF-16 is binary: unknowable, so fail closed.
function decodeBlob(buf) {
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    if (buf.includes(0)) return null;
    const text = buf.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

// Blank out the interior of inline code spans, preserving length, so the
// caller can locate real comment delimiters by index in the masked copy while
// slicing text out of the original. `` `<!--` `` in prose is literal text:
// treating it as a comment opener let a decoy span comment out the live
// override block that followed it (and a matching `` `-->` `` span closed the
// fake comment again, hiding everything in between).
function maskCodeSpans(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n++;
      const run = '`'.repeat(n);
      const close = line.indexOf(run, i + n);
      if (close !== -1) {
        out += run + 'x'.repeat(close - (i + n)) + run;
        i = close + n;
        continue;
      }
    }
    out += line[i];
    i++;
  }
  return out;
}

// The part of `line` that is outside an HTML comment, starting from a state
// where no comment is open, and updating `state.inComment` for the caller.
// Only used on the not-currently-in-a-comment path: once a comment IS open,
// closing it is a raw scan (see extractOverrideEntries).
function liveText(line, state) {
  const masked = maskCodeSpans(line);
  let live = '';
  let i = 0;
  while (i < masked.length) {
    if (!state.inComment) {
      const open = masked.indexOf('<!--', i);
      if (open === -1) {
        live += line.slice(i);
        break;
      }
      live += line.slice(i, open);
      state.inComment = true;
      i = open + 4;
    } else {
      // A comment opened earlier on this same line: no inline processing
      // applies inside it, so the raw `-->` ends it.
      const close = line.indexOf('-->', i);
      if (close === -1) break;
      state.inComment = false;
      i = close + 3;
    }
  }
  return live;
}

function normalizeLine(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Which gate-parameter keys a normalized line mentions, as a stable id.
// Empty string means "none".
function matchedKeyId(norm) {
  return GATE_PARAM_KEY_RES.filter((k) => k.re.test(norm))
    .map((k) => k.key)
    .join('+');
}

// Does this line read as a `Quality Gate Overrides` heading once markdown
// decoration is stripped? Covers setext headings (`Quality Gate Overrides`
// over a `======` rule), which are headings just as much as the ATX form is.
function readsAsOverridesHeading(norm) {
  return QGO_HEADING_RE.test(norm.replace(HEADING_DECORATION_RE, ' '));
}

// What a harness config file *declares* about gate parameters — the contract
// of quality-policy.md §2「上書きの契約」 is about the declaration a reader
// sees, not about the raw bytes of any single line. Returns a list of
// `{context, keyId, line}` entries, or null when the document cannot be read
// with confidence. Hence:
//
//  - FIRST-OPENED CONTEXT WINS. Fenced content and commented content are both
//    inert, and whichever of the two opened first owns everything until its
//    own closer. So inside an open fence a `<!--` is literal (it must not
//    comment out the live block that follows the fence), and inside an open
//    comment a ``` is literal (it must not swallow the `-->` that ends the
//    comment and hide the live block below). Giving either one fixed priority
//    leaves the other direction open as a bypass; both were reproduced.
//  - Inside an open comment there is no inline processing at all (CommonMark
//    treats an HTML block as raw text), so a backtick-wrapped `` `-->` ``
//    still closes it. Protecting code spans there kept a comment open across
//    a live override block.
//  - Entries are context-tagged ("block" inside a `Quality Gate Overrides`
//    section, "outside" elsewhere). The same line means different things in
//    the two places, so moving an otherwise unchanged line into the overrides
//    section is a change of what the file declares. Setext headings count as
//    headings; so, fail-closed, does any line that simply reads as an
//    overrides heading once decoration is stripped. Over-opening the section
//    is the safe direction.
//  - A key line ending in `:` absorbs the next live line as its value, since
//    markdown renders `key:` / newline / `value` as one declaration.
//  - An unterminated fence or comment at EOF yields null, not an empty
//    declaration: one stray delimiter would otherwise permanently hide every
//    gate-parameter change below it.
//
// Deliberately over-inclusive: any live line that so much as mentions a key
// counts. Prose that discusses a key without declaring it belongs inside an
// HTML comment.
function extractOverrideEntries(src) {
  const entries = [];
  const commentState = { inComment: false };
  let fenceChar = null;
  let fenceLen = 0;
  let inOverridesBlock = false;
  let pending = -1;

  for (const raw of src.split(/\r?\n/)) {
    let live;

    if (commentState.inComment) {
      // A comment is open: raw text until the first literal `-->`.
      const close = raw.indexOf('-->');
      if (close === -1) continue;
      commentState.inComment = false;
      // The rest of the line is live again, and may open a new comment.
      live = liveText(raw.slice(close + 3), commentState);
    } else if (fenceChar !== null) {
      // A fence is open: only its own closer (same marker, at least as long)
      // ends it. Everything else, `<!--` included, is literal and inert.
      const fence = raw.match(FENCE_RE);
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen) {
        fenceChar = null;
      }
      continue;
    } else {
      const fence = raw.match(FENCE_RE);
      if (fence) {
        fenceChar = fence[1][0];
        fenceLen = fence[1].length;
        continue;
      }
      live = liveText(raw, commentState);
    }

    const norm = normalizeLine(live);
    if (norm === '') continue;

    const atxHeading = live.match(HEADING_RE);
    if (atxHeading) {
      pending = -1; // A heading terminates a pending `key:` value.
      inOverridesBlock = readsAsOverridesHeading(normalizeLine(atxHeading[1]));
      continue;
    }

    const keyId = matchedKeyId(norm);
    if (keyId === '' && readsAsOverridesHeading(norm)) {
      // Setext or otherwise undecorated overrides heading.
      pending = -1;
      inOverridesBlock = true;
      continue;
    }

    if (pending >= 0) {
      entries[pending].line += ' ' + norm;
      pending = -1;
    }
    if (keyId !== '') {
      entries.push({
        context: inOverridesBlock ? 'block' : 'outside',
        keyId,
        line: norm,
      });
      if (norm.endsWith(':')) pending = entries.length - 1;
    }
  }

  if (fenceChar !== null || commentState.inComment) return null;
  return entries;
}

// Canonical form of an entry list: per (context, key) the LAST declaration
// wins — that is what any reader of the document applies — and the resulting
// map is sorted, so it does not depend on document order.
//
// This is what separates the two orderings §2 distinguishes: swapping two
// lines that declare the SAME key changes which one is last, i.e. changes the
// effective threshold, and is not exempt; reordering two DISTINCT keys
// declares exactly the same thing and stays exempt.
function canonicalizeEntries(entries) {
  const lastPerKey = new Map();
  for (const e of entries) lastPerKey.set(`${e.context}\0${e.keyId}`, e.line);
  return JSON.stringify(
    [...lastPerKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

// The gate parameters `file` actually declares at `rev`, as a canonical
// string. Whole-file extraction, not diff lines: only comparing both sides
// catches an edit that flips an existing block between commented and live
// without touching any `mutation_*` line. Returns null when the content
// cannot be established (fail closed); a path genuinely absent at `rev` is a
// legitimate "declares nothing" and yields the empty state.
function overrideState(rev, file) {
  // Defense in depth: every rev reaching here is either a sha resolved by
  // git or the literal HEAD, never a token lifted from the command line.
  if (!/^[0-9a-f]{7,40}$/i.test(rev) && rev !== 'HEAD') return null;

  const key = `${rev}\0${file}`;
  if (overrideStateCache.has(key)) return overrideStateCache.get(key);

  const state = computeOverrideState(rev, file);
  overrideStateCache.set(key, state);
  return state;
}

function computeOverrideState(rev, file) {
  let src;
  const buf = tryGitBuf(['show', `${rev}:${file}`], 5000);
  if (buf === null) {
    // A failed read is not evidence of absence — it used to be treated as
    // such, which turned every unreadable blob (odd path, timeout, oversized
    // buffer) into "this file declares nothing" and opened the gate. Prove
    // absence from the tree listing instead.
    if (!revExists(rev)) return null;
    const present = pathPresentAt(rev, file);
    if (present === null) return null; // Cannot prove either way.
    if (present) return null; // Present but unreadable.
    src = '';
  } else {
    if (buf.length > MAX_BLOB_BYTES) return null;
    src = decodeBlob(buf);
    if (src === null) return null;
  }
  const entries = extractOverrideEntries(src);
  if (entries === null) return null;
  return canonicalizeEntries(entries);
}

function matchesHarnessPatterns(files) {
  return (
    files.length > 0 &&
    files.every((f) => HARNESS_PATTERNS.some((re) => re.test(f)))
  );
}

function gateConfigFiles(files) {
  return files.filter((f) => GATE_CONFIG_PATTERNS.some((re) => re.test(f)));
}

// quality-policy.md §2「上書きの契約」 carve-out: a harness config file whose
// declared gate parameters change is not exempt from the quality check.
function gateParamsUnchanged(files, baseRev, tipRev) {
  return !gateConfigFiles(files).some((f) => {
    const before = overrideState(baseRev, f);
    const after = overrideState(tipRev, f);
    return before === null || after === null || before !== after;
  });
}

function isHarnessOnly(files, baseRev, tipRev) {
  return (
    matchesHarnessPatterns(files) && gateParamsUnchanged(files, baseRev, tipRev)
  );
}

function diffFiles(range) {
  // -z: paths come back verbatim rather than git-quoted, so a path with
  // quotes or non-ASCII bytes still matches HARNESS_PATTERNS correctly.
  const out = tryGit(['diff', '--name-only', '-z', range], 5000);
  if (out === null) return null;
  return out.split('\0').map((l) => l.trim()).filter(Boolean);
}

function mergeBaseRef() {
  for (const ref of ['origin/main', 'origin/master']) {
    if (tryGit(['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  return null;
}

function readFlag() {
  try {
    const flag = JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8'));
    if (flag && typeof flag.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(flag.commit)) {
      return flag;
    }
  } catch {
    // Missing, legacy empty file, or malformed JSON — all invalid.
  }
  return null;
}

// Determine the commit whose content is about to land on main.
// Never derived from the flag (see spec A-3).
// The merge argument is the tip only when the merge itself is the gated
// operation (i.e. it runs on main). A non-gated merge on a feature branch
// (e.g. `git merge origin/main && git push origin main`) must not hijack
// tip resolution away from HEAD.
function resolveSourceTip(command, branch, isPush, mergeGated) {
  if (mergeGated) {
    const mergeMatch = command.match(GIT_MERGE_RE);
    // Try each positional token until one resolves; skips -m message text
    // and other flag values that are not refs. Tokens go to git as argv
    // elements, so a crafted "ref" is only ever an unresolvable ref.
    for (const ref of positionalArgs(mergeMatch[2])) {
      const sha = tryGit(['rev-parse', '--verify', '--quiet', ref]);
      if (sha) return sha;
    }
    return null;
  }
  if (!isMainBranch(branch) || isPush) {
    // Feature-branch gh pr merge / any gated push: HEAD is the content.
    return tryGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
  }
  // gh pr merge while on main: resolve the PR head via gh (network call,
  // bounded timeout; failure means "cannot verify" and blocks).
  const ghMatch = command.match(GH_PR_MERGE_RE);
  if (ghMatch) {
    const prArg = positionalArgs(ghMatch[2])[0];
    if (prArg) {
      const head = tryGh(
        ['pr', 'view', prArg, '--json', 'headRefName', '--jq', '.headRefName'],
        3000
      );
      if (head) {
        return (
          tryGit(['rev-parse', '--verify', '--quiet', `origin/${head}`]) ||
          tryGit(['rev-parse', '--verify', '--quiet', head])
        );
      }
    }
  }
  return null;
}

function block(reason) {
  // Emit both the current PreToolUse schema (hookSpecificOutput.
  // permissionDecision) and the legacy top-level decision field, so the
  // gate keeps blocking on both new and old Claude Code versions.
  console.log(
    JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

const STALE_REASON =
  'Code changed after the last quality check. Re-run /quality-check before merging.';

// The push-to-main case: the content is already committed on main, so
// "before merging" is impossible advice. Name what actually happened instead.
const STALE_MAIN_REASON =
  'main contains changes that were not part of the last quality check (the ' +
  'merge brought in commits made after the flag). Re-run /quality-check on ' +
  'the current main, then push.';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let command = '';
  try {
    const payload = JSON.parse(input);
    command = (payload.tool_input && payload.tool_input.command) || '';
  } catch {
    return; // Malformed payload: never block unrelated commands.
  }

  const isGh = GH_PR_MERGE_RE.test(command);
  const isMerge = GIT_MERGE_RE.test(command);
  const isPush = GIT_PUSH_RE.test(command);
  if (!isGh && !isMerge && !isPush) return;

  const branch = tryGit(['branch', '--show-current']);
  if (branch === null) return; // Not a git repo etc.: fail open.

  // --abort/--continue/--quit/--skip are conflict recovery, not merges.
  const mergeGated =
    isMerge && isMainBranch(branch) && !MERGE_CONTROL_RE.test(command);
  const gated =
    isGh || mergeGated || (isPush && pushTargetsMain(command, branch));
  if (!gated) return;

  const tip = resolveSourceTip(command, branch, isPush, mergeGated);
  if (!tip) {
    return block(
      'Cannot verify the merge source. Run the merge from the feature branch, or re-run /quality-check.'
    );
  }

  // Harness-only exemption: a non-empty diff made up entirely of harness
  // files needs no quality check at all.
  const base = mergeBaseRef();
  if (base) {
    const files = diffFiles(`${base}...${tip}`);
    if (files !== null && matchesHarnessPatterns(files)) {
      if (gateConfigFiles(files).length === 0) return;
      // The gate-parameter carve-out compares two revs, so use the same
      // merge-base the `...` diff is taken against. Resolved only now: it is
      // an extra process, and it is only needed once a gate-config file is
      // actually in an otherwise harness-only diff.
      const mergeBase = tryGit(['merge-base', base, tip]);
      if (mergeBase && gateParamsUnchanged(files, mergeBase, tip)) return;
    }
  }

  const flag = readFlag();
  if (!flag) {
    return block(
      'Quality check not passed. Run /quality-check before merging into main.'
    );
  }

  if (isPush && isMainBranch(branch) && !mergeGated) {
    // Pushing an already-merged main: the checked commit must be part of it.
    // Only valid when the push is the sole gated operation — when a merge is
    // chained in (`git merge feat && git push origin main`) the merge tip is
    // what lands on main and must be verified below instead.
    //
    // Ancestry alone only proves the check happened somewhere in history, not
    // that nothing landed after it, so the same post-flag diff rules as the
    // merge path apply — including the §2 gate-parameter carve-out.
    if (!gitOk(['merge-base', '--is-ancestor', flag.commit, 'HEAD'])) {
      // The checked commit is not in main's history at all: nothing about
      // this push was ever checked.
      return block(STALE_REASON);
    }
    const since = diffFiles(`${flag.commit}..HEAD`);
    if (
      since !== null &&
      (since.length === 0 || isHarnessOnly(since, flag.commit, 'HEAD'))
    ) {
      return;
    }
    return block(STALE_MAIN_REASON);
  }

  const changed = diffFiles(`${flag.commit}..${tip}`);
  if (changed === null) {
    return block(
      'Cannot verify changes since the last quality check. Re-run /quality-check.'
    );
  }
  if (changed.length === 0 || isHarnessOnly(changed, flag.commit, tip)) return;
  return block(STALE_REASON);
});
