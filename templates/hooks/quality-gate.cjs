#!/usr/bin/env node
'use strict';

// PreToolUse hook: forbid direct push / merge into main (or master) unless a
// quality check passed. That single sentence is the whole requirement.
//
// THREAT MODEL: this gate stops ACCIDENTAL, good-faith operations from reaching
// main. Work always starts from an issue and a branch, and a push or merge that
// does get through is recoverable with a revert, so the gate is insurance and
// not a boundary. Deliberate evasion - spelling a gate word with shell
// expansion or an encoding, going through a wrapper script, running git
// indirectly - is OUT OF SCOPE by design (see "Nothing here can see through"
// below).
//
// HOW A COMMAND IS READ (#158). The same text may run under a POSIX shell (Git
// Bash on Windows) or under PowerShell, and the two read quoting, escapes,
// paths and directory changes differently. Reading arbitrary shell both ways
// kept leaving spellings the two disagreed on, and each disagreement was a
// false allow. So the hook reads an ALLOWLISTED form instead:
//   1. A command with no gate word - `push`, `pull`, `merge` or `rebase` as a
//      whole word, looked for in the raw text and again with `"` `'` `\`
//      backtick `^` `$` removed and line continuations folded (`gateWordIn`) -
//      is allowed at once. No git runs, nothing is parsed. So is one whose gate
//      words are all inside a literal message value (`maskMessages`).
//   2. A command WITH a gate word is judged only when it is SIMPLE
//      (`parseSimple` / `checkSegment`). Anything else is refused with
//      guidance: run the push/merge as its own simple command. A false refusal
//      costs the agent a rerun; a false allow is a hole.
//   3. A simple command is judged on its merits: candidates (rule 1), rule 2,
//      the directory each candidate runs in, then that repository's flag.
//
// SIMPLE means all of:
//   - Characters. Outside quotes only ASCII letters and digits, space, tab,
//     newline and `. _ / - : @ = + ~ %`, with `;` and `&&` as separators. A
//     single- or double-quoted string is a whole word (or follows `name=`), is
//     not empty (Windows PowerShell drops an empty argument), and holds only
//     those characters, `, ; &`, and non-ASCII letters, digits and CJK
//     punctuation. So no backslash (no escapes, no line continuations; a
//     Windows path is written with `/`), `$`, backtick, `|`, `<`, `>`,
//     parentheses, braces, brackets, `#`, `*`, `?`, `!`, `^`, nested quotes,
//     CR or NUL anywhere, and no unquoted `,` (an array in PowerShell).
//     Output plumbing at the very end of the whole command, in the exact
//     spellings of `stripTrailingOutput`, is dropped first.
//   - Segments are split on newline, `;` and `&&` only (`||`, `|` and a single
//     `&` are not simple). `&&` at the end of a line continues on the next.
//   - Each segment starts with an unquoted command word from a closed list,
//     case-insensitive: `git`, `gh`, a location change (`cd`, `pushd`, `popd`,
//     `chdir`, `sl`, `Set-Location`, `Push-Location`, `Pop-Location`), or a
//     build/test runner (RUNNERS). No `NAME=value` prefix.
//   - `git`: global options are `-C <path>` (also attached, `-C<path>`) and
//     `--no-pager` only - no `-c`, `--git-dir`, `--work-tree`, `--exec-path`,
//     `--namespace`, `--super-prefix`, `--config-env` or anything else. The
//     subcommand is from GIT_SUBCOMMANDS (so no `config`, no alias) and carries
//     no option that makes git run a command string (`runsCommand`).
//     `gh`: the subcommand is from GH_SUBCOMMANDS (no `alias`, no extension).
//     A runner: no gate word in its arguments (`npx -c "git push"`).
//     A location change: exactly one path (`-Path` / `-LiteralPath` may come
//     first for the PowerShell spellings); `popd` / `Pop-Location` none.
//   - In `git` / `gh` words: no unquoted single-dash option carrying anything
//     but letters, digits, `_` and `-` (PowerShell splits `-o:main` into `-o:`
//     and `main`), no word starting with `@` (splatting), no `--%`.
//   - A path (`checkPath`) is relative, or absolute with `/` (`C:/…` on
//     Windows); never a network path (`//host`), drive-relative (`C:x`),
//     drive-less absolute on Windows, `~…`, `-…`, `+…`, or holding `%`. With
//     CDPATH set in the hook's environment a POSIX `cd` / `pushd` target must
//     start with `/`, `./` or `../`.
//
// Rule 1 (gated candidates): `gh pr merge` (any args); `gh api` with a
//   `pulls/<n>/merge` word, case insensitive (a `?query` or `#fragment` after
//   it would still merge, but neither is simple); `git merge` / `git pull` /
//   `git rebase` (any args, except --abort/--continue/--quit/--skip) - gated
//   only once ctx says the current branch is main/master; `git push` whose
//   refspec DESTINATION is exactly `main`/`master` (after stripping `+` and
//   `refs/heads/`, case insensitive; `--delete <ref>` counts as a
//   destination), or a push with no refspec at all - or a bare `HEAD`/`@`,
//   which is the same thing written out - (gated only on main/master); a push
//   that writes every matching branch (`--all`, `--branches`, `--mirror`, a
//   refspec with no destination such as `:`) on any branch.
//   Substring matches never count: `feature/main-nav` and `main:feature-x` are
//   not candidates. A refspec carrying `%` or a leading `~` is a candidate
//   because its destination cannot be read.
// Rule 2 (blocked with no exemption): a command with a gate word that is not
//   simple; force/delete/`+refspec`/`--mirror`/`--all`/`--branches` pushes
//   (short bundles such as `-fu` and long abbreviations such as `--forc`
//   included); a git
//   command from the mover set (commit, reset, checkout, switch, cherry-pick,
//   rebase, revert, am, bisect, update-ref, stash pop|apply, fetch, and on the
//   same line branch -f|-d|-D|--force) other than the gated call itself - the
//   set is CLOSED, so status, add, log, diff, tag, remote, restore, ... may
//   share the command; `%` or a leading `~` in a word of a line that holds a
//   candidate, except the value of gh's free-text options (`-t`/`--subject`,
//   `-b`/`--body`, `-F`/`--body-file` and their `=` spellings); a directory
//   the location walk cannot resolve, one outside any git work tree, or
//   candidates in two repositories (see "Where each gated call runs"); more
//   than one gated operation on a line; a push that writes every matching
//   branch; a trunk-bound refspec whose source is neither HEAD/`@` nor the
//   current branch (`<x>:main`, and `main` / `refs/heads/main` alone, which
//   push the LOCAL main, off main).
//   The movers that move HEAD or make a commit, and `fetch` (it rewrites the
//   ref a later merge reads), are judged over the WHOLE command;
//   `branch -f|-d|-D|--force` per line. The one fetch let through is the
//   daily trunk sync - plain `git fetch [origin] [<trunk>]` and then
//   `git merge [--ff-only] origin/<trunk>` on that trunk - as the WHOLE command
//   with nothing else in it (`isPlainTrunkSync`), and only while
//   `origin/<trunk>` resolves to the remote-tracking ref; the same shape with
//   `git rebase origin/<trunk>` lets the rebase be judged as usual. The one commit let through is a
//   plain `git commit ... && git push [remote]` on a feature branch
//   (`isPlainCommitPush`).
// Rule 3 (pass): `.quality-check-passed` at the repo root with `commit` an
//   abbreviated prefix of (or equal to) HEAD (`branch` is diagnostic only), or
//   `commit` an ancestor of HEAD whose `commit..HEAD` diff is harness files
//   only. Plus the closed set of sync forms on the CURRENT trunk:
//   `git pull`, `git pull origin <trunk>`, `git merge origin/<trunk>`, each
//   also with one `--ff-only` - exact word sequences, as the WHOLE command
//   (another line could create the ref the form reads); the merge form only
//   while `origin/<trunk>` resolves to the remote-tracking ref (a local tag or
//   branch of that name is what git would merge instead).
// Rule 4 (exemption): a non-empty `origin/main...HEAD` diff made up entirely
//   of harness files. Gate control-plane paths and `Quality Gate Overrides` /
//   `mutation_budget_minutes` string changes are carved out of both rule 3
//   and rule 4 (no validity analysis of the declaration - over-detection is
//   fine). The control plane is the quality-check / test-recommendation skills
//   and their schemas, the review guides, and - under `.claude`,
//   `.codex` or `.cursor` - `hooks/`, `skills/`, `agents/`, `commands/`,
//   `prompts/`, `rules/`, plus the hook's registration files (see
//   GATE_CONTROL_PATTERNS, which is the authority).
// Rule 5 (fail-open, exactly twice): a payload whose `tool_input.command` is
//   not a string (malformed JSON, a missing field), and a PAYLOAD cwd that is
//   not inside a git work tree - decided by rev-parse's EXIT STATUS, never by
//   its (localized) message. The second one is about the payload cwd only: a
//   block decided where a `cd` / `-C` moved the call stands even when the cwd
//   is not a repository, and a refusal of a command that is not simple never
//   reads git at all, so it stands too. Any other git failure or timeout on a
//   command with a candidate blocks. Both fail-opens write their reason to
//   stderr, so a hook that has stopped gating is visible rather than silent.
// Rule 6 (output): `{"decision":"block","reason":...}` only; allow is silent.
//
// The budget: a command line over 64 KB is not parsed - it blocks when a gate
// word is found (`gateWordIn`) or when the text with quotes removed carries an
// expansion character, and is allowed otherwise; a classifier exception is
// judged the same way. A hook PAYLOAD over 1 MB is not parsed at all and
// blocks. Parsing a simple command is linear: every segment has exactly one
// command word, so there is no per-invocation scan to bound.
//
// Deliberate over-detection, all in the fail-closed direction: any command
// that mentions a gate word and is not simple is refused, even when it would
// not push (`grep -rn push src`, a commit message with parentheses); rule 2
// is evaluated before the branch is known, so it also blocks on a feature
// branch; a detached HEAD is an UNRESOLVED branch; `git push --force` with no
// refspec blocks anywhere.
//
// Nothing here can see through, and none of these is treated as a gap:
//   - a gate word spelled so that it is not in the text: `git $'\x70'ush`,
//     `git pus{h..h}`, `gh pr me{r..r}ge`, an encoded PowerShell command, a
//     percent-encoded `gh api` endpoint;
//   - a wrapper: a script, an npm script, a git or shell alias or a function
//     defined in an earlier tool call (one defined in the same command is not
//     simple), `xargs`, `env -S`;
//   - a refspec that lives in configuration: `remote.<name>.push`,
//     `push.default = matching`, `branch.<n>.merge`;
//   - other merge APIs: `gh api graphql` with `mergePullRequest`, `gh repo
//     sync`, `git subtree push` into a trunk; another repository's PR through
//     `gh -R`;
//   - a directory that changes between this check and the command running
//     (a symlink re-pointed by an earlier segment, a mapped network drive).
// Trunk names are fixed to `main` / `master`; a product using another trunk
// name is not gated here and relies on the `permissions.deny` layer and
// convention. Every git call here goes through execFileSync with an argv
// array - no shell is ever involved.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FLAG_FILE = '.quality-check-passed';
const MAX_FLAG_BYTES = 4096;
const MAX_BUFFER = 32 * 1024 * 1024;
// Global deadline: Claude Code kills the hook at its configured timeout, and a
// hook killed before it prints is read as "allowed". Every git call clamps to
// what is left, so a pathological repo degrades into a block, not a bypass.
const DEADLINE = Date.now() + 20000;
const IS_WIN = process.platform === 'win32';

// --------------------------------------------------------------------------
// Gate words: the cheap screen in front of everything
// --------------------------------------------------------------------------
// A whole word, bounded by anything but a letter: `git-push`, `--rebase` and
// `merge-base` count (over-detection costs a parse), `pushd` and `merged` do
// not. `pr` is not a gate word: every gated gh call also says `merge`.
const GATE_WORD_RE = /(?<![A-Za-z])(?:merge|pull|push|rebase)(?![A-Za-z])/i;
// A line continuation (`\` in a POSIX shell, a backtick in PowerShell) is
// folded away before a word is read, so it is folded before the escape
// characters themselves come out - removing the `\` alone would leave a line
// break in the middle of `pu\<LF>sh`. `^` is cmd's escape character, and `$`
// goes too: `pu$''sh` is `push` to a POSIX shell (an empty `$'...'` string).
const LINE_CONTINUATION_RE = /[\\`]\r?\n/g;
const ESCAPE_CHARS_RE = /["'\\`^$]/g;
function gateWordIn(text) {
  if (GATE_WORD_RE.test(text)) return true;
  return GATE_WORD_RE.test(text.replace(LINE_CONTINUATION_RE, '').replace(ESCAPE_CHARS_RE, ''));
}

// --------------------------------------------------------------------------
// The simple form
// --------------------------------------------------------------------------
// Outside quotes a word is made of these; space, tab, newline, `;` and `&&`
// separate words.
const PLAIN_CHAR_RE = /[A-Za-z0-9._/:@=+~%-]/;
// Inside quotes: the same, whitespace, `, ; &`, and non-ASCII letters, marks,
// digits and CJK punctuation (a commit message in Japanese). Nothing either
// shell treats specially inside quotes - no `$`, backtick, `\`, `!`, or the
// typographic quotes PowerShell closes a string at.
const QUOTED_CHAR_RE = /^[A-Za-z0-9._/:@=+~%\- \t\n,;&\p{L}\p{M}\p{N}\u3001-\u303f]$/u;
const MAX_STATES = 16; // Readings of the location walk; more than this is unresolved.

const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'gradle', 'gradlew', './gradlew', 'mvn', './mvnw']);
// A location change: what it does, and whether a POSIX shell runs it too. Bash
// builtins are case-sensitive, so only the exact lower-case `cd` / `pushd` /
// `popd` move there; every other spelling moves in PowerShell only.
const MOVE_WORDS = new Map([
  ['cd', 'cd'], ['chdir', 'cd'], ['sl', 'cd'], ['set-location', 'cd'],
  ['pushd', 'push'], ['push-location', 'push'], ['popd', 'pop'], ['pop-location', 'pop'],
]);
const POSIX_MOVES = new Set(['cd', 'pushd', 'popd']);
const PS_PATH_PARAMS = new Set(['-path', '-literalpath']);
// The git subcommands a gated command may hold. None of them runs a command
// string given on the command line once `runsCommand` has had its say; an
// alias or `config` (which can define one) is not here.
const GIT_SUBCOMMANDS = new Set([
  'push', 'pull', 'merge', 'rebase', 'fetch', 'status', 'log', 'show', 'diff', 'add', 'commit',
  'stash', 'tag', 'branch', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'rev-parse',
  'merge-base', 'ls-files', 'ls-remote', 'remote', 'describe', 'cherry-pick', 'revert', 'am',
  'bisect', 'update-ref', 'reflog', 'shortlog', 'blame', 'grep', 'show-ref', 'worktree',
]);
const GH_SUBCOMMANDS = new Set([
  'pr', 'api', 'issue', 'run', 'repo', 'release', 'search', 'status', 'browse', 'label', 'workflow', 'auth',
]);
// Long options that run a command string. git accepts any unambiguous prefix
// of a long option, so `--ex` is `--exec` - every prefix counts here.
const EXEC_LONG_OPTS = ['exec', 'receive-pack', 'upload-pack', 'open-files-in-pager'];
const PS_SPLIT_RE = /^-[A-Za-z]/; // A word PowerShell reads as a parameter.
const PS_WHOLE_PARAM_RE = /^-[A-Za-z0-9_-]*$/; // ...that it passes on in one piece.
const CDPATH_SAFE_RE = /^(\/|\.\.?(\/|$))/;

// Why a command is not simple, phrased for the reason text.
class NotSimple extends Error {}
const notSimple = (why) => {
  throw new NotSimple(why);
};

// `--name` is a prefix of one of `names` (git expands abbreviated options).
function longPrefixOf(word, names) {
  if (!word.startsWith('--')) return false;
  const name = word.slice(2).split('=')[0].toLowerCase();
  return name !== '' && names.some((n) => n.startsWith(name));
}

// Lexing: words (with their quoting) and the separators between them.
function lex(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '\n' || ch === ';') {
      tokens.push({ sep: ch });
      i++;
    } else if (ch === '&') {
      if (text[i + 1] !== '&') notSimple('a single `&`');
      tokens.push({ sep: '&&' });
      i += 2;
    } else {
      let word = '';
      while (i < text.length && PLAIN_CHAR_RE.test(text[i])) word += text[i++];
      const bare = word; // The unquoted part.
      let quoted = false;
      if (text[i] === '"' || text[i] === "'") {
        if (word !== '' && !word.endsWith('=')) notSimple('a quote inside a word');
        const close = text.indexOf(text[i], i + 1);
        if (close === -1) notSimple('an unterminated quote');
        const body = text.slice(i + 1, close);
        if (body === '') notSimple('an empty quoted argument');
        for (const c of body) if (!QUOTED_CHAR_RE.test(c)) notSimple(`\`${describe(c)}\` inside quotes`);
        word += body;
        quoted = true;
        i = close + 1;
      }
      if (word === '' || (i < text.length && !' \t\n;&'.includes(text[i]))) notSimple(`\`${describe(text[i])}\``);
      // `%` (cmd's variables) and a tilde the shell may expand mark a word
      // whose text is not what runs - rule 2's expansion item.
      tokens.push({ word, quoted, expand: word.includes('%') || /(^|[=:])~/.test(bare) });
    }
  }
  return tokens;
}
function describe(c) {
  if (c === undefined) return 'end of command';
  const code = c.codePointAt(0);
  if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).padStart(4, '0').toUpperCase()}`;
  return code > 0x7e ? 'a non-ASCII character outside quotes' : c;
}

// Split into lines of segments. A segment records the separator before it
// (`''` at the start of a line, `;`, `&&`) and after it.
function parseSimple(text) {
  const lines = [];
  let line = { segments: [] };
  let seg = null;
  let pending = '';
  const close = (sep) => {
    seg.after = sep;
    line.segments.push(seg);
    seg = null;
  };
  for (const tok of lex(text)) {
    if (tok.word !== undefined) {
      if (!seg) seg = { words: [], expand: [], quoted: [], before: pending, after: '' };
      seg.words.push(tok.word);
      seg.expand.push(tok.expand);
      seg.quoted.push(tok.quoted);
    } else if (tok.sep === '\n') {
      if (!seg && pending === '&&') continue; // `a &&` + newline: the chain goes on.
      if (seg) close('');
      if (line.segments.length > 0) lines.push(line);
      line = { segments: [] };
      pending = '';
    } else {
      if (!seg) notSimple(`an empty command before \`${tok.sep}\``);
      close(tok.sep);
      pending = tok.sep;
    }
  }
  if (seg) close('');
  else if (pending === '&&') notSimple('`&&` at the end');
  if (line.segments.length > 0) lines.push(line);
  for (const l of lines) for (const s of l.segments) checkSegment(s);
  return lines;
}

// A path a location change or `-C` may name. Returns it, or refuses.
function checkPath(p, posixMove) {
  if (/^[~+-]/.test(p) || p.includes('%')) notSimple(`the path \`${p}\``);
  if (p.startsWith('//')) notSimple('a network path');
  if (IS_WIN) {
    if (p.startsWith('/')) notSimple('an absolute path without a drive letter');
    if (p.includes(':') && !/^[A-Za-z]:\/[^:]*$/.test(p)) notSimple(`the path \`${p}\``);
  } else if (p.includes(':')) {
    notSimple(`the path \`${p}\``);
  }
  // bash looks a bare name up in CDPATH before the current directory.
  if (posixMove && process.env.CDPATH && !CDPATH_SAFE_RE.test(p)) notSimple('a bare `cd` name while CDPATH is set');
  return p;
}

// Does this git call run a command string from its own arguments?
function runsCommand(sub, words, start) {
  if (sub === 'bisect' && (words[start] || '').toLowerCase() === 'run') return true;
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (longPrefixOf(w, EXEC_LONG_OPTS)) return true;
    if (w.startsWith('--') || !w.startsWith('-')) continue;
    if (sub === 'rebase' && w.includes('x')) return true; // `-x <cmd>`, also bundled.
    if (sub === 'grep' && w.includes('O')) return true; // `-O<pager>`
  }
  return false;
}

// Classify and check one segment: `kind`, and `git` / `move` details.
function checkSegment(seg) {
  const { words } = seg;
  const first = words[0].toLowerCase();
  if (seg.quoted[0]) notSimple('a quoted command word');
  if (words[0].includes('=')) notSimple('an environment assignment');
  for (let i = 0; i < words.length; i++) {
    if (seg.quoted[i]) continue;
    if (words[i].length > 1 && words[i].startsWith('@')) notSimple(`\`${words[i]}\``);
    if (words[i] === '--%') notSimple('`--%`');
  }
  if (MOVE_WORDS.has(first)) {
    const op = MOVE_WORDS.get(first);
    const posix = POSIX_MOVES.has(words[0]);
    seg.kind = 'move';
    if (op === 'pop') {
      if (words.length !== 1) notSimple(`arguments to \`${words[0]}\``);
      seg.move = { op, posix };
      return;
    }
    let at = 1;
    if (!posix && words.length === 3 && PS_PATH_PARAMS.has(words[1].toLowerCase())) at = 2;
    if (words.length !== at + 1) notSimple(`\`${words[0]}\` without exactly one path`);
    seg.move = { op, posix, path: checkPath(words[at], posix) };
    return;
  }
  if (RUNNERS.has(first)) {
    seg.kind = 'run';
    if (words.slice(1).some((w) => GATE_WORD_RE.test(w))) notSimple(`a gate word in the arguments of \`${words[0]}\``);
    return;
  }
  if (first !== 'git' && first !== 'gh') notSimple(`the command \`${words[0]}\``);
  for (let i = 1; i < words.length; i++) {
    if (seg.quoted[i] || !PS_SPLIT_RE.test(words[i]) || PS_WHOLE_PARAM_RE.test(words[i])) continue;
    // `-C<path>` among git's global options is checked with the path rules below.
    if (first === 'git' && words[i].startsWith('-C') && precedesSubcommand(words, i)) continue;
    notSimple(`the option \`${words[i]}\``);
  }
  if (first === 'gh') {
    seg.kind = 'gh';
    let j = 1;
    while (j < words.length && words[j].startsWith('-')) {
      if (words[j] === '-R' || words[j] === '--repo') j += 2;
      else if (words[j].startsWith('--repo=')) j += 1;
      else notSimple(`the gh option \`${words[j]}\``);
    }
    if (!GH_SUBCOMMANDS.has((words[j] || '').toLowerCase())) notSimple(`\`gh ${words[j] || ''}\``);
    return;
  }
  seg.kind = 'git';
  const chdirs = [];
  const globals = [];
  let j = 1;
  while (j < words.length && words[j].startsWith('-')) {
    const w = words[j];
    globals.push(w);
    if (w === '--no-pager') {
      j++;
    } else if (w === '-C') {
      if (j + 1 >= words.length) notSimple('`git -C` without a path');
      chdirs.push(checkPath(words[j + 1], false));
      j += 2;
    } else if (w.startsWith('-C') && !seg.quoted[j]) {
      // Attached: PowerShell may pass `-C../x` as `-C` `../x`, the same path,
      // or cut it where the rest becomes git's next argument and fails.
      chdirs.push(checkPath(w.slice(2), false));
      j++;
    } else {
      notSimple(`the git option \`${w}\``);
    }
  }
  const sub = (words[j] || '').toLowerCase();
  if (!GIT_SUBCOMMANDS.has(sub)) notSimple(`\`git ${words[j] || ''}\``);
  if (runsCommand(sub, words, j + 1)) notSimple(`an option that makes \`git ${sub}\` run a command`);
  seg.git = { sub, start: j + 1, globals, chdirs };
}
// Index `i` is still among git's global options (before the subcommand).
function precedesSubcommand(words, i) {
  for (let j = 1; j < i; j++) if (!words[j].startsWith('-') && words[j - 1] !== '-C') return false;
  return true;
}

// --------------------------------------------------------------------------
// Candidates (rule 1) and the facts rule 2 reads
// --------------------------------------------------------------------------

// push options that consume the following word.
const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
// Never exempt, on any branch, once a push candidate exists. An abbreviation
// of one of the long ones (`--forc`, `--del`) is the same option to git.
const PUSH_HARD_FLAGS = new Set([
  '--force', '-f', '--force-with-lease', '--delete', '-d', '--mirror', '--all', '--branches',
]);
const PUSH_HARD_LONG = ['force', 'force-with-lease', 'delete', 'mirror', 'all', 'branches'];
// Pushes that write every matching branch - the trunk among them - whatever
// refspecs follow. A candidate on every branch, refused by rule 2.
const PUSH_WIDE_LONG = ['mirror', 'all', 'branches'];
// gh options whose values are free text, not refs (rule 2 carve-out).
const GH_TEXT_OPTS = new Set(['-t', '--subject', '-b', '--body', '-F', '--body-file']);
const GH_VALUE_OPTS = new Set(['-R', '--repo', ...GH_TEXT_OPTS]);

const MERGE_CONTROL_FLAGS = new Set(['--abort', '--continue', '--quit', '--skip']);
const SYNC_SUBS = new Set(['merge', 'pull', 'rebase']);
// A bare `HEAD` / `@` source is the refspec-less push written out: it lands on
// whatever the current branch tracks.
const UPSTREAM_REFS = new Set(['head', '@']);
// The endpoint word. Case-insensitive: the API answers `PULLS/1/MERGE` exactly
// as it answers the lower-case spelling. The segment between `pulls/` and
// `/merge` need not be digits.
const PULLS_MERGE_RE = /(^|\/)pulls\/[^/]+\/merge(?![A-Za-z0-9_-])/i;
const MAX_COMMAND_BYTES = 64 * 1024;
// The whole hook payload, which carries the command line plus its JSON wrapper.
// Past this there is no command line to judge at all, so it is a block.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

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

// What each rule needs to know about each word of a segment, computed once.
// The `*From` arrays are suffix flags ("is there such a word at or after i?").
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
      // `--repo`, or an abbreviation git expands to it (`--rep`).
      const name = w.startsWith('--') ? w.slice(2).split('=')[0].toLowerCase() : '';
      const repo = name.length >= 3 && 'repo'.startsWith(name);
      words[i] = {
        flag: true,
        hard: isHardPushFlag(w),
        wide: longPrefixOf(w, PUSH_WIDE_LONG),
        value: PUSH_VALUE_OPTS.has(w) || (repo && !w.includes('=')),
        repo,
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

// A single-dash bundle carries every letter in it: `-fu` IS `-f -u`.
const BUNDLE_RE = /^-[A-Za-z0-9]+$/;
function isHardPushFlag(f) {
  if (PUSH_HARD_FLAGS.has(f) || f.startsWith('--force-with-lease=')) return true;
  if (longPrefixOf(f, PUSH_HARD_LONG)) return true;
  return BUNDLE_RE.test(f) && (f.includes('f') || f.includes('d'));
}

// The git call a `git` segment makes. `start` is the index of its first
// argument word; `chdirs` lists every `-C` path in order.
function gitInvocation(seg, facts) {
  return { sub: seg.git.sub, seg, facts, start: seg.git.start, globals: seg.git.globals, chdirs: seg.git.chdirs, gated: false };
}

// Indices of gh free-text option values, which rule 2 does not inspect.
function freeTextIndices(seg) {
  const skip = new Set();
  if (seg.kind !== 'gh') return skip;
  seg.words.forEach((w, i) => {
    if (GH_TEXT_OPTS.has(w)) skip.add(i + 1);
    else if (/^(--subject|--body|--body-file)=/.test(w)) skip.add(i);
  });
  return skip;
}

// `gh pr merge` / `gh api .../pulls/<n>/merge`.
function ghCandidate(seg, facts) {
  let j = 1;
  while (j < seg.words.length && seg.words[j].startsWith('-')) {
    j += GH_VALUE_OPTS.has(seg.words[j]) ? 2 : 1;
  }
  const sub = (seg.words[j] || '').toLowerCase();
  if (sub === 'api') return facts.mergeApiFrom[j + 1] ? { kind: 'gh', mainOnly: false, seg } : null;
  if (sub !== 'pr') return null;
  let k = j + 1;
  while (k < seg.words.length && seg.words[k].startsWith('-')) {
    k += GH_VALUE_OPTS.has(seg.words[k]) ? 2 : 1;
  }
  return (seg.words[k] || '').toLowerCase() === 'merge' ? { kind: 'gh', mainOnly: false, seg } : null;
}

// Rule 1 for one push invocation, in a single pass: main-bound refspecs are
// recorded as WORD INDICES (rule 2 item 6 reads `src`/`dst` back out of the
// segment facts), deduplicated by source. The first positional is the remote
// unless --repo named it, and --repo may come after it, so that word is held
// back and folded in at the end; the indices are re-sorted in that case so
// the reason still names the first offending refspec in ARGUMENT order.
// Returns the rule-1 candidate, or null when there is none.
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
  let matching = false; // Every matching branch: `:`, --all, --branches, --mirror.

  const refspec = (i) => {
    const f = facts[i];
    specs++;
    if (f.plus) neverExempt = true;
    if (f.src !== null && f.dst === '') {
      // `:` / `+:` (every matching branch, the trunk included) or `<x>:`:
      // the destination is not written down, so assume the trunk.
      matching = true;
    } else if (f.upstream) {
      // No refspec, or a bare `HEAD` / `@`: whatever the branch tracks, so
      // this is a candidate exactly on main/master (`mainOnly`).
      upstream = true;
    } else if (f.main) {
      mainCount++;
      if (f.src === '') neverExempt = true; // `:main` is the delete form.
      // `main` alone pushes the local `main`: its source is the same word.
      const src = f.src === null ? f.dst : f.src;
      if (!seenSrc.has(src)) {
        seenSrc.add(src);
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
      if (f.wide) matching = true;
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

  if (mainCount === 0 && !upstream && !unreadable && !matching) return null;
  return {
    kind: 'push',
    mainOnly: mainCount === 0 && !unreadable && !matching,
    matching,
    omittedRefspec: specs === 0,
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
  for (const seg of line.segments) {
    if (seg.kind !== 'git' && seg.kind !== 'gh') continue;
    const facts = segmentFacts(seg);
    const freeText = freeTextIndices(seg);
    seg.expand.forEach((e, i) => {
      if (e && !freeText.has(i)) expansion = true;
    });
    if (seg.kind === 'gh') {
      const c = ghCandidate(seg, facts);
      if (c) cands.push(c);
      continue;
    }
    const inv = gitInvocation(seg, facts);
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
  return { line, cands, invocations, expansion };
}

// git subcommands that move HEAD or make a commit. They must be split out
// from a gated operation ("run them as separate commands"), and a newline is
// not a barrier - the whole multi-line command still runs as one tool call.
// The gated call itself never counts: `git pull --rebase` is not a rebase
// mover. This list plus `stash pop|apply`, `fetch` and
// `branch -f|-d|-D|--force` is the CLOSED set.
const HEAD_MOVERS = [
  'checkout', 'switch', 'commit', 'reset', 'update-ref', 'cherry-pick', 'rebase',
  'revert', 'am', 'bisect',
];

// `fetch` does not move HEAD but rewrites the remote-tracking ref a later
// `git merge origin/<x>` reads, so it is judged over the whole command too.
// `branch -f` only matters next to a gated operation on the SAME line.
function moverName(inv, scope) {
  if (inv.gated) return null;
  const s = inv.sub;
  if (HEAD_MOVERS.includes(s)) return s;
  if (s === 'stash') {
    const first = inv.seg.words[inv.start];
    if (first === 'pop' || first === 'apply') return `stash ${first}`;
  }
  if (s === 'fetch') return 'fetch';
  if (scope !== 'line') return null;
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

// The daily trunk sync - `git fetch` and then `git merge origin/<trunk>` on
// that trunk - is the one fetch the whole-command rule lets through, and only
// in this exact shape: every mover is a plain fetch (`git fetch [origin]
// [<trunk>]`, optionally `--prune` / `--quiet`; no refspec with `:` or `+`, no
// `--refmap`, no global option, no expansion), every candidate is
// `git merge origin/<trunk>` (or `refs/remotes/origin/<trunk>`) alone in its
// segment, and - checked with ctx - the current branch is that trunk and any
// trunk a fetch names is the same one.
const FETCH_SYNC_FLAGS = new Set(['--prune', '-p', '--quiet', '-q']);
const SYNC_SOURCE_RE = /^(?:refs\/remotes\/)?origin\/(main|master)$/;
function plainFetch(inv) {
  if (inv.sub !== 'fetch' || inv.globals.length > 0) return null;
  const { words, expand } = inv.seg;
  const positional = [];
  for (let i = inv.start; i < words.length; i++) {
    if (expand[i]) return null;
    if (words[i].startsWith('-')) {
      if (!FETCH_SYNC_FLAGS.has(words[i])) return null;
    } else {
      positional.push(words[i]);
    }
  }
  if (positional.length > 2) return null;
  if (positional.length >= 1 && positional[0] !== 'origin') return null;
  if (positional.length === 2 && positional[1] !== 'main' && positional[1] !== 'master') return null;
  return { trunk: positional[1] || null };
}
function fetchOnlyMovers(invocations) {
  const trunks = [];
  let fetches = 0;
  for (const inv of invocations) {
    if (!moverName(inv, 'line')) continue;
    const f = plainFetch(inv);
    if (!f) return null;
    fetches++;
    if (f.trunk) trunks.push(f.trunk);
  }
  return fetches > 0 ? { trunks } : null;
}
// The call after the fetch: `git merge [--ff-only] origin/<trunk>` or
// `git rebase origin/<trunk>`, alone in its segment. Returns
// `{ sub, trunk, source }`, or null.
function syncTarget(cand) {
  if (cand.kind !== 'git' || (cand.inv.sub !== 'merge' && cand.inv.sub !== 'rebase')) return null;
  const { inv } = cand;
  const { words, expand } = inv.seg;
  if (inv.globals.length > 0 || inv.start !== 2 || words[1] !== inv.sub || expand.some(Boolean)) return null;
  const rest = words.slice(2);
  if (inv.sub === 'merge' && rest.length === 2 && rest[0] === '--ff-only') rest.shift();
  if (rest.length !== 1) return null;
  const m = SYNC_SOURCE_RE.exec(rest[0]);
  return m ? { sub: inv.sub, trunk: m[1], source: rest[0] } : null;
}
// The whole command has to be the sync and nothing else: exactly one plain
// fetch segment followed by exactly one sync-merge segment, joined by a
// newline, `;` or `&&`, in plain characters (no quotes). Any other command
// next to them - one that rewrites where `origin` points, for one - can change
// what the merge reads.
const TRUNK_SYNC_TEXT_RE = /^[A-Za-z0-9_./ \t\n;&-]*$/;
function isPlainTrunkSync(text, lines) {
  if (!TRUNK_SYNC_TEXT_RE.test(text)) return false;
  const segs = lines.flatMap((line) => line.segments);
  if (segs.length !== 2 || segs.some((seg) => seg.kind !== 'git')) return false;
  const [fetchSeg, mergeSeg] = segs;
  if (fetchSeg.before !== '' || mergeSeg.after !== '') return false;
  if (fetchSeg.words[0] !== 'git' || mergeSeg.words[0] !== 'git') return false;
  return plainFetch(gitInvocation(fetchSeg, segmentFacts(fetchSeg))) !== null
    && syncTarget({ kind: 'git', inv: gitInvocation(mergeSeg, segmentFacts(mergeSeg)) }) !== null;
}
const FETCH_SPLIT = 'Split this into separate commands: git fetch and a gated push/merge in one call are not allowed.';

// Recognize one intentionally small spelling: `git commit ... && git push
// [remote]` on one line, nothing else. A preceding command can change the
// branch or repository before the push, so the raw text constrains this
// exception as well as the analyzed invocations.
function isPlainCommitPush(text, analyzed) {
  if (/[\r\n;]/.test(text)) return false;
  const parts = text.trim().split('&&');
  if (parts.length !== 2) return false;
  if (!/^git[ \t]+commit(?:[ \t]|$)/.test(parts[0])) return false;
  if (!/^[ \t]*git[ \t]+push(?:[ \t]+[A-Za-z0-9_./:@][A-Za-z0-9_./:@-]*)?[ \t]*$/.test(parts[1])) return false;
  if (analyzed.length !== 1) return false;
  const a = analyzed[0];
  if (a.line.segments.length !== 2 || a.invocations.length !== 2 || a.cands.length !== 1) return false;
  const [commit, push] = a.invocations;
  return commit.sub === 'commit' && push.sub === 'push'
    && commit.globals.length === 0 && push.globals.length === 0
    && a.cands[0].kind === 'push' && a.cands[0].omittedRefspec;
}

// --------------------------------------------------------------------------
// Path sets
// --------------------------------------------------------------------------

// Harness config files that may carry a `### Quality Gate Overrides` block.
const GATE_CONFIG_PATTERNS = [/(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /^\.cursorrules$/];

// The gate's own control plane: the quality-check skill and its schemas, the
// review guides, the hooks and their registration. A diff touching any
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
// extra flag or a different remote needs a flag. The merge form also needs
// `origin/<trunk>` to BE the remote-tracking ref: a local tag or branch of
// that name is what git would merge instead, and a ctx that cannot say is no
// exemption.
const syncForms = (trunk) => [
  ['pull'], ['pull', 'origin', trunk], ['merge', `origin/${trunk}`],
  ['pull', '--ff-only'], ['pull', '--ff-only', 'origin', trunk], ['merge', '--ff-only', `origin/${trunk}`],
];
// `sole`: the whole command is this one segment. Anything next to it - even on
// another line - can create a ref named `origin/<trunk>` or re-point `origin`
// after this check has read them.
function isSyncForm(line, branch, ctx, sole) {
  if (!sole || line.segments.length !== 1) return false;
  const w = line.segments[0].words;
  if (w.length < 2 || w[0].toLowerCase() !== 'git') return false;
  const trunk = String(branch).toLowerCase();
  const rest = [w[1].toLowerCase(), ...w.slice(2)];
  const form = syncForms(trunk).find((f) => f.length === rest.length && f.every((x, i) => x === rest[i]));
  if (!form) return false;
  if (form[0] !== 'merge') return true;
  const source = form[form.length - 1];
  return typeof ctx.fullRef === 'function' && ctx.fullRef(source) === `refs/remotes/origin/${trunk}`;
}

// Rule 2, items 1-5: no ctx is touched, so these also block on a feature
// branch (deliberate over-detection, see the header). `commandMover` is the
// whole command's HEAD mover, computed once by the caller.
function staticRules(a, commandMover, deferCommit = false, deferFetch = null) {
  if (a.cands.length === 0) return null;
  for (const c of a.cands) {
    if (c.kind !== 'push') continue;
    if (c.neverExempt || c.hard) {
      return deny('2', 'Force, delete, --all, --branches and --mirror pushes are never allowed here. Push a plain refspec after a quality check.');
    }
    if (c.matching) {
      return deny('2', 'A push that writes every matching branch (a `:` refspec or one with no destination) is never allowed here. Push one branch with an explicit refspec, from that branch.');
    }
  }
  const mover = moverOf(a.invocations, 'line') || commandMover;
  if (mover && !deferCommit && !(deferFetch && mover === 'fetch')) {
    return deny('2', `Split this into separate commands: git ${mover} and a gated push/merge in one call are not allowed.`);
  }
  if (a.expansion) {
    return deny('2', 'Write refs without shell expansion (no %VAR% word and no word starting with ~).');
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
      const { src: written, dst } = facts[i];
      // `main` alone is `main:main`: it pushes the LOCAL main, which the flag
      // on this branch does not cover unless this branch is main.
      const src = written === null ? dst : written;
      // `HEAD` and `@` both name the current branch, in any case spelling.
      if (UPSTREAM_REFS.has(src.toLowerCase())) continue;
      if (src.replace(/^\+/, '').replace(/^(refs\/)?heads\//, '') === branch) continue;
      return deny('2', `Push from the branch itself: ${src}:${dst} pushes a branch other than the current one; only HEAD or the current branch can be pushed to the trunk here. Check out that branch and push from it.`);
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
function contextRules(a, ctx, deferCommit = false, deferFetch = null, sole = false) {
  const branch = ctx.branch;
  if (!branch) {
    // Includes a detached HEAD: an unresolved branch with a candidate blocks.
    return deny('5', 'Cannot verify the current branch. Check out a branch, then re-run the command.');
  }
  const gated = a.cands.filter((c) => !c.mainOnly || isMainBranch(branch));
  if (gated.length === 0) return allow();
  if (deferCommit) {
    return deny('2', 'Split this into separate commands: git commit and a gated push/merge in one call are not allowed.');
  }
  if (deferFetch && deferFetch.sub === 'merge') {
    // The trunk sync after a plain fetch (see `plainFetch`): only on that trunk,
    // and only when the merge source really is the remote-tracking ref - a
    // local tag or branch named `origin/<trunk>` is what git would merge
    // instead. A ctx that cannot answer is no exemption.
    const trunk = String(branch).toLowerCase();
    const target = syncTarget(a.cands[0]);
    const ok = isMainBranch(branch) && target !== null && target.trunk === trunk
      && deferFetch.trunks.every((t) => t === trunk)
      && typeof ctx.fullRef === 'function' && ctx.fullRef(target.source) === `refs/remotes/origin/${trunk}`;
    return ok ? allow() : deny('2', FETCH_SPLIT);
  }
  // A plain fetch and then `git rebase origin/<trunk>`: off the trunk it was
  // allowed above (a rebase is gated only on the trunk); on the trunk it is
  // judged like any other gated call, by the flag below.

  const reverse = reverseRefspec(gated, branch); // Rule 2 item 6, ahead of every exemption.
  if (reverse) return reverse;

  if (isMainBranch(branch) && isSyncForm(a.line, branch, ctx, sole)) return allow(); // Rule 3, sync form.

  const base = ctx.diffSinceBase;
  if (base === null) {
    return deny('5', 'Cannot verify what changed since origin/main. Re-run the quality-check skill.');
  }
  const baseControl = controlHits(base.files);
  if (rule4Exempt(base, baseControl)) return allow();
  return rule3Flag(ctx, baseControl);
}

// A command line the classifier will not read (over the byte budget, or a
// classifier exception) is judged on its gate words alone. Stripping quotes
// cannot undo an EXPANSION (`$'\x70'ush` is `push`, `${x}ush` may be
// anything), so a text still holding one of the expansion characters blocks
// whether or not a gate word is left visible.
const TOO_LONG = 'Command line too long to classify. Split the gated git/gh call into its own command.';
const UNCLASSIFIABLE = 'This command line could not be classified. Run the git/gh call as a single plain command.';
const EXPANDED = 'A shell expansion ($, backtick, brace or %) in a command line that cannot be classified could spell anything. Run the git/gh call as a single plain command without expansions.';
const HUGE_PAYLOAD = 'The hook payload is too large to read, so this command cannot be checked. Run the git/gh call as a single plain command.';
const EXPAND_CHARS_RE = /[$`{}%]/;
function gateWordFallback(text, reason) {
  if (gateWordIn(text)) return deny('2', reason);
  if (EXPAND_CHARS_RE.test(text)) return deny('2', EXPANDED);
  return allow();
}

// --------------------------------------------------------------------------
// Everyday forms that need not be refused
// --------------------------------------------------------------------------
// Output plumbing at the very END of the whole command - ` 2>&1`,
// ` >/dev/null`, ` 2>/dev/null`, and finally `| tail -N` / `| head -N` - is
// dropped before the command is parsed. Exactly these spellings, nowhere else.
const TRAILING_OUTPUT_RE = /(?:[ \t]+(?:2>&1|2?>\/dev\/null))*(?:[ \t]*\|[ \t]*(?:tail|head)[ \t]+-[1-9][0-9]{0,5})?[ \t\n]*$/;
function stripTrailingOutput(text) {
  return text.replace(TRAILING_OUTPUT_RE, '');
}

// Message values. A gate word that only appears in the message of
// `git commit|tag` or `gh pr|issue create|edit|comment|review` is not a push
// or a merge. Such a value is masked before the gate words are looked for
// when it is a literal both shells read the same way:
//   - a quoted string with no `$`, backtick, backslash, typographic quote
//     (U+2018-U+201E), CR or NUL, ending at a word boundary (so no `'a''b'`
//     or `"a""b"`, which PowerShell reads as one string and a POSIX shell as
//     two);
//   - `"$(cat <<'DELIM'` <LF> lines <LF> `DELIM` <LF> `)"`: a quoted
//     here-document, no line before the terminator starting with DELIM, no
//     CR (PowerShell refuses `<<` outright, so it never runs there);
//   - PowerShell's `@'` <LF> lines <LF> `'@` with no `'` in it (a POSIX shell
//     reads that as one literal word).
// A value that itself holds a git/gh word AND a gate word is not masked. The
// whole text must be read by this small grammar - plain words, literal quoted
// strings, separators - or nothing is masked. Masking only decides "no gate
// word at all, allow"; a command that still holds one is judged as written.
const MASK_OPTS = {
  git: { subs: [['commit'], ['tag']], opts: new Set(['-m', '--message']) },
  gh: {
    subs: ['pr', 'issue'].flatMap((n) => ['create', 'edit', 'comment', 'review'].map((v) => [n, v])),
    opts: new Set(['-t', '--title', '-b', '--body']),
  },
};
const LITERAL_RE = /^[^$`\\‘-„\r\0]*$/;
const GIT_GH_WORD_RE = /(?<![A-Za-z])(?:git|gh)(?![A-Za-z])/i;
const HEREDOC_HEAD_RE = /^"\$\(cat <<'([A-Za-z_][A-Za-z0-9_]*)'\n/;
const WORD_END = ' \t\n;&|';
function harmlessValue(content) {
  const plain = content.replace(LINE_CONTINUATION_RE, '').replace(ESCAPE_CHARS_RE, '');
  return !(GIT_GH_WORD_RE.test(content) || GIT_GH_WORD_RE.test(plain)) || !gateWordIn(content);
}
// A message value starting at `i`: `{ end, content }`, or null.
function messageValue(text, i) {
  const ends = (k) => k >= text.length || WORD_END.includes(text[k]);
  const head = HEREDOC_HEAD_RE.exec(text.slice(i));
  if (head) {
    const delim = head[1];
    const bodyStart = i + head[0].length;
    const lines = [];
    let k = bodyStart;
    for (;;) {
      const nl = text.indexOf('\n', k);
      if (nl === -1) return null;
      const line = text.slice(k, nl);
      if (line === delim) break;
      if (line.startsWith(delim) || /[\r\0]/.test(line)) return null;
      lines.push(line);
      k = nl + 1;
    }
    const close = text.indexOf('\n', k) + 1;
    if (text.slice(close, close + 2) !== ')"' || !ends(close + 2)) return null;
    return { end: close + 2, content: lines.join('\n') };
  }
  if (text.startsWith("@'\n", i)) {
    const close = text.indexOf("'", i + 2);
    if (close === -1 || text[close - 1] !== '\n' || text[close + 1] !== '@' || !ends(close + 2)) return null;
    const content = text.slice(i + 3, close - 1);
    if (/[\r\0]/.test(content)) return null;
    return { end: close + 2, content };
  }
  return null;
}
// A literal quoted string at `i`: `{ end, content }`, or null.
function literalString(text, i) {
  const q = text[i];
  const close = text.indexOf(q, i + 1);
  if (close === -1) return null;
  const content = text.slice(i + 1, close);
  if (!LITERAL_RE.test(content)) return null;
  if (close + 1 < text.length && !WORD_END.includes(text[close + 1])) return null;
  return { end: close + 1, content };
}
// The text with message values masked, or null when it cannot be read.
function maskMessages(text) {
  let out = '';
  let words = []; // The current segment's unquoted words so far.
  let i = 0;
  const optsFor = () => {
    const spec = MASK_OPTS[words[0]];
    if (!spec) return null;
    return spec.subs.some((sub) => sub.every((w, k) => words[k + 1] === w)) ? spec.opts : null;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      out += ch;
      i++;
    } else if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && text[i + 1] === '&')) {
      const len = (ch === '&' || (ch === '|' && text[i + 1] === '|')) ? 2 : 1;
      out += text.slice(i, i + len);
      i += len;
      words = [];
    } else if (ch === '"' || ch === "'" || text.startsWith("@'\n", i)) {
      const opts = optsFor();
      const isValue = opts !== null && words.length > 0 && opts.has(words[words.length - 1]);
      const v = (isValue && messageValue(text, i)) || (ch !== '@' && literalString(text, i));
      if (!v) return null;
      if (isValue && harmlessValue(v.content)) out += '"x"';
      else out += text.slice(i, v.end);
      words.push('"'); // A quoted word: never a command or option word.
      i = v.end;
    } else if (PLAIN_CHAR_RE.test(ch)) {
      let w = '';
      while (i < text.length && PLAIN_CHAR_RE.test(text[i])) w += text[i++];
      if (i < text.length && !WORD_END.includes(text[i])) return null;
      out += w;
      words.push(w);
    } else {
      return null;
    }
  }
  return out;
}

const notSimpleReason = (why) => `This command mentions push, pull, merge or rebase but is not in the simple form the quality gate can judge (${why}), so run the git/gh push or merge as a separate command - optionally after \`cd <path>\` or as \`git -C <path>\` - with forward slashes and without variables, special characters in quotes, or other shell constructs. A command that does not push or merge should avoid those words (for a commit message, use git commit -F <file>).`;

// --------------------------------------------------------------------------
// Where each gated call runs (#158)
// --------------------------------------------------------------------------
// A location change on an earlier segment, or `-C <path>` on the call itself,
// changes the repository a gated call writes to. The segments are walked in
// order from the payload cwd. A location is `null` (not moved) or a resolved
// `{ logical, physical }` pair; a target that does not exist now, or whose
// logical `..` and physical path disagree (a symlink), is UNRESOLVED and a
// gated call after it blocks.
//
// The walk keeps every READING the text allows - at most MAX_STATES of them,
// each with its own directory, pushd stack and the repositories its gated
// calls landed in - and a gated call must pass in each one:
//   - a PowerShell-only spelling (`Set-Location`, `sl`, `chdir`, `CD`, ...)
//     is "command not found" to a POSIX shell, so it forks a reading where
//     the directory stays;
//   - inside an `&&` chain a later segment runs only after the earlier ones
//     succeeded, so it sees the location after them; but once the chain
//     ends, any command in it that could fail (anything but a location change,
//     whose target exists) may have stopped it early, so the next segment
//     may run in any location the chain passed through.
// git's `-C` is held to the same rule as `cd`: git chdir()s, which is the
// physical path on POSIX, but on Windows git and PowerShell resolve `..`
// lexically on the apparent path, so `-C <link>/..` (or `-C ..` after a `cd`
// into a link) lands somewhere else there. Where the two readings disagree,
// the target is UNRESOLVED.
// Moves after the last candidate are not followed. Only the filesystem is
// read here (existence, real path), never git.
const UNRESOLVED = Object.freeze({ unresolved: true });

// Follow `arg` from `from` the way the kernel does: component by component,
// each one resolved to its real path, `..` taken from the real parent.
// Returns the directory, or null when a component is missing or not one.
const PATH_SEPARATORS = IS_WIN ? /[\\/]+/ : /\/+/;
function physicalWalk(from, arg) {
  let cur = from;
  let rest = arg;
  if (path.isAbsolute(arg)) {
    const root = path.parse(arg).root;
    cur = fs.realpathSync.native(path.resolve(root));
    rest = arg.slice(root.length);
  }
  for (const comp of rest.split(PATH_SEPARATORS)) {
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, comp);
    if (!fs.existsSync(next)) return null;
    cur = fs.realpathSync.native(next);
    if (!fs.statSync(cur).isDirectory()) return null;
  }
  return fs.statSync(cur).isDirectory() ? cur : null;
}

// One move from a resolved location, or null (unresolved): the lexical and
// the physical reading of `target` must name the same directory.
function changeDir(from, target) {
  try {
    const physical = physicalWalk(from.physical, target);
    if (physical === null) return null;
    const lg = path.resolve(from.logical, target);
    if (fs.realpathSync.native(lg) !== physical) return null;
    return { logical: lg, physical };
  } catch {
    return null;
  }
}

function originOf(ctx) {
  const cwd = ctx.cwd;
  if (typeof cwd !== 'string' || cwd === '' || /^[\\/]{2}/.test(cwd)) return UNRESOLVED;
  try {
    const logical = path.resolve(cwd);
    return { logical, physical: fs.realpathSync.native(logical) };
  } catch {
    return UNRESOLVED;
  }
}

// A move applied to one reading: the new reading, or null (unresolved).
function applyMove(state, move, start) {
  if (move.op === 'pop') {
    if (state.stack.length === 0) return null;
    return { ...state, here: state.stack[state.stack.length - 1], stack: state.stack.slice(0, -1) };
  }
  const from = state.here || start();
  if (from === UNRESOLVED) return null;
  const next = changeDir(from, move.path);
  if (next === null) return null;
  return { ...state, here: next, stack: move.op === 'push' ? [...state.stack, state.here] : state.stack };
}

// The candidate's effective directory in one reading: its segment's location,
// then each `-C` of the call in order.
function candidateLocation(cand, state, start) {
  let here = state.here;
  for (const p of cand.inv ? cand.inv.chdirs : []) {
    const from = here || start();
    if (from === UNRESOLVED) return UNRESOLVED;
    here = changeDir(from, p);
    if (here === null) return UNRESOLVED;
  }
  return here;
}

const stateKey = (s, ids) => [
  s.here ? s.here.physical : '',
  ...s.stack.map((d) => (d ? d.physical : '')),
  '|', ...[...s.repos].map((r) => ids.get(r)),
].join('\0');

const UNRESOLVED_MOVE = 'Run git from the target repository directory as a separate command: a cd/pushd/Set-Location/-C target must be a local directory that exists now (and no symlink under ..) before a gated push/merge.';
const NOT_A_WORK_TREE = 'The directory this push/merge would run in is not inside a git work tree. Run git from the target repository directory as a separate command.';
const TARGET_GIT_FAILED = 'Cannot read the repository this push/merge would run in (git failed or timed out). Run git from the target repository directory as a separate command.';
const MULTI_REPO = 'Run gated operations for one repository per command: split the push/merge for each repository into its own command.';

// A verdict decided somewhere other than the payload cwd's repository carries
// `elsewhere: true`: it must not ride rule 5's "cwd is not a git work tree"
// fail-open, which is about the payload cwd alone.
const elsewhere = (verdict) => ({ ...verdict, elsewhere: true });

// The (line, ctx) pairs to judge, or a block. Every candidate line holds
// exactly one candidate here (rule 2 already blocked more than one). A ctx is
// made once per directory and shared per toplevel, so each repository's git
// state is read once per command.
function locateCandidates(lines, candLines, ctx) {
  const segs = lines.flatMap((line) => line.segments);
  const candAt = new Map(); // segment -> its line's analysis
  for (const a of candLines) candAt.set(a.cands[0].inv ? a.cands[0].inv.seg : a.cands[0].seg, a);
  let lastIndex = 0;
  segs.forEach((seg, i) => {
    if (candAt.has(seg)) lastIndex = i;
  });
  let origin;
  const start = () => {
    if (origin === undefined) origin = originOf(ctx);
    return origin;
  };
  const byDir = new Map();
  const byTop = new Map();
  const ids = new Map([[ctx, 0]]);
  const placed = new Map(); // line -> Map(ctx -> moved)

  // Where one reading's candidate is judged: a ctx and whether it moved, or a block.
  const judgeFor = (a, state) => {
    const loc = candidateLocation(a.cands[0], state, start);
    if (loc === UNRESOLVED) return elsewhere(deny('2', UNRESOLVED_MOVE));
    if (loc === null || (start() !== UNRESOLVED && start().physical === loc.physical)) return { ctx, moved: false };
    if (typeof ctx.at !== 'function') return elsewhere(deny('2', UNRESOLVED_MOVE));
    if (!byDir.has(loc.physical)) byDir.set(loc.physical, ctx.at(loc.physical));
    const there = byDir.get(loc.physical);
    const top = there.toplevel;
    if (!top) {
      const failed = there.state && there.state.failure === 'git-error';
      return elsewhere(deny('2', failed ? TARGET_GIT_FAILED : NOT_A_WORK_TREE));
    }
    if (top === ctx.toplevel) return { ctx, moved: false };
    if (!byTop.has(top)) {
      byTop.set(top, there);
      ids.set(there, ids.size);
    }
    return { ctx: byTop.get(top), moved: true };
  };

  let states = [{ here: null, stack: [], repos: new Set() }];
  let exits = []; // Readings the current `&&` chain may have stopped in.
  const settle = (list) => {
    const seen = new Map();
    for (const s of list) seen.set(stateKey(s, ids), s);
    if (seen.size > MAX_STATES) return null;
    return [...seen.values()];
  };
  for (let i = 0; i <= lastIndex; i++) {
    const seg = segs[i];
    if (seg.before !== '&&') {
      states = settle([...exits, ...states]);
      exits = [];
      if (!states) return elsewhere(deny('2', UNRESOLVED_MOVE));
    }
    const a = candAt.get(seg);
    if (a) {
      const next = [];
      for (const s of states) {
        const j = judgeFor(a, s);
        if (j.decision) return j;
        if (!placed.has(a)) placed.set(a, new Map());
        placed.get(a).set(j.ctx, j.moved);
        const repos = new Set(s.repos).add(j.ctx);
        if (repos.size > 1) return elsewhere(deny('2', MULTI_REPO));
        next.push({ ...s, repos });
      }
      states = next;
    }
    if (seg.kind !== 'move') {
      exits.push(...states); // It may fail and end the chain here.
      continue;
    }
    const next = [];
    for (const s of states) {
      const moved = applyMove(s, seg.move, start);
      if (moved === null) return elsewhere(deny('2', UNRESOLVED_MOVE));
      next.push(moved);
      if (!seg.move.posix) next.push(s); // A POSIX shell does not run it.
    }
    states = settle(next);
    if (!states) return elsewhere(deny('2', UNRESOLVED_MOVE));
  }
  const out = [];
  for (const [a, ctxs] of placed) for (const [judge, moved] of ctxs) out.push({ a, ctx: judge, moved });
  return out;
}

// Pure classifier: it only READS `ctx`, through lazy getters, and a command
// with no rule-1 candidate never touches it at all. Beyond ctx it reads the
// filesystem - existence and real paths - to place a location change or a
// `-C` target, and only when one precedes a candidate.
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
//   cwd           the payload cwd (absolute path) - where the location walk
//                 starts. Missing: every move is UNRESOLVED.
//   toplevel      real path of the work tree root, or null when there is none
//                 or git failed.
//   at(dir)       a ctx of this same shape for another directory (a real
//                 path), used when a move lands outside this toplevel.
//                 Its optional `state.failure` ('git-error') tells a git
//                 failure there apart from "not a work tree" in the reason.
//   fullRef(name) the full ref name git reads `name` as, or null when it
//                 cannot say (ambiguous, missing, git failed). Read only for
//                 the trunk sync forms; anything but the remote-tracking ref -
//                 or a ctx without this method - is no exemption.
// Only `flag` uses null to mean "nothing there"; for every other getter null
// means the repository state could not be resolved, and rule 5 blocks. WHICH
// git call failed is recorded on `ctx.state` by the getters themselves, never
// by classify, and is read only by `main()`, which turns the single "not inside
// a git repository" case into a fail-open.
function classify(command, ctx) {
  const text = String(command || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) return gateWordFallback(text, TOO_LONG);
  if (!gateWordIn(text)) return allow();
  const body = stripTrailingOutput(text);
  const masked = maskMessages(body);
  if (masked !== null && !gateWordIn(masked)) return allow(); // Only in a message.
  let lines;
  try {
    lines = parseSimple(body);
  } catch (e) {
    if (e instanceof NotSimple) return deny('2', notSimpleReason(e.message));
    throw e;
  }
  const analyzed = lines.map(analyzeLine);
  const all = analyzed.flatMap((a) => a.invocations);
  // The HEAD movers are judged over the whole command, so this answer is the
  // same for every line: compute it once.
  const commandMover = moverOf(all, 'command');
  const deferCommit = commandMover === 'commit' && isPlainCommitPush(body, analyzed);
  const candLines = analyzed.filter((a) => a.cands.length > 0);
  const fetchOnly = commandMover === 'fetch' ? fetchOnlyMovers(all) : null;
  const target = candLines.length === 1 && candLines[0].cands.length === 1 ? syncTarget(candLines[0].cands[0]) : null;
  const deferFetch = fetchOnly && target && isPlainTrunkSync(body, lines) ? { ...fetchOnly, sub: target.sub } : null;
  // The sync forms (rule 3) need the WHOLE command to be that one segment.
  const sole = lines.length === 1 && lines[0].segments.length === 1;
  for (const a of analyzed) {
    const verdict = staticRules(a, commandMover, deferCommit, deferFetch);
    if (verdict) return verdict;
  }
  if (candLines.length === 0) return allow();
  const placed = locateCandidates(lines, candLines, ctx);
  if (!Array.isArray(placed)) return placed;
  for (const p of placed) {
    const verdict = contextRules(p.a, p.ctx, deferCommit, deferFetch, sole);
    if (verdict.decision === 'block') return p.moved ? elsewhere(verdict) : verdict;
  }
  return allow();
}

// --------------------------------------------------------------------------
// ctx resolution (the only place git runs)
// --------------------------------------------------------------------------

// Every git call turns off the programs a repository's own configuration can
// make git run: the fsmonitor hook here, and the external diff driver and
// textconv filters on each diff below. A `cd` / `-C` target is another
// repository, read before the user has approved anything, and its config must
// not get to execute code through the gate.
const SAFE_GIT = ['-c', 'core.fsmonitor=false'];
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];
// No network either: in a partial clone a diff that needs a missing blob
// would fetch it from the promisor remote (a stall, and a request the user
// never approved), and a credential prompt would wait for input that never
// comes. A missing object is a git failure, which blocks.
const GIT_ENV = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };

function runGit(args, cwd) {
  const budget = DEADLINE - Date.now();
  if (budget <= 0) return { ok: false, out: '', err: 'deadline exceeded' };
  try {
    const out = execFileSync('git', [...SAFE_GIT, ...args], {
      cwd,
      env: GIT_ENV,
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
    const r = git(['diff', ...SAFE_DIFF, '--name-only', '-z', '--no-renames', range]);
    if (!r.ok) return fail('git-error');
    const files = r.out.split('\0').filter((f) => f !== '');
    const configs = gateConfigFiles(files);
    let overrideChanged = false;
    if (configs.length > 0) {
      const d = git(['diff', ...SAFE_DIFF, '-U0', '--no-renames', range, '--', ...configs]);
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
      // A regular file of a sane size only: a symlink, a FIFO or a huge file
      // in a repository the hook was moved into is no flag, not a stall.
      const file = path.join(top, FLAG_FILE);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FLAG_BYTES) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
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
    cwd,
    get toplevel() {
      return once('toplevel', () => {
        const top = root();
        if (top === null) return null;
        try {
          return fs.realpathSync.native(top);
        } catch {
          return fail('git-error');
        }
      });
    },
    // A fresh ctx for another directory: its own git calls, its own state.
    // Rule 5's fail-open reads only the payload ctx's state, never this one.
    at(dir) {
      return makeCtx(dir);
    },
    // The full ref name git reads `name` as (a tag or local branch named
    // `origin/main` wins over the remote-tracking ref), or null on failure.
    fullRef(name) {
      return once(`ref:${name}`, () => {
        const r = git(['rev-parse', '--symbolic-full-name', name]);
        return r.ok ? r.out.trim() || null : null;
      });
    },
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
      // Windows producers may prefix JSON with a UTF-8 BOM. Strip only that
      // leading marker so valid payloads do not enter the malformed fail-open.
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
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
    if (ctx.state.failure === 'not-a-repo' && !verdict.elsewhere) {
      // Rule 5, fail-open #2 - for the payload cwd only: a block decided in
      // the directory a `cd` / `-C` moved to stands (#158).
      process.stderr.write('quality-gate: not inside a git repository; skipping\n');
      return;
    }
    emitBlock(verdict.reason);
  });
}

module.exports = { classify, parseSimple };

if (require.main === module) main();
