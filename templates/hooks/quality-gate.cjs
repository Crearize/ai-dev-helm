#!/usr/bin/env node
'use strict';

// PreToolUse hook: gate merges into main/master (and direct pushes to
// main/master) behind a passing quality check.
//
// The .quality-check-passed flag is JSON written by /quality-check:
//   { "branch": "<branch at check time>", "commit": "<HEAD sha at check time>" }
// `branch` is informational only — authorization uses `commit` alone.
// The flag is NOT consumed here. It stays valid while everything that changed
// after flag.commit is a harness file — except gate-parameter and gate
// control-plane changes, which no flag issued before them can have reviewed;
// /quality-check deletes and recreates it on each run.
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

// --------------------------------------------------------------------------
// Command detection: shell-style tokenization, not regexes.
// --------------------------------------------------------------------------
// The original detection probed the raw command line with regexes anchored on
// `^|[;&|(]`. Downstream gate reviews reproduced real fail-OPEN bypasses
// against that approach — each got through because the regex compared raw
// text where the shell compares words, or recognized too few command
// positions:
//   git push origin "main"          (quotes defeated the refspec comparison)
//   echo x <newline> git push ...   (newline separates commands; ^ did not)
//   `git push origin main`          (backtick substitution still runs)
//   { git push origin main; }       ({ was not a recognized position)
//   if true; then git push ...      (then/do/else prefix words)
//   VAR=1 git push ... / command git push ...
//   git -c u.n=x push / git --no-pager push   (only `-C <dir>` was allowed)
// Tokenizing the command like a POSIX shell closes the class rather than the
// instances: words are compared after quote removal, and ANY `git`/`gh` word
// in a segment is treated as a command — over-detection is fail-closed (the
// block just asks for a quality check), so command position is deliberately
// not enforced.
//
// This is still an advisory guard for a cooperating agent, not a sandbox:
// `sh -c "git push origin main"`, a git alias, or a wrapper script can
// always defeat static inspection of a command line.

// Segment separators: command boundaries and redirections. `<`/`>` end a
// word like the shell does; the redirection target then starts a harmless
// segment of its own.
const SEGMENT_SEPARATORS = ';&|()`\n{}<>';

// Split a shell command into segments of unquoted words. Single quotes are
// literal; double quotes honor backslash escapes; an unquoted backslash
// escapes the next character (backslash-newline is a line continuation).
// No expansion is performed: `$BRANCH` stays `$BRANCH` and simply resolves
// to nothing later, which is the pre-existing (documented) limit.
function tokenizeSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let quote = null;

  const endWord = () => {
    if (word !== '') words.push(word);
    word = '';
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && '"\\$`\n'.includes(command[i + 1] ?? '')) {
        if (command[i + 1] !== '\n') word += command[i + 1];
        i++;
      } else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      if (command[i + 1] !== undefined && command[i + 1] !== '\n') {
        word += command[i + 1];
      }
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (SEGMENT_SEPARATORS.includes(ch)) {
      endSegment();
    } else {
      word += ch;
    }
  }
  endSegment(); // An unterminated quote leaves its text as a final word.
  return segments;
}

// A word invokes `name` if its basename (either slash direction) is `name`
// or `name.exe`, case-insensitively — `git`, `GIT`, `/usr/bin/git`,
// `C:\Program Files\Git\bin\git.exe`.
function isCmdWord(word, name) {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase();
  return base === name || base === `${name}.exe`;
}

// git global options that consume the following word.
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--exec-path', '--super-prefix', '--config-env', '--attr-source',
]);

// Every `git <sub>` invocation across all segments, each as the argument
// words after the subcommand. Global options between `git` and the
// subcommand are skipped, so `git -c push.default=simple --no-pager push`
// is a push and `git stash push` is not.
function gitInvocations(segments, sub) {
  const found = [];
  for (const words of segments) {
    for (let i = 0; i < words.length; i++) {
      if (!isCmdWord(words[i], 'git')) continue;
      let j = i + 1;
      while (j < words.length && words[j].startsWith('-')) {
        j += GIT_VALUE_OPTS.has(words[j]) ? 2 : 1;
      }
      if (words[j] === sub) found.push(words.slice(j + 1));
    }
  }
  return found;
}

// gh global options that consume the following word.
const GH_VALUE_OPTS = new Set(['-R', '--repo']);

// Every `gh pr merge` invocation, each as the argument words after `merge`.
function ghPrMergeInvocations(segments) {
  const found = [];
  for (const words of segments) {
    for (let i = 0; i < words.length; i++) {
      if (!isCmdWord(words[i], 'gh')) continue;
      let j = i + 1;
      while (j < words.length && words[j].startsWith('-')) {
        j += GH_VALUE_OPTS.has(words[j]) ? 2 : 1;
      }
      if (words[j] !== 'pr') continue;
      let k = j + 1;
      while (k < words.length && words[k].startsWith('-')) {
        k += GH_VALUE_OPTS.has(words[k]) ? 2 : 1;
      }
      if (words[k] === 'merge') found.push(words.slice(k + 1));
    }
  }
  return found;
}

// --abort/--continue/--quit/--skip are conflict recovery, not merges.
const MERGE_CONTROL_FLAGS = new Set(['--abort', '--continue', '--quit', '--skip']);

// Harness config files that may carry a `### Quality Gate Overrides` block
// (quality-policy.md §2「上書きの契約」). Spread into HARNESS_PATTERNS below so
// the two lists cannot drift apart.
const GATE_CONFIG_PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /^\.cursorrules$/,
];

// Gate CONTROL-PLANE files: the things that define the gate itself. Per the
// 「Merge Gate」 carve-out in CLAUDE.md (quality policy §5.5, review
// consolidation), a diff touching any of them is never exempt, even though
// every one of them also matches HARNESS_PATTERNS. With in-development
// reviews consolidated into the merge gate, an unreviewed edit here is an
// unreviewed edit to the only remaining review: rewriting the quality-check
// skill, its report schemas, a review persona doc, or the hook itself
// disables the gate exactly as effectively as weakening a threshold does.
//
// Both spellings of the skill paths are covered: the canonical
// `skills/project/...` tree and the copies tools make under `.claude/`,
// `.codex/` and `.cursor/` when skills are copied rather than symlinked.
// Paths are repo-root-relative (gitPrefix pins `-C <toplevel>` and
// `diff.relative=false`), so the anchored patterns mean what they say.
//
// Hook REGISTRATION is control plane too — unregistering the hook disables
// the gate just as surely as editing it. `.codex/hooks.json` (and the
// equivalents) is registration in its entirety; the `.claude/settings*.json`
// files carry registration in a few keys, so they are handled separately by
// settingsRegistrationChanged() rather than listed here: other settings keys
// stay exempt.
//
// Every entry is case-INSENSITIVE. On a case-insensitive filesystem
// (Windows/macOS) `.claude/Hooks/quality-gate.cjs` is the SAME real file as
// the canonical spelling, yet HARNESS_PATTERNS `/^\.claude\//` matched it
// either way while a case-sensitive control pattern did not — so a case
// variant rode the harness exemption with zero review. HARNESS_PATTERNS stay
// case-sensitive on purpose: a case mismatch there merely drops the harness
// exemption, which is the fail-closed direction.
//
// The `hooks`/`skills` pattern matches the DIRECTORY NODE itself (`(\/|$)`),
// not just paths under it. `.claude/skills` is a symlink created by `init`;
// re-pointing that link node swaps the whole quality-check tree with a diff
// of the single path `.claude/skills` (no trailing slash). Matching the node
// subsumes the old trailing-slash hooks-dir pattern.
const GATE_CONTROL_PATTERNS = [
  /(^|\/)skills\/project\/quality-check\//i,
  /(^|\/)skills\/project\/_schemas\//i,
  /^\.github\/review-[^/]*\.md$/i,
  /^\.(claude|codex|cursor)\/(hooks|skills)(\/|$)/i,
  // The registration-file set is a deliberate fail-closed SUPERSET of the
  // normative `.codex/hooks.json`: `.claude/hooks.json` and `.cursor/hooks.json`
  // are gated too. Do not narrow it back — over-gating registration is safe.
  /^\.(claude|codex|cursor)\/hooks\.json$/i,
  // Registration is not only hooks.json. `.codex/config.toml` can carry an
  // inline `[hooks]` table, a `[features]` table able to disable hooks
  // wholesale, and `[[rules]]` deny decisions — the rule layer that backs
  // the gate's destructive-command guards. Parsing TOML here for a narrower
  // content-dependent answer would be new attack surface for no benefit, so
  // the whole file is gated (over-gating registration is safe, see above).
  /^\.codex\/config\.toml$/i,
  // MCP server definitions register command/args execution — the same class
  // of registration as hooks.json (a crafted server definition runs on tool
  // use). The root-level .mcp.json is outside the harness exemption already;
  // the per-tool copies are inside it, so they are pinned here.
  /^\.(claude|codex|cursor)\/mcp\.json$/i,
];

// The control-plane files whose control-plane-ness depends on their content:
// only their hooks REGISTRATION (the `hooks` block, the hook-disable
// kill-switches, and the `permissions.deny` rule layer — see
// registrationState) registers the gate. Claude Code reads both files, with
// settings.local.json at higher precedence. Matched case-insensitively for
// the same reason as GATE_CONTROL_PATTERNS above.
const SETTINGS_FILE_RE = /^\.claude\/settings(\.local)?\.json$/i;

function settingsFilesIn(files) {
  return files.filter((f) => SETTINGS_FILE_RE.test(f));
}

// Merges/pushes whose entire (non-empty) diff matches these paths skip the
// gate. Aligned with the self-improvement skill's reflection targets, minus
// user-facing docs (README/docs/documents stay under the reduced review).
// Exceptions: changes to gate parameters (GATE_PARAM_KEYS below) and changes
// to the gate control plane (GATE_CONTROL_PATTERNS above) never skip the
// gate.
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
// Same idea per line. A legitimate override declaration is one short list
// item, nowhere near this; a line this long is pathological input, and the
// document that carries it is 判定不能 (fail closed). Measured in UTF-16
// units, which is never more than the byte count of the same UTF-8 text.
const MAX_LINE_BYTES = 64 * 1024;

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

// Like tryGit but VERBATIM: no trim. For output where bytes are data
// (`diff --name-only -z` paths); trimming there clipped leading/trailing
// whitespace off the first and last path in the list.
function tryGitRaw(args, timeoutMs = 2000) {
  return runGit([...gitPrefix(), ...args], timeoutMs, 'utf8');
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

function positionalWords(args) {
  return args.filter((a) => a && !a.startsWith('-'));
}

// push options that consume the following word.
const PUSH_VALUE_OPTS = new Set([
  '--repo', '--receive-pack', '--exec', '-o', '--push-option',
]);

// Does one push invocation target main/master? `args` are the words after
// `push`, already unquoted, so `origin "main"` and `origin main` compare
// identically — the quoted spelling used to sail through as a refspec that
// literally contained the quote characters.
function pushArgsTargetMain(args, branch) {
  const positionals = [];
  let repoOpt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // --all/--mirror/--branches push every branch, main included; the
      // refspec loop below would never see it.
      if (a === '--all' || a === '--mirror' || a === '--branches') return true;
      if (a === '--repo' || a.startsWith('--repo=')) repoOpt = true;
      if (PUSH_VALUE_OPTS.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }
  // First positional is the remote — unless --repo already named it, in
  // which case every positional is a refspec (`git push --repo=origin main`
  // used to misread `main` as the remote and fail open).
  const refspecs = repoOpt ? positionals : positionals.slice(1);
  if (refspecs.length === 0) return isMainBranch(branch);
  return refspecs.some((spec) => {
    const dst = spec.includes(':') ? spec.split(':').pop() : spec;
    return isMainBranch(
      dst.replace(/^\+/, '').replace(/^refs\/heads\//, '').replace(/^heads\//, '')
    );
  });
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
//
// Linear in the length of the line. The obvious implementation — walk the
// line, and at each backtick rebuild the marker string and `indexOf` it —
// is quadratic in the number of backticks, and a single ordinary-looking
// line stuffed with them was enough to burn a minute of CPU. That mattered
// far more than it looks: DEADLINE only clamps child-process timeouts, so
// pure-JS work runs until the harness SIGTERMs the hook, and a PreToolUse
// hook killed before it prints anything is read as "allowed" — a CPU cost
// that turns into a fail-OPEN. Runs are indexed by length once, with a
// per-length cursor, so finding a closer is amortized O(1).
function maskCodeSpans(line) {
  if (line.indexOf('`') === -1) return line;

  const runs = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      runs.push({ start: i, len: n });
      i += n;
    } else {
      i++;
    }
  }

  // sufMax[k] = the longest backtick run at or after index k. It answers
  // "is there a run of at least n left?" in O(1), which is what the scan
  // used to re-derive from scratch at every character.
  const sufMax = new Array(runs.length + 1).fill(0);
  for (let k = runs.length - 1; k >= 0; k--) {
    sufMax[k] = Math.max(runs[k].len, sufMax[k + 1]);
  }

  // Interiors to blank out. Deliberately the SAME spans the character-by-
  // character scan produced, including its quirk of letting the tail of a
  // long run open a span that a shorter run closes: masking more is the
  // fail-closed direction here (a masked `<!--` cannot open a comment and
  // hide a live override block), so this stays bug-compatible on purpose.
  const masked = [];
  let k = 0; // Current run.
  let offset = 0; // How much of it a previous match already consumed.
  while (k < runs.length) {
    const runEnd = runs[k].start + runs[k].len;
    const n = Math.min(runs[k].len - offset, sufMax[k + 1]);
    if (n <= 0) {
      k++; // Nothing long enough remains: the rest of this run is literal.
      offset = 0;
      continue;
    }
    let j = k + 1; // First later run able to close n backticks.
    while (runs[j].len < n) j++;
    masked.push([runEnd, runs[j].start]);
    if (n < runs[j].len) {
      k = j; // The closer was longer: its tail is still in play.
      offset = n;
    } else {
      k = j + 1;
      offset = 0;
    }
  }

  if (masked.length === 0) return line;
  const parts = [];
  let pos = 0;
  for (const [start, end] of masked) {
    parts.push(line.slice(pos, start));
    parts.push('x'.repeat(end - start));
    pos = end;
  }
  parts.push(line.slice(pos));
  return parts.join('');
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
    // Two CPU guards, both fail-closed. DEADLINE bounds child processes only,
    // so nothing else stops this loop before the harness kills the hook — and
    // a hook killed before it prints is read as "allowed".
    if (raw.length > MAX_LINE_BYTES) return null;
    if (remainingBudget() <= 0) return null;

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

// Canonical form of an entry list, or null when the document does not
// determine an answer.
//
// quality-policy.md §2「上書きの契約」:「1つのファイル内に同一キーを複数回
// 記載してはならない（MUST NOT）。複数記載があり値が食い違う場合、値は不定
// として扱う」— so a key declared twice with differing lines is refused
// outright rather than resolved. Resolving it by last-wins looked reasonable
// but silently accepted a weakened duplicate INSERTED ABOVE the original: the
// unchanged line was still last, so the state never moved and the diff merged
// exempt. Identical repeats are not the 「値が食い違う」 case — they declare
// exactly one value — so they collapse to the same state as a single line.
//
// The remaining map is sorted, so the state does not depend on document
// order: reordering two DISTINCT keys declares the same thing and stays
// exempt.
function canonicalizeEntries(entries) {
  const declared = new Map();
  for (const e of entries) {
    const k = `${e.context}\0${e.keyId}`;
    if (declared.has(k) && declared.get(k) !== e.line) return null;
    declared.set(k, e.line);
  }
  return JSON.stringify(
    [...declared.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
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

// Control-plane files identifiable from the path alone (everything except
// the settings files, whose answer depends on content).
function gateControlPathFiles(files) {
  return files.filter((f) => GATE_CONTROL_PATTERNS.some((re) => re.test(f)));
}

const hooksBlockCache = new Map();

// The hook-registration state a settings object declares, as a canonical
// string. Not just the `hooks` block: the disableAllHooks /
// allowManagedHooksOnly kill-switches turn hooks off (or restrict them to
// managed ones) WITHOUT touching the hooks block, so flipping either one is a
// registration change just as much as editing the block is. `parsed` is a
// JSON.parse result (always serializable) or null for a genuinely absent file
// (which registers nothing — the same empty answer as `{}`).
function registrationState(parsed) {
  const permissions = parsed && parsed.permissions;
  return JSON.stringify({
    hooks: (parsed && parsed.hooks) ?? null,
    disableAllHooks: (parsed && parsed.disableAllHooks) ?? null,
    allowManagedHooksOnly: (parsed && parsed.allowManagedHooksOnly) ?? null,
    // permissions.deny is the rule layer backing the harness's guards (the
    // force-push and destructive-command deny rules ship in settings.json).
    // Deleting or weakening a deny rule is a protection change no flag
    // issued before it has reviewed — the codex counterpart (`[[rules]]` in
    // config.toml) is gated whole-file for the same reason. permissions.allow
    // stays exempt: an allow rule cannot override a deny rule or skip a hook.
    permissionsDeny: (permissions && permissions.deny) ?? null,
  });
}

// The hook registration a settings file declares at `rev`, as a canonical
// string, or null when it cannot be established. Mirrors overrideState(): a
// path genuinely absent from the tree legitimately declares no registration
// (the empty answer), while an unreadable or unparsable blob is 判定不能 and
// fails closed.
function hooksBlockAt(rev, file) {
  // Defense in depth, as in overrideState(): revs are git-resolved shas or
  // the literal HEAD, never tokens lifted from the command line.
  if (!/^[0-9a-f]{7,40}$/i.test(rev) && rev !== 'HEAD') return null;

  const key = `${rev}\0${file}`;
  if (hooksBlockCache.has(key)) return hooksBlockCache.get(key);

  const state = computeHooksBlock(rev, file);
  hooksBlockCache.set(key, state);
  return state;
}

function computeHooksBlock(rev, file) {
  const buf = tryGitBuf(['show', `${rev}:${file}`], 5000);
  if (buf === null) {
    // A failed read is not evidence of absence: prove absence from the tree.
    if (!revExists(rev)) return null;
    const present = pathPresentAt(rev, file);
    if (present === null) return null; // Cannot prove either way.
    if (present) return null; // Present but unreadable.
    return registrationState(null); // Genuinely absent: registers nothing.
  }
  if (buf.length > MAX_BLOB_BYTES) return null;
  const src = decodeBlob(buf);
  if (src === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch {
    return null; // Unparsable settings: 判定不能.
  }
  // A settings file that is not a JSON object declares nothing intelligible;
  // guessing at it is worse than a predictable fail-closed answer.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  try {
    return registrationState(parsed);
  } catch {
    return null; // Cyclic/unserializable — not reachable from JSON.parse.
  }
}

// Did the hook registration of one settings file move between the two revs?
// Fail closed on either side being indeterminate. One-sided presence is
// covered by the absent side's empty answer: adding the file with a hooks
// block, or deleting one that had it, both read as changed.
function settingsRegistrationChanged(baseRev, tipRev, file) {
  const before = hooksBlockAt(baseRev, file);
  const after = hooksBlockAt(tipRev, file);
  return before === null || after === null || before !== after;
}

// Every control-plane file this diff touches, for the block message. Each
// settings file's registration is compared separately, and the blob
// comparison is only paid for the settings files actually in the diff.
function gateControlFiles(files, baseRev, tipRev) {
  const hits = gateControlPathFiles(files);
  for (const f of settingsFilesIn(files)) {
    if (settingsRegistrationChanged(baseRev, tipRev, f)) hits.push(f);
  }
  return hits;
}

function isHarnessOnly(files, baseRev, tipRev) {
  return (
    matchesHarnessPatterns(files) && gateParamsUnchanged(files, baseRev, tipRev)
  );
}

function diffFiles(range) {
  // -z: paths come back verbatim rather than git-quoted, so a path with
  // quotes or non-ASCII bytes still matches HARNESS_PATTERNS correctly.
  //
  // NEVER trimmed — neither the output as a whole nor per entry. Git paths
  // are byte-exact, and trimming let a path with leading whitespace (a file
  // named ` .claude/evil.md`, space included — NOT a harness path) normalize
  // into a harness path and ride the exemption. Verbatim, the odd path just
  // fails the harness match, which is the fail-closed direction. Only the
  // empty string (the -z terminator) is dropped.
  const out = tryGitRaw(['diff', '--name-only', '-z', range], 5000);
  if (out === null) return null;
  return out.split('\0').filter((f) => f !== '');
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

// gh pr merge options that consume the following word — their values must
// not be mistaken for the PR-number/branch positional.
const GH_MERGE_VALUE_OPTS = new Set([
  '-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file',
  '-A', '--author-email', '--match-head-commit',
]);

function ghMergePositional(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (GH_MERGE_VALUE_OPTS.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

// Determine the commit whose content is about to land on main.
// Never derived from the flag (see spec A-3).
// The merge argument is the tip only when the merge itself is the gated
// operation (i.e. it runs on main). A non-gated merge on a feature branch
// (e.g. `git merge origin/main && git push origin main`) must not hijack
// tip resolution away from HEAD.
function resolveSourceTip({ branch, isPush, gatedMerges, ghMerges }) {
  if (gatedMerges.length > 0) {
    // Try each positional word until one resolves; skips -m message text
    // and other flag values that are not refs. Words go to git as argv
    // elements, so a crafted "ref" is only ever an unresolvable ref.
    for (const ref of positionalWords(gatedMerges[0])) {
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
  if (ghMerges.length > 0) {
    const prArg = ghMergePositional(ghMerges[0]);
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

// Reason strings name "the quality-check skill", not the `/quality-check`
// slash command: the hook runs under Claude Code, Codex, and Cursor alike,
// and the slash spelling is Claude Code-specific (downstream feedback).
const STALE_REASON =
  'Code changed after the last quality check. Re-run the quality-check skill before merging.';

// Distinct from the generic "Quality check not passed" so the control-plane
// carve-out is identifiable from the decision alone — by a reader deciding
// what to do next, and by the tests that pin this path.
const MAX_LISTED_FILES = 20;
function gateControlReason(files) {
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  const more =
    files.length > MAX_LISTED_FILES
      ? ` (+${files.length - MAX_LISTED_FILES} more)`
      : '';
  return (
    `Gate control-plane changed: ${shown}${more}. ` +
    'Gate control-plane changes (the quality-check skill and its schemas, ' +
    'review persona docs, the hooks and their registration) are never exempt ' +
    'from the quality check, harness paths or not — quality policy §5.5. ' +
    'Run the quality-check skill before merging.'
  );
}

// The push-to-main case: the content is already committed on main, so
// "before merging" is impossible advice. Name what actually happened instead.
const STALE_MAIN_REASON =
  'main contains changes that were not part of the last quality check (the ' +
  'merge brought in commits made after the flag). Re-run the quality-check ' +
  'skill on the current main, then push.';

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

  const segments = tokenizeSegments(command);
  const pushes = gitInvocations(segments, 'push');
  const merges = gitInvocations(segments, 'merge');
  const ghMerges = ghPrMergeInvocations(segments);
  if (pushes.length === 0 && merges.length === 0 && ghMerges.length === 0) {
    return;
  }

  const branch = tryGit(['branch', '--show-current']);
  if (branch === null) return; // Not a git repo etc.: fail open.

  const realMerges = merges.filter(
    (args) => !args.some((a) => MERGE_CONTROL_FLAGS.has(a))
  );
  const gatedMerges = isMainBranch(branch) ? realMerges : [];
  const mergeGated = gatedMerges.length > 0;
  const isPush = pushes.length > 0;
  const gated =
    ghMerges.length > 0 ||
    mergeGated ||
    pushes.some((args) => pushArgsTargetMain(args, branch));
  if (!gated) return;

  const tip = resolveSourceTip({ branch, isPush, gatedMerges, ghMerges });
  if (!tip) {
    return block(
      'Cannot verify the merge source. Run the merge from the feature branch, or re-run the quality-check skill.'
    );
  }

  // Harness-only exemption: a non-empty diff made up entirely of harness
  // files needs no quality check at all — unless it changes a gate parameter
  // or the gate control plane.
  let controlHits = null;
  const base = mergeBaseRef();
  if (base) {
    const files = diffFiles(`${base}...${tip}`);
    if (files !== null && matchesHarnessPatterns(files)) {
      const pathHits = gateControlPathFiles(files);
      if (pathHits.length > 0) {
        controlHits = pathHits;
      } else if (
        gateConfigFiles(files).length === 0 &&
        settingsFilesIn(files).length === 0
      ) {
        return; // Pure harness diff: nothing content-dependent to check.
      } else {
        // Both content-dependent carve-outs compare two revs, so use the same
        // merge-base the `...` diff is taken against. Resolved only now: it is
        // an extra process, and it is only needed once a gate-config file or
        // a settings file is actually in an otherwise harness-only diff.
        // An unresolvable merge-base is indeterminate, so it falls through to
        // the flag check rather than exempting.
        const mergeBase = tryGit(['merge-base', base, tip]);
        if (mergeBase) {
          const hits = gateControlFiles(files, mergeBase, tip);
          if (hits.length > 0) controlHits = hits;
          else if (gateParamsUnchanged(files, mergeBase, tip)) return;
        }
      }
    }
  }

  const flag = readFlag();
  if (!flag) {
    // The carve-out removes the EXEMPTION, not the flag: a control-plane
    // change that actually went through /quality-check still merges below.
    if (controlHits) return block(gateControlReason(controlHits));
    return block(
      'Quality check not passed. Run the quality-check skill before merging into main.'
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
    // merge path apply — including the §2 gate-parameter carve-out and the
    // §5.5 control-plane carve-out.
    if (!gitOk(['merge-base', '--is-ancestor', flag.commit, 'HEAD'])) {
      // The checked commit is not in main's history at all: nothing about
      // this push was ever checked.
      return block(STALE_REASON);
    }
    const since = diffFiles(`${flag.commit}..HEAD`);
    if (since !== null && (since.length === 0 || isHarnessOnly(since, flag.commit, 'HEAD'))) {
      const hits =
        since.length === 0 ? [] : gateControlFiles(since, flag.commit, 'HEAD');
      if (hits.length === 0) return;
      // A post-flag control-plane commit is unreviewed by definition: the
      // flag only covers content up to flag.commit. The harness-only
      // staleness exemption exists so self-improvement edits never force a
      // re-review; gate control-plane edits are exactly the class it must
      // not cover.
      return block(gateControlReason(hits));
    }
    return block(STALE_MAIN_REASON);
  }

  const changed = diffFiles(`${flag.commit}..${tip}`);
  if (changed === null) {
    return block(
      'Cannot verify changes since the last quality check. Re-run the quality-check skill.'
    );
  }
  if (changed.length === 0) return;
  if (isHarnessOnly(changed, flag.commit, tip)) {
    // Same rule as the push path above: the flag stays valid across harness
    // commits, except gate control-plane commits, which no flag issued
    // before them can have reviewed.
    const hits = gateControlFiles(changed, flag.commit, tip);
    if (hits.length === 0) return;
    return block(gateControlReason(hits));
  }
  return block(STALE_REASON);
});
