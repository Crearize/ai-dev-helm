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
const GATE_PARAM_KEY_RE = new RegExp(
  `(?:${GATE_PARAM_KEYS.map((k) => k.replace(/_/g, '[-_ ]')).join('|')})`,
  'i'
);
// `### Quality Gate Overrides` at any heading level, any case/separator.
const QGO_HEADING_RE = /quality[-_\s]*gate[-_\s]*overrides/i;

// A markdown fence opener/closer. Checked before anything else on a line.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;

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
const treeCache = new Map();
const overrideStateCache = new Map();

function revExists(rev) {
  if (!revExistsCache.has(rev)) {
    revExistsCache.set(rev, tryGit(['cat-file', '-t', rev]) !== null);
  }
  return revExistsCache.get(rev);
}

// Every path in the tree at `rev`. NUL-delimited so paths containing quotes,
// spaces or non-ASCII bytes come back verbatim instead of git-quoted.
// Returns null when the listing itself fails.
function treeFiles(rev) {
  if (!treeCache.has(rev)) {
    const out = tryGit(['ls-tree', '-r', '--name-only', '-z', rev], 5000);
    treeCache.set(
      rev,
      out === null ? null : new Set(out.split('\0').filter(Boolean))
    );
  }
  return treeCache.get(rev);
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

// The part of `line` that is outside an HTML comment, carrying comment state
// across lines via `state.inComment`.
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
      const close = masked.indexOf('-->', i);
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

// What a harness config file *declares* about gate parameters, as an ordered
// list of `[context, line]` entries — the contract of quality-policy.md §2
// 「上書きの契約」 is about the declaration a reader sees, not about the raw
// bytes of any single line. Hence:
//
//  - Fence state is resolved BEFORE comment state. §2 itself shows the
//    override block inside a fenced example, so fenced content is
//    illustrative and inert; and because it is inert, a `<!--` inside a fence
//    is literal text that must not open a comment. Doing comments first let a
//    fenced `<!--` pair with a later real `-->` and swallow a live block.
//  - Entries are context-tagged ("block" inside a `### Quality Gate Overrides`
//    section, "outside" elsewhere). The same line means different things in
//    the two places, so moving an otherwise unchanged line into the overrides
//    section is a change of what the file declares.
//  - A key line ending in `:` absorbs the next live line as its value, since
//    markdown renders `key:` / newline / `value` as one declaration.
//  - Entries stay in document order rather than being sorted: with a
//    duplicated key the later declaration wins, so swapping two duplicate
//    lines changes the effective threshold. The cost is that reordering
//    distinct keys also reads as a change — that direction is fail-closed and
//    only ever asks for a quality check that was already cheap to run.
//
// Deliberately over-inclusive: any live line that so much as mentions a key
// counts. Prose that discusses a key without declaring it belongs inside an
// HTML comment.
function extractOverrideEntries(src) {
  const entries = [];
  const commentState = { inComment: false };
  let fenceChar = null;
  let inOverridesBlock = false;
  let pending = -1;

  for (const raw of src.split(/\r?\n/)) {
    const fence = raw.match(FENCE_RE);
    if (fence) {
      const ch = fence[1][0];
      if (fenceChar === null) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue; // Inert: illustrative, not declarative.

    const live = liveText(raw, commentState);

    const heading = live.match(HEADING_RE);
    if (heading) {
      pending = -1; // A heading terminates a pending `key:` value.
      inOverridesBlock = QGO_HEADING_RE.test(heading[1].replace(/[`*_]/g, ''));
      continue;
    }

    const norm = normalizeLine(live);
    if (norm === '') continue;
    if (pending >= 0) {
      entries[pending][1] += ' ' + norm;
      pending = -1;
    }
    if (GATE_PARAM_KEY_RE.test(norm)) {
      entries.push([inOverridesBlock ? 'block' : 'outside', norm]);
      if (norm.endsWith(':')) pending = entries.length - 1;
    }
  }
  return entries;
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
    const tree = treeFiles(rev);
    if (tree === null) return null; // Cannot prove either way.
    if (tree.has(file)) return null; // Present but unreadable.
    src = '';
  } else {
    if (buf.length > MAX_BLOB_BYTES) return null;
    src = decodeBlob(buf);
    if (src === null) return null;
  }
  return JSON.stringify(extractOverrideEntries(src));
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
    if (gitOk(['merge-base', '--is-ancestor', flag.commit, 'HEAD'])) {
      const since = diffFiles(`${flag.commit}..HEAD`);
      if (
        since !== null &&
        (since.length === 0 || isHarnessOnly(since, flag.commit, 'HEAD'))
      ) {
        return;
      }
    }
    return block(STALE_REASON);
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
