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
// THREAT MODEL: this gate stops ACCIDENTAL, good-faith operations from reaching
// main. Work always starts from an issue and a branch, and a push or merge that
// does get through is recoverable with a revert, so the gate is insurance and
// not a boundary. Deliberate evasion - spelling a word with shell expansion,
// quoting or encoding, going through a wrapper, running git indirectly - is OUT
// OF SCOPE by design: those forms are listed under "Nothing here can see
// through" below, and each is addressed individually if it ever does harm.
//
// Evaluation order (fixed):
//   0. Refuse what the classification budget will not read - a command line
//      over 64 KB, or one whose `git` / `gh` words number more than 256 -
//      before anything is analyzed (see "The classification budget" below).
//   1. Detect rule-1 candidates from the command line alone. No git is run at
//      this stage. No candidate -> allow immediately.
//   2. With a candidate, evaluate the ctx-independent part of rule 2 (items
//      1-5). A hit blocks ahead of everything else - exemptions never
//      override it.
//   3. Resolve ctx (current branch, flag, diffs). A resolution failure blocks
//      (rule 5). If ctx proves the candidates are not gated (e.g. `git merge`
//      on a feature branch) -> allow. Then evaluate rule 2 item 6
//      (`<x>:main`), still ahead of rules 3 and 4.
//   4. Rule 3's sync forms -> allow; the rule 4 exemption -> allow; rule 3's
//      flag conditions -> allow; else block. (The sync forms are checked first
//      because they need no diff at all.)
//
// Rule 1 (gated candidates): `gh pr merge` (any args); `gh api` with a
//   `pulls/<n>/merge` word, case insensitive (a `?query` or `#fragment` after
//   it still merges; `<n>` need not be digits - `pulls/$PR/merge` and
//   `pulls/$(gh pr view --json number -q .number)/merge` are candidates too,
//   because the tokenizer keeps a command substitution inside the word, and
//   the expansion character then blocks them under rule 2);
//   `git merge` / `git pull` / `git rebase` (any args,
//   except --abort/--continue/--quit/--skip) - gated only once ctx says the
//   current branch is main/master; `git push` whose refspec DESTINATION is
//   exactly `main`/`master` (after stripping `+` and `refs/heads/`, case
//   insensitive; `--delete <ref>` counts as a destination), or a push with no
//   refspec at all - or a bare `HEAD`/`@`, which is the same thing written out
//   - (gated only on main/master). Substring matches never
//   count: `feature/main-nav` and `main:feature-x` are not candidates. A
//   refspec carrying a shell expansion is a candidate because its
//   destination cannot be read.
// Rule 2 (blocked with no exemption): force/delete/`+refspec`/`--mirror`/
//   `--all`/`--branches` pushes; a git command from the mover set on the same
//   line (commit, reset, checkout, switch, cherry-pick, rebase, revert, am,
//   bisect, update-ref, stash pop|apply, fetch, branch -f|-d|-D|--force) other
//   than the gated call itself - that set is CLOSED, so every other git
//   operation (status, add, log, diff, tag, remote, restore, ...) may share the
//   line without blocking; `-C`/`--git-dir`/`--work-tree`/`--namespace`/`-c`/
//   `--config-env`, a `GIT_*=` assignment or a `cd`/`pushd` on the line; shell
//   expansion (`$`, backtick, `{`, `}`, `%`, `$'`) in a word, except the value
//   of gh's free-text options - `-t`/`--subject`, `-b`/`--body`,
//   `-F`/`--body-file` (six forms), plus their `--subject=`/`--body=`/
//   `--body-file=` spellings (three more, nine in all) - which is prose and
//   not a ref; more than one gated
//   operation on the line; a `<x>:main` refspec whose `<x>` is neither
//   HEAD/`@` nor the current branch.
//   The expansion item, like the rest of rule 2, only looks at a line that
//   ALREADY holds a candidate, so `echo $HOME`, `npm run $TASK`,
//   `NODE_ENV=$ENV npm test`, `gh api repos/{owner}/{repo}/issues`,
//   `$HOME/bin/tool --flag`, `git commit -m "$MSG"` and `git log --format=%H`
//   are allowed. An expansion in the word that NAMES the operation therefore
//   leaves nothing to find - that is deliberate evasion, and out of scope (see
//   the threat model above).
//   The movers that move HEAD or make a commit (commit, reset, checkout,
//   switch, cherry-pick, rebase, revert, am, bisect, update-ref,
//   stash pop|apply) are judged over the WHOLE command, newlines included;
//   `fetch` and `branch -f|-d|-D|--force` are judged per line.
// Rule 3 (pass): `.quality-check-passed` at the repo root with `commit` an
//   abbreviated prefix of (or equal to) HEAD (`branch` is diagnostic only), or
//   `commit` an ancestor of HEAD whose `commit..HEAD` diff is harness files
//   only. Plus the closed set of three sync forms on the CURRENT trunk:
//   `git pull`, `git pull origin <trunk>`, `git merge origin/<trunk>` - exact
//   word sequences, nothing else.
// Rule 4 (exemption): a non-empty `origin/main...HEAD` diff made up entirely
//   of harness files. Gate control-plane paths and `Quality Gate Overrides` /
//   `mutation_budget_minutes` string changes are carved out of both rule 3
//   and rule 4 (no validity analysis of the declaration - over-detection is
//   fine). The control plane is the quality-check / test-recommendation skills
//   and their schemas, the review persona docs, and - under `.claude`,
//   `.codex` or `.cursor` - `hooks/`, `skills/`, `agents/`, `commands/`,
//   `prompts/`, `rules/`, plus the hook's registration files (see
//   GATE_CONTROL_PATTERNS, which is the authority).
// Rule 5 (fail-open, exactly twice): a payload whose `tool_input.command` is
//   not a string (malformed JSON, a missing field), and a cwd that is not
//   inside a git work tree - decided by rev-parse's EXIT STATUS, never by its
//   (localized) message. Any other git failure or timeout on a line with a
//   candidate blocks. Both fail-opens write their reason to stderr, so a hook
//   that has stopped gating is visible rather than silent.
// Rule 6 (output): `{"decision":"block","reason":...}` only; allow is silent.
//
// The classification budget, and no part of it is a fail-open.
//   - A command line over 64 KB is not classified: it is judged on its gate
//     words alone (`merge`, `pull`, `push`, `rebase`, `pr`, `pulls/<n>/merge`),
//     looked for in the raw text AND in the text with `\`+newline folded away
//     and then `"`, `'` and `\` removed, because the shell reads `p""ush`,
//     `pu\sh` and `pu\<newline>sh` as `push`. Block when one is found; block as
//     well when the stripped text carries an expansion character (`$`,
//     backtick, `{`, `}` or `%` - the tokenizer's set), since `$'\x70'ush` and
//     `pus{h..h}` cannot be read statically; allow when there is neither. A
//     classifier exception is judged by the same function.
//   - A command whose `git` / `gh` WORDS number more than 256 is not classified
//     either: it blocks unconditionally. Words, not resolved calls - a `git` in
//     an argument position counts, and over-counting is fail-closed. This is
//     what bounds the quadratic term in the candidate scans, which are
//     O(git/gh words x words); no real command comes near the cap.
//   - A hook PAYLOAD over 1 MB is not parsed at all, so there is no command
//     line to judge: it blocks unconditionally, with its reason on stderr. The
//     payload cap and the command-line cap are different limits, and gate words
//     play no part in the payload one. Reading only a prefix of the payload
//     would be worse than any of these, because the gated call can sit behind
//     any amount of padding.
//
// Deliberate over-detection, all in the fail-closed direction: rule 2 items
// 1-5 are evaluated before the branch is known, so they also block on a
// feature branch; a detached HEAD is an UNRESOLVED branch, so a line with a
// candidate blocks there; and `git push --force` with no refspec blocks
// anywhere, because "no refspec" is a candidate.
//
// This is a static check for a cooperating agent, not a sandbox. It is aimed at
// the accidental operation (see the threat model above); nothing here can see
// through any of the following, and none of them is treated as a gap:
//   - a shell that re-reads the string: `sh -c "git push origin main"`, a git
//     alias, or a wrapper script;
//   - a command WORD the shell writes for you: `$GIT push origin main`,
//     `` `which git` push ``, `gi{t..t} push origin main`;
//   - a SUBCOMMAND word spelled by an expansion, which leaves no candidate to
//     find at all: `git pus{h..h} origin main`, `git $(echo push) origin main`,
//     `gh pr me{r..r}ge 1`, `gh a{p..p}i -X PUT .../merge`;
//   - a MOVER word spelled by an expansion, on a line of its own, which the
//     whole-command mover scan never matches in the first place: `git push
//     origin main` on one line and `git stash po{p..p}` on another - the
//     line split does not hide the mover, the expansion does;
//   - a gate word percent-encoded inside quotes, which a `gh api` endpoint
//     reads back: `gh api -X PUT "repos/o/r/pulls/1/%6Derge"`;
//   - arguments supplied by another process: `xargs git push`, `env -S`;
//   - a refspec that lives in configuration: `remote.<name>.push`,
//     `push.default = matching`, `branch.<n>.merge`;
//   - other merge APIs: `gh api graphql` with `mergePullRequest`, or
//     `git subtree push` into a trunk.
// `--exec-path` is deliberately NOT in GIT_LOCATION_OPTS: it changes which git
// binaries run, not which repository is written, and gating it would block the
// ordinary `git --exec-path` query.
// Every git call here goes through execFileSync with an argv array - no shell
// is ever involved.

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
// Newlines separate LINES (rules are evaluated per line); `;&|` and an
// unquoted `(`/`)` - a subshell - separate segments inside a line.
// A COMMAND SUBSTITUTION is not a separator: `$(` ... `)` (parenthesis nesting
// and quoting respected) and a backtick pair are read as part of the WORD they
// sit in, exactly as the shell reads them, and the word records an expansion.
// Whitespace, `;`, `&` and `|` INSIDE a substitution cut neither the word nor
// the segment. Splitting there used to break
// `gh api -X PUT repos/o/r/pulls/$(prnum)/merge` into `repos/o/r/pulls/$`,
// `prnum` and `/merge`, so no word held a `pulls/<n>/merge` endpoint, the line
// had no rule-1 candidate at all, and the call was allowed (M26). An
// unterminated `$(` or backtick swallows the rest of the LINE, which keeps
// the expansion flag on the word rather than losing it. Inside double quotes
// an unterminated one swallows the rest of the COMMAND instead - it reads
// across every newline in it, same as a terminated one does; bash rejects
// such unterminated input as a syntax error and runs nothing, so nothing is
// lost either way.
// The substitution BODY is tokenized as well - the same whether it is
// unquoted or sits inside double quotes (`"$(…)"`) - and its segments are
// appended to the same line, so a gated call written inside one - `` `git
// push origin main` ``, `echo $(git push origin main)`,
// `echo "$(git push origin main)"` - is still the candidate it always was. A
// double-quoted substitution is read across newlines, as the shell reads it;
// an unquoted one stops at the end of the line, where the next line is
// classified on its own anyway.
// Nesting is followed MAX_SUBST_DEPTH levels deep; below that the body is
// left unread, so a gated call inside it is not a candidate at all (the word
// still carries its expansion flag, which only matters if the line has a
// candidate elsewhere), which is deliberate evasion and out of scope (see the
// threat model).
// A redirection is NOT a separator either: the operator and the single word
// that follows it are removed from the argv and everything else stays in the
// same command, because that is what the shell does -
// `git push > /dev/null origin main` runs `git push origin main`. The target
// word is dropped from the argv, but a substitution body inside it still
// joins the line - `git push origin main > "$(git checkout x)"` blocks under
// rule 2.
// `{`/`}` and `%` stay inside the word on purpose - they are expansion
// markers, and splitting on them hid `git push origin ma{i,in}n` from the
// destination comparison entirely.
const SEGMENT_SEPARATORS = ';&|()';
const MAX_SUBST_DEPTH = 8;
// `>` `>>` `>|` `>&` `<` `<<` `<<-` `<&` `<>`, each optionally preceded by a
// file descriptor (`2>`) or `&` (`&>`), both handled at the call site. Sticky,
// so matching it costs the length of the operator and not the length of the
// rest of the command line.
const REDIRECT_OP_RE = /(?:>>|>&|>\||<<-?|<&|<>|>|<)/y;

// Scan the command substitution that starts at `start` - `$(`, or a backtick -
// and return `{ end, inner }`: the index of its LAST character and its body.
// Quotes and backslash escapes inside are honoured, so the `)` in
// `$(node -p 'require("./package.json").version')` does not close it early,
// and `$(` nesting is counted. Unquoted (`crossLines` false, the default), a
// substitution never crosses a newline: an unterminated one ends at the end
// of the line (or of the command), so the word keeps the text and its
// expansion flag instead of dropping them. Called with `crossLines` true -
// from a double-quoted substitution, where the shell keeps reading past the
// line break - it is read across newlines the same way, ending at the
// matching close or, unterminated, at the end of the command.
function scanSubstitution(command, start, crossLines = false) {
  const backtick = command[start] === '`';
  const bodyAt = start + (backtick ? 1 : 2);
  let depth = 1;
  let quote = null;
  for (let i = bodyAt; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\n' && !crossLines) return { end: i - 1, inner: command.slice(bodyAt, i) };
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\') i++;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (backtick) {
      if (ch === '`') return { end: i, inner: command.slice(bodyAt, i) };
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { end: i, inner: command.slice(bodyAt, i) };
  }
  return { end: command.length - 1, inner: command.slice(bodyAt) };
}

// Split into lines of segments of words. Quotes are removed (so `origin
// "main"` compares as `main`); no expansion is performed, but every word
// records whether its source carried an expansion character. `depth` is the
// command-substitution nesting level and is set only by this function.
function tokenizeLines(command, depth = 0) {
  const lines = [];
  let line = { segments: [] };
  let bodies = []; // Substitution bodies seen on this line, tokenized at its end.
  let seg = { words: [], expand: [] };
  let word = '';
  let expand = false;
  let quote = null;
  let dropWord = false; // A pending redirection target, dropped from the argv.
  // Whether a word has STARTED at this position, which is not the same as
  // having characters in it: `""` and `''` start a word without adding any, and
  // bash reads `""#` as the one-character word `#`, not as a comment.
  let started = false;

  const endWord = () => {
    if (word !== '') {
      if (dropWord) dropWord = false;
      else {
        seg.words.push(word);
        seg.expand.push(expand);
      }
    }
    word = '';
    expand = false;
    started = false;
  };
  const endSegment = () => {
    endWord();
    dropWord = false;
    if (seg.words.length > 0) line.segments.push(seg);
    seg = { words: [], expand: [] };
  };
  const endLine = () => {
    endSegment();
    // A substitution body runs on the line that spells it, so its segments
    // join that line rather than forming one of their own.
    if (depth < MAX_SUBST_DEPTH) {
      for (const body of bodies) {
        for (const inner of tokenizeLines(body, depth + 1)) {
          for (const s of inner.segments) line.segments.push(s);
        }
      }
    }
    bodies = [];
    if (line.segments.length > 0) lines.push(line);
    line = { segments: [] };
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
      } else if ((ch === '$' && command[i + 1] === '(') || ch === '`') {
        // A command substitution inside double quotes is read the same as an
        // unquoted one: the shell still runs it and the quotes stay open
        // around it (an inner `"` pair the substitution owns does not close
        // the outer quote - `scanSubstitution` tracks that itself). Unlike an
        // unquoted one, it is read across newlines, as the shell reads it -
        // an unquoted substitution stops at the end of the line instead, but
        // that costs nothing because the next line is classified on its own
        // anyway.
        const sub = scanSubstitution(command, i, true);
        word += command.slice(i, sub.end + 1);
        expand = true;
        bodies.push(sub.inner);
        i = sub.end;
      } else {
        if (ch === '$') expand = true;
        word += ch;
      }
    } else if ((ch === '$' && command[i + 1] === '(') || ch === '`') {
      // A command substitution is part of the word, not a boundary.
      const sub = scanSubstitution(command, i);
      word += command.slice(i, sub.end + 1);
      expand = true;
      started = true;
      bodies.push(sub.inner);
      i = sub.end;
    } else if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      expand = true; // $'...' / $"..." — ANSI-C / locale quoting.
      started = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === '\\') {
      if (command[i + 1] !== undefined && command[i + 1] !== '\n') {
        word += command[i + 1];
        started = true;
      }
      i++;
    } else if (ch === '\n') {
      endLine();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (ch === '#' && !started) {
      // An unquoted `#` where no word has started comments out the rest of the
      // line: `git push origin main # git checkout foo` has no checkout in it.
      // `""#` and `x#` are words, so they comment out nothing - treating them
      // as comments hid `echo ""# ; git push origin main` from the gate.
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (ch === '<' || ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      let start = i;
      if (ch === '&') start++; // `&>` / `&>>`
      else if (/^[0-9]+$/.test(word)) word = ''; // `2>`: a file descriptor.
      endWord();
      REDIRECT_OP_RE.lastIndex = start;
      i = start + REDIRECT_OP_RE.exec(command)[0].length - 1;
      dropWord = true; // The target word never reaches the argv.
    } else if (SEGMENT_SEPARATORS.includes(ch)) {
      endSegment();
    } else {
      if (ch === '$' || ch === '{' || ch === '}' || ch === '%') expand = true;
      word += ch;
      started = true;
    }
  }
  endLine();
  return lines;
}

// A word invokes `name` if its basename (either slash direction) is `name` or
// `name` plus a Windows executable suffix, case-insensitively: `git`, `GIT`,
// `"C:\Program Files\Git\bin\git.exe"`, `git.cmd`, `git.bat`.
// Only the QUOTED Windows spelling is recognised. Unquoted, `\` is an escape
// character here exactly as it is in a POSIX shell, so
// `C:\Program Files\...\git.exe push origin main` tokenizes into words that no
// longer look like `git` and is allowed (characterization: test F1). Treating
// `\` as a path separator would break every legitimate escape instead.
const CMD_SUFFIXES = ['', '.exe', '.cmd', '.bat'];
function isCmdWord(word, name) {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase();
  return CMD_SUFFIXES.some((s) => base === `${name}${s}`);
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
// A bare `HEAD` / `@` source is the refspec-less push written out: it lands on
// whatever the current branch tracks.
const UPSTREAM_REFS = new Set(['head', '@']);
// The endpoint word, with whatever a URL may carry after it: `?draft=false` and
// `#frag` still merge the PR, so the boundary is "not another path-word
// character" rather than "end of word" (`pulls/1/merged` is a different call).
// Case-insensitive: the API answers `PULLS/1/MERGE` exactly as it answers the
// lower-case spelling, so reading only one of them was a hole.
// M24: the segment between `pulls/` and `/merge` is not required to be
// digits - `pulls/$PR/merge`, `pulls/${PR}/merge` and `pulls/$(prnum)/merge`
// are candidates too (any run of one or more non-`/` characters), because a
// PR-number variable is a benign, common way to write this call. A variable or
// substitution word also carries a shell-expansion character, so once it is a
// candidate the existing rule 2 expansion item - not this regex - is what
// blocks it.
// M26: whitespace is allowed in that segment. Whitespace only reaches the
// INSIDE of a word through quoting or a command substitution, and a
// substitution is exactly the spelling this has to read -
// `pulls/$(gh pr view --json number -q .number)/merge` is one word with spaces
// in it. Excluding `\s` made that form miss, and a miss here is an allow.
const PULLS_MERGE_RE = /(^|\/)pulls\/[^/]+\/merge(?![A-Za-z0-9_-])/i;
const GIT_ENV_RE = /^GIT_[A-Za-z0-9_]*=/;
// Last-resort screen for a command line the classifier will not read (over the
// byte budget, or a classifier exception): does it mention a gated word at all?
const GATE_WORD_RE = /(?:^|[^A-Za-z0-9_-])(merge|pull|push|rebase|pr)(?:[^A-Za-z0-9_-]|$)/i;
const MAX_COMMAND_BYTES = 64 * 1024;
// The whole hook payload, which carries the command line plus its JSON wrapper.
// Past this there is no command line to judge at all, so it is a block.
const MAX_PAYLOAD_BYTES = 1024 * 1024;
// The second half of the classification budget: the candidate scans are
// O(git/gh words x words) - the push tail walk, the `-c`/`-R` option scans that
// step over the next word - so an unbounded count of git/gh words made a 64 KB
// line cost hundreds of megabytes, and an OOM prints nothing, which reads as
// ALLOW. A command over the cap is not classified at all; no real command comes
// near 256 git/gh words.
const MAX_INVOCATIONS = 256;

function isMainBranch(name) {
  const b = String(name || '').toLowerCase();
  return b === 'main' || b === 'master';
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

// An invocation's arguments run to the end of its segment, so every one of the
// thousands of `git` words a pathological line can hold used to copy - and then
// re-walk - that whole tail: `git push ` repeated to 63 KB took 8.3 s and
// ~800 MB, and a hook that runs out of time or memory prints nothing, which
// reads as ALLOW. Each word is now described ONCE per segment and every
// invocation is a view (`{ seg, facts, start }`) over that description, which
// answers the same input in 0.14 s and ~11 MB.
//
// `words[i]` holds what each rule needs to know about word i; the `*From`
// arrays are suffix flags ("is there such a word at or after i?"), which is
// what "does this invocation's argument list contain one?" reduces to.
const BRANCH_FORCE_FLAGS = new Set(['-f', '-D', '-d', '--force']);
function segmentFacts(seg) {
  const n = seg.words.length;
  const words = new Array(n);
  const ctlFrom = new Array(n + 1);      // --abort/--continue/--quit/--skip
  const forceFrom = new Array(n + 1);    // `git branch -f`
  const mergeApiFrom = new Array(n + 1); // a `pulls/<n>/merge` endpoint word
  ctlFrom[n] = false;
  forceFrom[n] = false;
  mergeApiFrom[n] = false;
  for (let i = n - 1; i >= 0; i--) {
    const w = seg.words[i];
    ctlFrom[i] = ctlFrom[i + 1] || MERGE_CONTROL_FLAGS.has(w);
    forceFrom[i] = forceFrom[i + 1] || BRANCH_FORCE_FLAGS.has(w);
    mergeApiFrom[i] = mergeApiFrom[i + 1] || PULLS_MERGE_RE.test(w);
    if (w.startsWith('-')) {
      words[i] = {
        flag: true,
        hard: isHardPushFlag(w),
        value: PUSH_VALUE_OPTS.has(w),
        repo: w === '--repo' || w.startsWith('--repo='),
      };
    } else {
      const { src, dst } = splitSpec(w);
      words[i] = {
        flag: false,
        src,
        dst,
        plus: w.startsWith('+'),
        main: isMainRef(dst),
        upstream: src === null && UPSTREAM_REFS.has(dst.toLowerCase()),
      };
    }
  }
  return { words, ctlFrom, forceFrom, mergeApiFrom };
}

// Every `git <sub>` in one segment, with the global options that preceded the
// subcommand. `git -c push.default=simple push` is a push; `git stash push`
// is not (the subcommand word is matched whole). `start` is the index of the
// first argument word, and the argument list is `seg.words[start..]`.
function gitInvocations(seg, facts) {
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
    found.push({ sub: seg.words[j].toLowerCase(), seg, facts, start: j + 1, globals, gated: false });
  }
  return found;
}

// Indices of gh free-text option values, which rule 2 does not inspect. The
// carve-out is scoped to the words of a gh call: `--body $X` on a git command
// is an ordinary expansion, not a PR description.
function freeTextIndices(words) {
  const skip = new Set();
  let inGh = false;
  for (let i = 0; i < words.length; i++) {
    if (isCmdWord(words[i], 'gh')) inGh = true;
    else if (isCmdWord(words[i], 'git')) inGh = false;
    if (!inGh) continue;
    if (GH_TEXT_OPTS.has(words[i])) skip.add(i + 1);
    else if (/^(--subject|--body|--body-file)=/.test(words[i])) skip.add(i);
  }
  return skip;
}

// `gh pr merge` / `gh api .../pulls/<n>/merge` in one segment.
function ghCandidates(seg, facts) {
  const found = [];
  for (let i = 0; i < seg.words.length; i++) {
    if (!isCmdWord(seg.words[i], 'gh')) continue;
    let j = i + 1;
    while (j < seg.words.length && seg.words[j].startsWith('-')) {
      j += GH_VALUE_OPTS.has(seg.words[j]) ? 2 : 1;
    }
    const sub = (seg.words[j] || '').toLowerCase();
    if (sub === 'api') {
      if (facts.mergeApiFrom[j + 1]) found.push({ kind: 'gh', mainOnly: false });
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

// Rule 1 for one push invocation, in a single pass that allocates nothing per
// word: main-bound refspecs are recorded as WORD INDICES (rule 2 item 6 reads
// `src`/`dst` back out of the segment facts), deduplicated by source, and the
// rest of the answer is booleans - `git push origin main main main ...` used to
// grow one object per word. The first positional is the remote unless --repo
// named it (`git push --repo=origin main` used to misread `main` as the remote
// and fail open), and --repo may come after it, so that word is held back and
// folded in at the end; the indices are re-sorted in that case so the reason
// still names the first offending refspec in ARGUMENT order. Returns the
// rule-1 candidate, or null when there is none.
function pushCandidate(inv) {
  const facts = inv.facts.words;
  const { words, expand } = inv.seg;
  const mainSpecs = []; // Word indices, argument order.
  const seenSrc = new Set();
  let mainCount = 0;
  let hard = false;
  let repoOpt = false;
  let remote = -1; // The first positional, until --repo says otherwise.
  let specs = 0;
  let upstream = false;
  let unreadable = false;
  let neverExempt = false;

  const refspec = (i) => {
    const f = facts[i];
    specs++;
    if (f.plus) neverExempt = true;
    if (f.upstream) {
      // No refspec, or a bare `HEAD` / `@`: whatever the branch tracks, so
      // this is a candidate exactly on main/master (`mainOnly`).
      upstream = true;
    } else if (f.main) {
      mainCount++;
      if (f.src === '') neverExempt = true; // `:main` is the delete form.
      // Rule 2 item 6 returns on the first offending source, so a source
      // already recorded can answer for every later copy of itself.
      if (f.src !== null && !seenSrc.has(f.src)) {
        seenSrc.add(f.src);
        mainSpecs.push(i);
      }
    } else if (expand[i]) {
      unreadable = true; // Unreadable destination: assume the worst.
    }
  };

  for (let i = inv.start; i < words.length; i++) {
    const f = facts[i];
    if (f.flag) {
      if (f.hard) hard = true;
      if (f.repo) repoOpt = true;
      if (f.value) i++;
      continue;
    }
    if (remote === -1) remote = i;
    else refspec(i);
  }
  if (repoOpt && remote !== -1) {
    refspec(remote);
    mainSpecs.sort((a, b) => a - b); // The held-back word is the FIRST argument.
  }
  if (specs === 0) upstream = true;

  if (mainCount === 0 && !upstream && !unreadable) return null;
  return {
    kind: 'push',
    mainOnly: mainCount === 0 && !unreadable,
    inv,
    hard,
    mainSpecs,
    neverExempt,
  };
}

// Rule 1 candidate detection plus the raw material rule 2 needs, for one line.
function analyzeLine(line) {
  const cands = [];
  const invocations = [];
  let expansion = false;
  let relocation = false;

  for (const seg of line.segments) {
    const facts = segmentFacts(seg);
    const freeText = freeTextIndices(seg.words);
    seg.words.forEach((w, i) => {
      const lw = w.toLowerCase();
      if (lw === 'cd' || lw === 'pushd') relocation = true;
      if (GIT_ENV_RE.test(w)) relocation = true;
      if (seg.expand[i] && !freeText.has(i)) expansion = true;
    });
    for (const c of ghCandidates(seg, facts)) cands.push(c);
    for (const inv of gitInvocations(seg, facts)) {
      invocations.push(inv);
      if (SYNC_SUBS.has(inv.sub)) {
        if (facts.ctlFrom[inv.start]) continue;
        inv.gated = true;
        cands.push({ kind: 'git', sub: inv.sub, mainOnly: true, inv });
      } else if (inv.sub === 'push') {
        const cand = pushCandidate(inv);
        if (!cand) continue;
        inv.gated = true;
        cands.push(cand);
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
  return { line, cands, invocations, expansion, relocation };
}

// git subcommands that move HEAD or make a commit. They must be split out
// from a gated operation ("run them as separate commands"), and the split has
// to be into separate COMMANDS: a newline is not a barrier, because the whole
// multi-line command still runs as one tool call, so
// `git commit -am wip\ngit push origin main` has the same window as the `&&`
// form. The gated call itself never counts: `git pull --rebase` is not a
// rebase mover, and `git rebase origin/main` does not match itself.
// `revert` and `am` make a commit; `bisect` checks one out. All three move
// HEAD after the flag was written, so they belong with `commit` and `checkout`.
// This list plus `stash pop|apply`, `fetch` and `branch -f|-d|-D|--force` is
// the CLOSED set: `status`, `add`, `log`, `diff`, `tag`, `remote`, `restore`
// and every other git operation may share the line without blocking.
const HEAD_MOVERS = [
  'checkout', 'switch', 'commit', 'reset', 'update-ref', 'cherry-pick', 'rebase',
  'revert', 'am', 'bisect',
];

// `fetch` and `branch -f` do not move HEAD, so they only matter next to a
// gated operation on the SAME line.
function moverName(inv, scope) {
  if (inv.gated) return null;
  const s = inv.sub;
  if (HEAD_MOVERS.includes(s)) return s;
  if (s === 'stash') {
    const first = inv.seg.words[inv.start];
    if (first === 'pop' || first === 'apply') return `stash ${first}`;
  }
  if (scope !== 'line') return null;
  if (s === 'fetch') return 'fetch';
  if (s === 'branch' && inv.facts.forceFrom[inv.start]) return 'branch';
  return null;
}
function moverOf(invocations, scope) {
  for (const inv of invocations) {
    const name = moverName(inv, scope);
    if (name) return name;
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
  // Subagent definitions carry system prompts and model choices; `commands/`
  // and `prompts/` files are prompts loaded straight into a session; and
  // `rules/` files (`.cursor/rules/*.mdc`, written by init) are read into
  // EVERY session automatically. Editing any of them rewrites how a review
  // runs, so all four are control plane.
  /^\.(claude|codex|cursor)\/(agents|commands|prompts|rules)(\/|$)/i,
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

// Rule 3's closed set of sync forms, parameterized by the trunk the session is
// actually on: on `master`, `git pull origin master` and
// `git merge origin/master` are the sync forms and `git pull origin main` is
// an ordinary gated operation. Exact word sequences only: a global option, an
// extra flag or a different remote needs a flag.
const syncForms = (trunk) => [['pull'], ['pull', 'origin', trunk], ['merge', `origin/${trunk}`]];
function isSyncForm(line, branch) {
  if (line.segments.length !== 1) return false;
  const w = line.segments[0].words;
  if (w.length < 2 || !isCmdWord(w[0], 'git')) return false;
  const rest = [w[1].toLowerCase(), ...w.slice(2)];
  return syncForms(String(branch).toLowerCase())
    .some((f) => f.length === rest.length && f.every((x, i) => x === rest[i]));
}

// A single-dash bundle carries every letter in it: `-fu` IS `-f -u`, and
// reading it as one unknown option let `git push -fu origin main` through.
const BUNDLE_RE = /^-[A-Za-z0-9]+$/;
function isHardPushFlag(f) {
  if (PUSH_HARD_FLAGS.has(f) || f.startsWith('--force-with-lease=')) return true;
  return BUNDLE_RE.test(f) && (f.includes('f') || f.includes('d'));
}

// Rule 2, items 1-5: no ctx is touched, so these also block on a feature
// branch (deliberate over-detection, see the header). `commandMover` is the
// whole command's HEAD mover, computed once by the caller.
function staticRules(a, commandMover) {
  if (a.cands.length === 0) return null;
  for (const c of a.cands) {
    if (c.kind !== 'push') continue;
    if (c.neverExempt || c.hard) {
      return deny('2', 'Force, delete, --all, --branches and --mirror pushes are never allowed here. Push a plain refspec after a quality check.');
    }
  }
  const mover = moverOf(a.invocations, 'line') || commandMover;
  if (mover) {
    return deny('2', `Split this into separate commands: git ${mover} and a gated push/merge in one call are not allowed.`);
  }
  if (a.relocation) {
    return deny('2', 'Run git from the target repository directory as a separate command (no -C/--git-dir/-c/GIT_*=/cd on the same line).');
  }
  if (a.expansion) {
    return deny('2', 'Write refs without shell expansion (no $, backtick, brace or %VAR% words).');
  }
  if (a.cands.length > 1) {
    return deny('2', 'Run one gated operation per command: split the merge, pull and push apart.');
  }
  return null;
}

// Rule 2 item 6: `<x>:main` from something that is not this branch. The
// candidate carries word indices, so the words themselves are read back from
// the segment facts here.
function reverseRefspec(gated, branch) {
  for (const c of gated) {
    if (!c.mainSpecs) continue;
    const facts = c.inv.facts.words;
    for (const i of c.mainSpecs) {
      const { src, dst } = facts[i];
      // `HEAD` and `@` both name the current branch, in any case spelling.
      if (UPSTREAM_REFS.has(src.toLowerCase()) || src === branch) continue;
      return deny('2', `Push from the branch itself: ${src}:${dst} refspecs are not allowed.`);
    }
  }
  return null;
}

// Rule 4: a non-empty `origin/main...HEAD` diff made up entirely of harness
// files, with no control-plane file and no override string in it.
function rule4Exempt(base, baseControl) {
  return base.files.length > 0 && base.files.every(isHarness)
    && !base.overrideChanged && baseControl.length === 0;
}

// Rule 3: the flag. `baseControl` is the control-plane hit list of the
// origin/main diff, already computed for rule 4.
function rule3Flag(ctx, baseControl) {
  const flag = ctx.flag;
  if (!flag) {
    return deny('3', baseControl.length > 0 ? controlReason(baseControl) : NEED_FLAG);
  }
  const head = ctx.head;
  if (!head) {
    return deny('5', 'Cannot verify HEAD. Re-run the quality-check skill.');
  }
  // `flag.commit` is lower-cased once, where the flag is read.
  if (head.startsWith(flag.commit)) return allow();

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

// Everything that needs ctx. Always returns a decision.
function contextRules(a, ctx) {
  const branch = ctx.branch;
  if (!branch) {
    // Includes a detached HEAD: an unresolved branch with a candidate blocks.
    return deny('5', 'Cannot verify the current branch. Check out a branch, then re-run the command.');
  }
  const gated = a.cands.filter((c) => !c.mainOnly || isMainBranch(branch));
  if (gated.length === 0) return allow();

  const reverse = reverseRefspec(gated, branch); // Rule 2 item 6, ahead of every exemption.
  if (reverse) return reverse;

  if (isMainBranch(branch) && isSyncForm(a.line, branch)) return allow(); // Rule 3, sync form.

  const base = ctx.diffSinceBase;
  if (base === null) {
    return deny('5', 'Cannot verify what changed since origin/main. Re-run the quality-check skill.');
  }
  const baseControl = controlHits(base.files);
  if (rule4Exempt(base, baseControl)) return allow();
  return rule3Flag(ctx, baseControl);
}

// A command line the classifier will not read: judged on its gate words alone,
// so an unreadable line can still not smuggle a merge through.
//
// The words are looked for twice - in the raw text, and in the text with `"`,
// `'` and `\` removed - because the shell reads `p""ush`, `pu\sh` and
// `me""rge` as the gate words they spell, and screening the raw text alone let
// 70 KB of padding carry `git p""ush origin main` through in silence. Stripping
// cannot undo an EXPANSION (`$'\x70'ush` is `push`, `${x}ush` may be anything),
// so a stripped text still holding `$` or a backtick blocks whether or not a
// gate word is left visible. Over-detection here is the point: this path only
// ever sees a line no one can classify.
const TOO_LONG = 'Command line too long to classify. Split the gated git/gh call into its own command.';
const UNCLASSIFIABLE = 'This command line could not be classified. Run the git/gh call as a single plain command.';
const EXPANDED = 'A shell expansion ($, backtick, brace or %) in a command line that cannot be classified could spell anything. Run the git/gh call as a single plain command without expansions.';
const TOO_MANY_INVOCATIONS = 'Too many git/gh invocations in one command to classify. Split it into smaller commands.';
const HUGE_PAYLOAD = 'The hook payload is too large to read, so this command cannot be checked. Run the git/gh call as a single plain command.';

// A `\` immediately before a newline is a LINE CONTINUATION: the shell folds
// both characters away before it reads a word, inside double quotes as well as
// outside them, so `git pu\<LF>sh` and `git "pu\<LF>sh"` both run `git push`.
// It has to be folded BEFORE the quotes come out, or removing the `\` on its
// own leaves a newline in the middle of the gate word and hides it.
const LINE_CONTINUATION_RE = /\\\r?\n/g;
const QUOTE_CHARS_RE = /["'\\]/g;
// The same expansion characters the tokenizer records, not just `$` and a
// backtick: `pus{h..h}` and `%6Derge` are spelled by brace expansion and by a
// URL escape the endpoint reads back, and neither survives quote stripping as
// a gate word.
const EXPAND_CHARS_RE = /[$`{}%]/;
function gateWordFallback(text, reason) {
  const folded = text.replace(LINE_CONTINUATION_RE, '');
  const stripped = folded.replace(QUOTE_CHARS_RE, '');
  if (GATE_WORD_RE.test(text) || GATE_WORD_RE.test(stripped)) return deny('2', reason);
  if (EXPAND_CHARS_RE.test(stripped)) return deny('2', EXPANDED);
  return allow();
}

// Counts `git` / `gh` WORDS, not resolved calls: a `git` in an argument
// position counts too. Over-counting is fail-closed, and the cap it feeds is
// MAX_INVOCATIONS (see the constant).
function countInvocations(lines) {
  let n = 0;
  for (const line of lines) {
    for (const seg of line.segments) {
      for (const w of seg.words) {
        if (isCmdWord(w, 'git') || isCmdWord(w, 'gh')) n++;
      }
    }
  }
  return n;
}

// Pure classifier: it only READS `ctx`, through lazy getters, and a command
// with no rule-1 candidate never touches it at all.
//
// ctx contract - every getter answers for the repository the session is in:
//   branch        current branch name, or null/'' when there is none (detached
//                 HEAD) or git failed. Either way it is UNRESOLVED -> rule 5.
//   head          HEAD sha (lower case), or null when it cannot be read.
//   flag          `{ commit }` from `.quality-check-passed` (commit already
//                 lower-cased), or null. null means NO FLAG - a normal state,
//                 not a failure.
//   isAncestor    true/false for `flag.commit..HEAD`, or null when git failed;
//                 null when there is no flag (never reached in that case).
//   diffSinceFlag `{ files, overrideChanged }`, or null on failure.
//   diffSinceBase `{ files, overrideChanged }` for `origin/main...HEAD`, or
//                 null on failure. An absent base ref is an EMPTY diff (no
//                 exemption), not null.
// Only `flag` uses null to mean "nothing there"; for every other getter null
// means the repository state could not be resolved, and rule 5 blocks. WHICH
// git call failed is recorded on `ctx.state` by the getters themselves, never
// by classify, and is read only by `main()`, which turns the single "not inside
// a git repository" case into a fail-open.
function classify(command, ctx) {
  const text = String(command || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) {
    return gateWordFallback(text, TOO_LONG);
  }
  const lines = tokenizeLines(text);
  if (countInvocations(lines) > MAX_INVOCATIONS) return deny('2', TOO_MANY_INVOCATIONS);
  const analyzed = lines.map(analyzeLine);
  const all = [];
  for (const a of analyzed) for (const inv of a.invocations) all.push(inv);
  // The HEAD movers are judged over the whole command, so this answer is the
  // same for every line: compute it once.
  const commandMover = moverOf(all, 'command');
  for (const a of analyzed) {
    const verdict = staticRules(a, commandMover);
    if (verdict) return verdict;
  }
  for (const a of analyzed) {
    if (a.cands.length === 0) continue;
    const verdict = contextRules(a, ctx);
    if (verdict.decision === 'block') return verdict;
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

  // One call answers both questions, and the ANSWER is the exit status, not a
  // message: git localizes its errors, so matching "not a git repository" made
  // the fail-open depend on the user's locale. Outside a repository rev-parse
  // exits 128; inside one it prints `true` and the work-tree root.
  const root = () => once('root', () => {
    const r = runGit(['rev-parse', '--is-inside-work-tree', '--show-toplevel'], cwd);
    if (!r.ok) return fail(r.status === 128 ? 'not-a-repo' : 'git-error');
    const out = r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
    if (out[0] !== 'true') return fail('not-a-repo'); // Bare repo or inside .git.
    if (!out[1]) return fail('git-error');
    return out[1];
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
  // Buffers, not a string: the cap is in BYTES, and concatenating at the end
  // keeps a multi-byte character that straddles two chunks intact.
  const chunks = [];
  let size = 0;
  let oversized = false;
  process.stdin.on('data', (chunk) => {
    // Bounded memory - an OOM prints nothing, and nothing reads as ALLOW. Past
    // the cap the payload is DROPPED and the hook blocks: reading only the
    // first 64 KB used to hide `echo <65 KB of padding> && git push origin
    // main` from the classifier entirely, and it was allowed in silence.
    if (oversized) return;
    size += chunk.length;
    if (size > MAX_PAYLOAD_BYTES) {
      oversized = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    if (oversized) {
      process.stderr.write('quality-gate: hook payload over 1 MB; cannot classify, blocking.\n');
      emitBlock(HUGE_PAYLOAD);
      return;
    }
    let command;
    let cwd = process.cwd();
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const raw = payload && payload.tool_input ? payload.tool_input.command : undefined;
      if (typeof raw !== 'string') throw new Error('tool_input.command is not a string');
      command = raw;
      if (typeof payload.cwd === 'string' && fs.existsSync(payload.cwd)) cwd = payload.cwd;
    } catch (e) {
      // Rule 5, fail-open #1: never block on a payload the hook cannot read -
      // but say so, or a hook that silently stops gating looks like a hook
      // that is passing everything.
      process.stderr.write(`quality-gate: unreadable hook payload (${e.message}); not gating.\n`);
      return;
    }
    const ctx = makeCtx(cwd);
    let verdict;
    try {
      verdict = classify(command, ctx);
    } catch (e) {
      // A classifier bug must not become a bypass: fall back to the gate words.
      process.stderr.write(`quality-gate: classifier error (${e && e.message}); judging on gate words alone.\n`);
      verdict = gateWordFallback(command, UNCLASSIFIABLE);
    }
    if (verdict.decision !== 'block') return;
    if (ctx.state.failure === 'not-a-repo') {
      // Rule 5, fail-open #2.
      process.stderr.write('quality-gate: not inside a git repository; skipping\n');
      return;
    }
    emitBlock(verdict.reason);
  });
}

module.exports = { classify, tokenizeLines };

if (require.main === module) main();
