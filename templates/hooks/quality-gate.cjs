#!/usr/bin/env node
'use strict';

// PreToolUse hook: forbid direct push / merge into main (or master) unless a
// quality check passed. That single sentence is the whole requirement.
//
// The hook does NOT resolve what would land on main: no source-tip
// resolution, no PR-head lookup, no override-declaration parsing, no
// other-repository resolution. It statically classifies the command line and
// asks for the flag. Trunk names are fixed to `main` / `master`; a product
// using another trunk name is not gated here and relies on the
// `permissions.deny` layer and convention.
//
// Evaluation order (fixed):
//   1. Detect rule-1 candidates from the command line alone. No git is run at
//      this stage. No candidate -> allow immediately.
//   2. With a candidate, evaluate the ctx-independent part of rule 2 (items
//      1-5). A hit blocks ahead of everything else - exemptions never
//      override it.
//   3. Resolve ctx (current branch, flag, diffs). A resolution failure blocks
//      (rule 5). If ctx proves the candidates are not gated (e.g. `git merge`
//      on a feature branch) -> allow. Then evaluate rule 2 item 6
//      (`<x>:main`), still ahead of rules 3 and 4.
//   4. Rule 4 exemption -> allow; rule 3 pass conditions -> allow; else block.
//
// Rule 1 (gated candidates): `gh pr merge` (any args); `gh api` with a
//   `pulls/<n>/merge` word; `git merge` / `git pull` / `git rebase` (any args,
//   except --abort/--continue/--quit/--skip) - gated only once ctx says the
//   current branch is main/master; `git push` whose refspec DESTINATION is
//   exactly `main`/`master` (after stripping `+` and `refs/heads/`, case
//   insensitive; `--delete <ref>` counts as a destination), or a push with no
//   refspec at all (gated only on main/master). Substring matches never
//   count: `feature/main-nav` and `main:feature-x` are not candidates. A
//   refspec carrying a shell expansion is a candidate because its
//   destination cannot be read.
// Rule 2 (blocked with no exemption): force/delete/`+refspec`/`--mirror`/
//   `--all` pushes; another git command on the same line (checkout, switch,
//   commit, reset, rebase, fetch, branch -f, update-ref, cherry-pick, stash
//   pop) other than the gated call itself; `-C`/`--git-dir`/`--work-tree`/
//   `--namespace`/`-c`/`--config-env`, a `GIT_*=` assignment or a `cd`/`pushd`
//   on the line; shell expansion (`$`, backtick, `{`, `%`, `$'`) in a word, or
//   a gate word right after a redirection; more than one gated operation on
//   the line; a `<x>:main` refspec whose `<x>` is neither HEAD nor the current
//   branch.
// Rule 3 (pass): `.quality-check-passed` at the repo root with `commit` ==
//   HEAD (`branch` is diagnostic only), or `commit` an ancestor of HEAD whose
//   `commit..HEAD` diff is harness files only. Plus the closed set of three
//   sync forms on main: `git pull`, `git pull origin main`,
//   `git merge origin/main` - exact word sequences, nothing else.
// Rule 4 (exemption): a non-empty `origin/main...HEAD` diff made up entirely
//   of harness files. Gate control-plane paths and `Quality Gate Overrides` /
//   `mutation_budget_minutes` string changes are carved out of both rule 3
//   and rule 4 (no validity analysis of the declaration - over-detection is
//   fine).
// Rule 5 (fail-open, exactly twice): a malformed payload, and a cwd that is
//   not a git repository. Any other git failure or timeout on a line with a
//   candidate blocks. Reasons go to stderr.
// Rule 6 (output): `{"decision":"block","reason":...}` only; allow is silent.
//
// Deliberate over-detection, all in the fail-closed direction: rule 2 items
// 1-5 are evaluated before the branch is known, so they also block on a
// feature branch; a detached HEAD is an UNRESOLVED branch, so a line with a
// candidate blocks there; and `git push --force` with no refspec blocks
// anywhere, because "no refspec" is a candidate.
//
// This is a static check for a cooperating agent, not a sandbox:
// `sh -c "git push origin main"`, a git alias or a wrapper script defeats any
// inspection of a command line. Every git call here goes through execFileSync
// with an argv array - no shell is ever involved.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FLAG_FILE = '.quality-check-passed';
const MAX_BUFFER = 32 * 1024 * 1024;
// Global deadline: Claude Code kills the hook at its configured timeout, and a
// hook killed before it prints is read as "allowed". Every git call clamps to
// what is left, so a pathological repo degrades into a block, not a bypass.
const DEADLINE = Date.now() + 20000;

// --------------------------------------------------------------------------
// Tokenization: shell-style words, per line.
// --------------------------------------------------------------------------
// Newlines separate LINES (rules are evaluated per line); `;&|()` and
// backticks separate segments inside a line; `<`/`>` also separate, and mark
// the following segment as a redirection target. `{`/`}` and `%` stay inside
// the word on purpose - they are expansion markers, and splitting on them hid
// `git push origin ma{i,in}n` from the destination comparison entirely.
const SEGMENT_SEPARATORS = ';&|()';

// Split into lines of segments of words. Quotes are removed (so `origin
// "main"` compares as `main`); no expansion is performed, but every word
// records whether its source carried an expansion character.
function tokenizeLines(command) {
  const lines = [];
  let line = { segments: [], backtick: false };
  let seg = { words: [], expand: [], redirected: false };
  let word = '';
  let expand = false;
  let quote = null;

  const endWord = () => {
    if (word !== '') {
      seg.words.push(word);
      seg.expand.push(expand);
    }
    word = '';
    expand = false;
  };
  const endSegment = (redirected) => {
    endWord();
    if (seg.words.length > 0) line.segments.push(seg);
    seg = { words: [], expand: [], redirected };
  };
  const endLine = () => {
    endSegment(false);
    if (line.segments.length > 0) lines.push(line);
    line = { segments: [], backtick: false };
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
      } else {
        if (ch === '$' || ch === '`') expand = true;
        word += ch;
      }
    } else if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      expand = true; // $'...' / $"..." — ANSI-C / locale quoting.
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      if (command[i + 1] !== undefined && command[i + 1] !== '\n') {
        word += command[i + 1];
      }
      i++;
    } else if (ch === '\n') {
      endLine();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (ch === '`') {
      line.backtick = true;
      endSegment(false);
    } else if (ch === '<' || ch === '>') {
      endSegment(true);
    } else if (SEGMENT_SEPARATORS.includes(ch)) {
      endSegment(false);
    } else {
      if (ch === '$' || ch === '{' || ch === '}' || ch === '%') expand = true;
      word += ch;
    }
  }
  endLine();
  return lines;
}

// A word invokes `name` if its basename (either slash direction) is `name` or
// `name.exe`, case-insensitively: `git`, `GIT`, `C:\...\git.exe`.
function isCmdWord(word, name) {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase();
  return base === name || base === `${name}.exe`;
}

// git global options that consume the following word.
const GIT_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--exec-path', '--super-prefix', '--config-env', '--attr-source',
]);
// git global options that make the hook's own cwd meaningless (rule 2).
const GIT_LOCATION_OPTS = [
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
];
// push options that consume the following word.
const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
// Never exempt, on any branch, once a push candidate exists.
const PUSH_HARD_FLAGS = new Set([
  '--force', '-f', '--force-with-lease', '--delete', '-d', '--mirror', '--all', '--branches',
]);
// gh options whose values are free text, not refs (rule 2 carve-out).
const GH_TEXT_OPTS = new Set(['-t', '--subject', '-b', '--body', '-F', '--body-file']);
const GH_VALUE_OPTS = new Set(['-R', '--repo', ...GH_TEXT_OPTS]);

const MERGE_CONTROL_FLAGS = new Set(['--abort', '--continue', '--quit', '--skip']);
const SYNC_SUBS = new Set(['merge', 'pull', 'rebase']);
const GATE_WORDS = new Set(['merge', 'pull', 'push', 'rebase', 'pr']);
const PULLS_MERGE_RE = /(^|\/)pulls\/\d+\/merge(\/|$)/;
const GIT_ENV_RE = /^GIT_[A-Za-z0-9_]*=/;

function isMainBranch(name) {
  return name === 'main' || name === 'master';
}
function isMainRef(ref) {
  return isMainBranch(
    ref.replace(/^\+/, '').replace(/^refs\/heads\//i, '').replace(/^heads\//i, '').toLowerCase()
  );
}
function splitSpec(spec) {
  const s = spec.replace(/^\+/, '');
  const i = s.indexOf(':');
  return i === -1 ? { src: null, dst: s } : { src: s.slice(0, i), dst: s.slice(i + 1) };
}

// Every `git <sub>` in one segment, with the global options that preceded the
// subcommand. `git -c push.default=simple push` is a push; `git stash push`
// is not (the subcommand word is matched whole).
function gitInvocations(seg) {
  const found = [];
  for (let i = 0; i < seg.words.length; i++) {
    if (!isCmdWord(seg.words[i], 'git')) continue;
    const globals = [];
    let j = i + 1;
    while (j < seg.words.length && seg.words[j].startsWith('-')) {
      globals.push(seg.words[j]);
      j += GIT_VALUE_OPTS.has(seg.words[j]) ? 2 : 1;
    }
    if (j >= seg.words.length) continue;
    found.push({
      sub: seg.words[j].toLowerCase(),
      args: seg.words.slice(j + 1),
      argExpand: seg.expand.slice(j + 1),
      globals,
      gated: false,
    });
  }
  return found;
}

// Indices of gh free-text option values, which rule 2 does not inspect.
function freeTextIndices(words) {
  const skip = new Set();
  for (let i = 0; i < words.length; i++) {
    if (GH_TEXT_OPTS.has(words[i])) skip.add(i + 1);
    else if (/^(--subject|--body|--body-file)=/.test(words[i])) skip.add(i);
  }
  return skip;
}

// `gh pr merge` / `gh api .../pulls/<n>/merge` in one segment.
function ghCandidates(seg) {
  const found = [];
  for (let i = 0; i < seg.words.length; i++) {
    if (!isCmdWord(seg.words[i], 'gh')) continue;
    let j = i + 1;
    while (j < seg.words.length && seg.words[j].startsWith('-')) {
      j += GH_VALUE_OPTS.has(seg.words[j]) ? 2 : 1;
    }
    const sub = (seg.words[j] || '').toLowerCase();
    if (sub === 'api') {
      if (seg.words.slice(j + 1).some((w) => PULLS_MERGE_RE.test(w))) {
        found.push({ kind: 'gh', mainOnly: false });
      }
      continue;
    }
    if (sub !== 'pr') continue;
    let k = j + 1;
    while (k < seg.words.length && seg.words[k].startsWith('-')) {
      k += GH_VALUE_OPTS.has(seg.words[k]) ? 2 : 1;
    }
    if ((seg.words[k] || '').toLowerCase() === 'merge') found.push({ kind: 'gh', mainOnly: false });
  }
  return found;
}

// Refspecs of one push invocation, plus its flags. The first positional is
// the remote unless --repo already named it (`git push --repo=origin main`
// used to misread `main` as the remote and fail open).
function pushParts(inv) {
  const positionals = [];
  const flags = [];
  let repoOpt = false;
  for (let i = 0; i < inv.args.length; i++) {
    const a = inv.args[i];
    if (a.startsWith('-')) {
      flags.push(a);
      if (a === '--repo' || a.startsWith('--repo=')) repoOpt = true;
      if (PUSH_VALUE_OPTS.has(a)) i++;
      continue;
    }
    positionals.push({ text: a, expand: inv.argExpand[i] });
  }
  return { refspecs: repoOpt ? positionals : positionals.slice(1), flags };
}

// Rule 1 candidate detection plus the raw material rule 2 needs, for one line.
function analyzeLine(line) {
  const cands = [];
  const invocations = [];
  let redirectedGateWord = false;
  let expansion = line.backtick;
  let relocation = false;

  for (const seg of line.segments) {
    if (seg.redirected && seg.words.some((w) => GATE_WORDS.has(w.toLowerCase()))) {
      redirectedGateWord = true;
    }
    const freeText = freeTextIndices(seg.words);
    seg.words.forEach((w, i) => {
      const lw = w.toLowerCase();
      if (lw === 'cd' || lw === 'pushd') relocation = true;
      if (GIT_ENV_RE.test(w)) relocation = true;
      if (seg.expand[i] && !freeText.has(i)) expansion = true;
    });
    for (const c of ghCandidates(seg)) cands.push(c);
    for (const inv of gitInvocations(seg)) {
      invocations.push(inv);
      if (SYNC_SUBS.has(inv.sub)) {
        if (inv.args.some((a) => MERGE_CONTROL_FLAGS.has(a))) continue;
        inv.gated = true;
        cands.push({ kind: 'git', sub: inv.sub, mainOnly: true, inv });
      } else if (inv.sub === 'push') {
        const { refspecs, flags } = pushParts(inv);
        const mainSpecs = [];
        let candidate = refspecs.length === 0;
        const implicit = candidate;
        let plusRefspec = false;
        for (const r of refspecs) {
          const { src, dst } = splitSpec(r.text);
          if (r.text.startsWith('+')) plusRefspec = true;
          if (isMainRef(dst)) {
            candidate = true;
            mainSpecs.push({ src, dst });
            if (src === '') plusRefspec = true; // `:main` is the delete form.
          } else if (r.expand) {
            candidate = true; // Unreadable destination: assume the worst.
          }
        }
        if (!candidate) continue;
        inv.gated = true;
        cands.push({ kind: 'push', mainOnly: implicit, inv, flags, mainSpecs, plusRefspec });
      }
    }
  }

  if (cands.length > 0) {
    for (const inv of invocations) {
      if (inv.gated && inv.globals.some((g) => GIT_LOCATION_OPTS.some((o) => g === o || g.startsWith(`${o}=`)))) {
        relocation = true;
      }
    }
  }
  return { cands, invocations, redirectedGateWord, expansion, relocation };
}

// git subcommands that move the working tree or history. On the same line as
// a gated operation they must be split out ("run them as separate commands").
// The gated call itself never counts: `git pull --rebase` is not a rebase
// mover, and `git rebase origin/main` does not match itself.
function moverOf(invocations) {
  for (const inv of invocations) {
    if (inv.gated) continue;
    const s = inv.sub;
    if (['checkout', 'switch', 'commit', 'reset', 'update-ref', 'cherry-pick', 'rebase', 'fetch'].includes(s)) {
      return s;
    }
    if (s === 'branch' && inv.args.some((a) => ['-f', '-D', '-d', '--force'].includes(a))) return 'branch';
    if (s === 'stash' && ['pop', 'apply'].includes(inv.args[0])) return `stash ${inv.args[0]}`;
  }
  return null;
}

// --------------------------------------------------------------------------
// Path sets
// --------------------------------------------------------------------------

// Harness config files that may carry a `### Quality Gate Overrides` block.
const GATE_CONFIG_PATTERNS = [/(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /^\.cursorrules$/];

// The gate's own control plane: the quality-check skill and its schemas, the
// review persona docs, the hooks and their registration. A diff touching any
// of them is never exempt - an unreviewed edit here disables the gate as
// effectively as weakening a threshold. Case-INSENSITIVE: on Windows/macOS
// `.claude/Hooks/quality-gate.cjs` is the same real file, and a case variant
// used to ride the (case-sensitive) harness exemption. The `(\/|$)` on the
// directory nodes matches the node itself, so re-pointing the `.claude/skills`
// symlink is caught too.
const GATE_CONTROL_PATTERNS = [
  /(^|\/)skills\/project\/quality-check\//i,
  /(^|\/)skills\/project\/test-recommendation\//i,
  /(^|\/)skills\/project\/_schemas\//i,
  /^\.github\/review-[^/]*\.md$/i,
  /^\.(claude|codex|cursor)\/(hooks|skills)(\/|$)/i,
  // Registration is control plane too: unregistering the hook disables the
  // gate. Over-gating registration is safe, so the whole file is gated.
  /^\.(claude|codex|cursor)\/hooks\.json$/i,
  /^\.claude\/settings(\.local)?\.json$/i,
  /^\.codex\/config\.toml$/i,
  /^\.(claude|codex|cursor)\/mcp\.json$/i,
];

// Diffs made up entirely of these skip the gate (rule 4).
const HARNESS_PATTERNS = [
  ...GATE_CONFIG_PATTERNS,
  /^\.claude\//,
  /^\.codex\//,
  /^\.cursor\//,
  /^skills\/(project|superpowers)\//,
  /^\.github\/review-[^/]*\.md$/,
  /^documents\/development\/coding-rules\//,
];

// Gate-parameter carve-out (quality-policy §2). Only the STRINGS are looked
// for, in added/removed diff lines: whether a declaration is live or
// commented out is not analysed - over-detection is fine here.
const OVERRIDE_STRINGS = [/quality[-_\s]*gate[-_\s]*overrides/i, /mutation[-_\s]*budget[-_\s]*minutes/i];

const isHarness = (f) => HARNESS_PATTERNS.some((re) => re.test(f));
const controlHits = (files) => files.filter((f) => GATE_CONTROL_PATTERNS.some((re) => re.test(f)));
const gateConfigFiles = (files) => files.filter((f) => GATE_CONFIG_PATTERNS.some((re) => re.test(f)));

// --------------------------------------------------------------------------
// Decisions
// --------------------------------------------------------------------------

const allow = () => ({ decision: 'allow' });
const deny = (rule, reason) => ({ decision: 'block', rule, reason });

const MAX_LISTED_FILES = 20;
function controlReason(files) {
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  const more = files.length > MAX_LISTED_FILES ? ` (+${files.length - MAX_LISTED_FILES} more)` : '';
  return `Gate control-plane changed: ${shown}${more}. Run the quality-check skill before merging into main.`;
}

const NEED_FLAG = 'Quality check not passed. Run the quality-check skill before merging into main.';
const STALE = 'Code changed after the last quality check. Re-run the quality-check skill before merging into main.';

// Rule 3's closed set of sync forms on main. Exact word sequences only: a
// global option, an extra flag or a different remote is an ordinary gated
// operation and needs a flag.
const SYNC_FORMS = [['pull'], ['pull', 'origin', 'main'], ['merge', 'origin/main']];
function isSyncForm(line) {
  if (line.segments.length !== 1) return false;
  const w = line.segments[0].words;
  if (w.length < 2 || !isCmdWord(w[0], 'git')) return false;
  const rest = [w[1].toLowerCase(), ...w.slice(2)];
  return SYNC_FORMS.some((f) => f.length === rest.length && f.every((x, i) => x === rest[i]));
}

// Rule 2, items 1-5: no ctx is touched, so these also block on a feature
// branch (deliberate over-detection, see the header).
function staticRules(a) {
  if (a.redirectedGateWord) {
    return deny('2', 'Write the git/gh command plainly: a gated word after a redirection is not allowed.');
  }
  if (a.cands.length === 0) return null;
  for (const c of a.cands) {
    if (c.kind !== 'push') continue;
    if (c.plusRefspec || c.flags.some((f) => PUSH_HARD_FLAGS.has(f) || f.startsWith('--force-with-lease='))) {
      return deny('2', 'Force, delete, --all and --mirror pushes are never allowed here. Push a plain refspec after a quality check.');
    }
  }
  const mover = moverOf(a.invocations);
  if (mover) {
    return deny('2', `Split this into separate commands: git ${mover} and a gated push/merge on one line are not allowed.`);
  }
  if (a.relocation) {
    return deny('2', 'Run git from the target repository directory as a separate command (no -C/--git-dir/cd on the same line).');
  }
  if (a.expansion) {
    return deny('2', 'Write refs without shell expansion (no $, backtick, brace or %VAR% words).');
  }
  if (a.cands.length > 1) {
    return deny('2', 'Run one gated operation per command: split the merge, pull and push apart.');
  }
  return null;
}

// Everything that needs ctx. Returns a decision, or null to keep looking.
function contextRules(a, ctx) {
  const branch = ctx.branch;
  if (branch === null || branch === undefined || branch === '') {
    // Includes a detached HEAD: an unresolved branch with a candidate blocks.
    return deny('5', 'Cannot verify the current branch. Check out a branch, then re-run the command.');
  }
  const gated = a.cands.filter((c) => !c.mainOnly || isMainBranch(branch));
  if (gated.length === 0) return allow();

  // Rule 2 item 6 — ahead of every exemption.
  for (const c of gated) {
    for (const spec of c.mainSpecs || []) {
      if (spec.src === null) continue;
      if (spec.src === 'HEAD' || spec.src === branch) continue;
      return deny('2', `Push from the branch itself: ${spec.src}:${spec.dst} refspecs are not allowed.`);
    }
  }

  if (isMainBranch(branch) && isSyncForm(a.line)) return allow(); // Rule 3, sync form.

  // Rule 4: a non-empty harness-only diff against origin/main.
  const base = ctx.diffSinceBase;
  if (base === null) {
    return deny('5', 'Cannot verify what changed since origin/main. Re-run the quality-check skill.');
  }
  if (base.files.length > 0 && base.files.every(isHarness) && !base.overrideChanged
      && controlHits(base.files).length === 0) {
    return allow();
  }

  // Rule 3: the flag.
  const flag = ctx.flag;
  if (!flag) {
    const hits = controlHits(base.files);
    return deny('3', hits.length > 0 ? controlReason(hits) : NEED_FLAG);
  }
  const head = ctx.head;
  if (head === null || head === undefined) {
    return deny('5', 'Cannot verify HEAD. Re-run the quality-check skill.');
  }
  if (head === flag.commit || head.startsWith(flag.commit.toLowerCase())) return allow();

  const ancestor = ctx.isAncestor;
  if (ancestor === null) {
    return deny('5', 'Cannot verify the commit the quality check ran on. Re-run the quality-check skill.');
  }
  if (!ancestor) return deny('3', STALE);

  const since = ctx.diffSinceFlag;
  if (since === null) {
    return deny('5', 'Cannot verify what changed since the last quality check. Re-run the quality-check skill.');
  }
  if (since.files.length === 0) return allow();
  const hits = controlHits(since.files);
  if (hits.length > 0) return deny('3', controlReason(hits));
  if (since.files.every(isHarness) && !since.overrideChanged) return allow();
  return deny('3', STALE);
}

// Pure classifier. `ctx` is read through lazy getters; nothing on it is
// mutated, and a command with no rule-1 candidate never touches it.
function classify(command, ctx) {
  const analyzed = tokenizeLines(String(command || '')).map((line) => {
    const a = analyzeLine(line);
    a.line = line;
    return a;
  });
  for (const a of analyzed) {
    const verdict = staticRules(a);
    if (verdict) return verdict;
  }
  for (const a of analyzed) {
    if (a.cands.length === 0) continue;
    const verdict = contextRules(a, ctx);
    if (verdict && verdict.decision === 'block') return verdict;
  }
  return allow();
}

// --------------------------------------------------------------------------
// ctx resolution (the only place git runs)
// --------------------------------------------------------------------------

function runGit(args, cwd) {
  const budget = DEADLINE - Date.now();
  if (budget <= 0) return { ok: false, out: '', err: 'deadline exceeded' };
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.min(5000, budget),
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: '', err: String((e && e.stderr) || (e && e.message) || ''), status: e && e.status };
  }
}

function makeCtx(cwd) {
  const state = { failure: null };
  const cache = new Map();
  const once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const fail = (kind) => {
    state.failure = state.failure || kind;
    return null;
  };

  const root = () => once('root', () => {
    const r = runGit(['rev-parse', '--show-toplevel'], cwd);
    if (r.ok && r.out.trim()) return r.out.trim();
    return fail(/not a git repository/i.test(r.err) ? 'not-a-repo' : 'git-error');
  });
  const git = (args) => {
    const top = root();
    if (top === null) return { ok: false, out: '', err: '' };
    return runGit(['-C', top, '-c', 'diff.relative=false', ...args], cwd);
  };
  const text = (args) => {
    const r = git(args);
    return r.ok ? r.out.trim() : fail('git-error');
  };
  // -z keeps paths verbatim (a path with quotes or non-ASCII bytes still
  // matches the pattern sets); --no-renames keeps BOTH sides of a rename in
  // the list, so renaming a control-plane file out of its directory cannot
  // hide it behind the destination path alone.
  const diff = (range) => {
    const r = git(['diff', '--name-only', '-z', '--no-renames', range]);
    if (!r.ok) return fail('git-error');
    const files = r.out.split('\0').filter((f) => f !== '');
    const configs = gateConfigFiles(files);
    let overrideChanged = false;
    if (configs.length > 0) {
      const d = git(['diff', '-U0', '--no-renames', range, '--', ...configs]);
      if (!d.ok) return fail('git-error');
      overrideChanged = d.out.split(/\r?\n/).some(
        (l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l) && OVERRIDE_STRINGS.some((re) => re.test(l))
      );
    }
    return { files, overrideChanged };
  };

  const flag = () => once('flag', () => {
    const top = root();
    if (top === null) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(top, FLAG_FILE), 'utf8'));
      if (parsed && typeof parsed.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(parsed.commit)) {
        return { commit: parsed.commit.toLowerCase() };
      }
    } catch {
      // Missing, empty or malformed: no flag. `branch` is never read.
    }
    return null;
  });

  return {
    state,
    get branch() {
      return once('branch', () => {
        const r = git(['branch', '--show-current']);
        if (!r.ok) return fail('git-error');
        return r.out.trim() || null; // Detached HEAD: unresolved.
      });
    },
    get head() {
      return once('head', () => text(['rev-parse', '--verify', '--quiet', 'HEAD']) || null);
    },
    get flag() {
      return flag();
    },
    get isAncestor() {
      return once('anc', () => {
        const f = flag();
        if (!f) return null;
        const r = git(['merge-base', '--is-ancestor', f.commit, 'HEAD']);
        if (r.ok) return true;
        if (r.status === 1) return false;
        return fail('git-error');
      });
    },
    get diffSinceFlag() {
      return once('dsf', () => {
        const f = flag();
        return f ? diff(`${f.commit}..HEAD`) : null;
      });
    },
    get diffSinceBase() {
      return once('dsb', () => {
        for (const ref of ['origin/main', 'origin/master']) {
          const r = git(['rev-parse', '--verify', '--quiet', ref]);
          if (r.ok && r.out.trim()) return diff(`${ref}...HEAD`);
        }
        return { files: [], overrideChanged: false }; // No base ref: no exemption.
      });
    },
  };
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

function emitBlock(reason) {
  // Both the current PreToolUse schema and the legacy top-level `decision`,
  // so the gate keeps blocking on old and new Claude Code alike.
  console.log(JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let command = '';
    let cwd = process.cwd();
    try {
      const payload = JSON.parse(input);
      command = (payload.tool_input && payload.tool_input.command) || '';
      if (typeof command !== 'string') throw new Error('command is not a string');
      if (typeof payload.cwd === 'string' && fs.existsSync(payload.cwd)) cwd = payload.cwd;
    } catch (e) {
      // Rule 5, fail-open #1: never block on a payload the hook cannot read.
      process.stderr.write(`quality-gate: unreadable hook payload (${e.message}); not gating.\n`);
      return;
    }
    const ctx = makeCtx(cwd);
    const verdict = classify(command, ctx);
    if (verdict.decision !== 'block') return;
    if (ctx.state.failure === 'not-a-repo') {
      // Rule 5, fail-open #2.
      process.stderr.write('quality-gate: not a git repository; not gating.\n');
      return;
    }
    emitBlock(verdict.reason);
  });
}

module.exports = { classify, tokenizeLines };

if (require.main === module) main();
