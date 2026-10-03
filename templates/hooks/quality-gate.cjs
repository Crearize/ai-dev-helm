#!/usr/bin/env node
'use strict';

// PreToolUse hook: forbid direct push / merge into main (or master) unless a
// quality check passed. That single sentence is the whole requirement.
//
// THREAT MODEL: the gate stops an AI agent's ORDINARY mistakes - a push or
// merge into main without the quality check, a push run in the wrong
// repository, the local main pushed from a feature branch. Work always starts
// from an issue and a branch, and a push that does get through is recoverable
// with a revert, so the gate is insurance, not a boundary. A command built on
// purpose so that the gate cannot read it is OUT OF SCOPE, and nothing here
// defends against one. Out of scope, among others:
//   - spelling: a gate word or `powershell` written with expansions, escapes,
//     brace expansion, encodings or Unicode lookalikes;
//   - indirection: a script or `-File`, `eval` / `Invoke-Expression`, another
//     language's inline code, a variable, `xargs`, a function;
//   - git without the words: `git send-pack`, a mistyped command that
//     `help.autocorrect` runs, an existing git or shell alias;
//   - other GitHub APIs: `gh api` calls other than `pulls/<n>/merge` (ref
//     updates, `graphql`), `gh repo sync`, another repository's PR named by
//     a URL or `GH_REPO` (`-R` / `--repo` is read - H-19(a));
//   - build steps: a push inside an npm script, a Gradle task and the like;
//   - configuration: `remote.<name>.push`, `push.default = matching` (a
//     refspec-less push's `@{push}` is read - H-19(d)); a trunk ref moved by
//     anything but the two rewrite forms of rule 1 (`git update-ref`, `git branch -M`, `.git/refs` written
//     directly, an `origin` re-pointed with `git remote set-url`);
//   - timing: a directory or link that changes after this check.
//
// HOW A COMMAND IS READ (#158). The same text may run under a POSIX shell (Git
// Bash on Windows) or under PowerShell. The payload's `tool_name` says which
// (`shellOf`: `PowerShell` -> PowerShell, `Bash` -> POSIX); then the text is
// read the way that shell runs it, and when the hook cannot tell, only forms
// both shells read the same way are accepted. Either way it reads an
// ALLOWLISTED form:
//   1. A command with no gate word - `push`, `pull`, `merge` or `rebase` as a
//      whole word, looked for in the raw text and again with `"` `'` `\`
//      backtick `^` `$` removed and line continuations folded (`gateWordIn`) -
//      is allowed at once. No git runs, nothing is parsed. So is one whose gate
//      words are all inside a literal message value (`maskMessages`). The
//      exception is a trunk rewrite (`trunkWriteIn`: `branch`
//      or `fetch` with `main` / `master` in the text): it is parsed too, and
//      allowed when it is not simple.
//   2. A command WITH a gate word is judged only when it is SIMPLE
//      (`parseSimple` / `checkSegment`). Anything else is refused with
//      guidance: run the push/merge as its own simple command.
//   3. A simple command is judged on its merits: candidates (rule 1), rule 2,
//      the directory each candidate runs in, then that repository's flag.
//
// SIMPLE means all of:
//   - Characters. Outside quotes only ASCII letters and digits, space, tab,
//     newline and `. _ / - : @ = + ~ %`, with `;` and `&&` as separators. A
//     single- or double-quoted string is a whole word (or follows `name=`), is
//     not empty (Windows PowerShell drops an empty argument), and holds only
//     those characters, `, ; &`, and non-ASCII letters, digits and CJK
//     punctuation. So no `$`, backtick, `|`, `<`, `>`, parentheses, braces,
//     brackets, `#`, `*`, `?`, `!`, `^`, nested quotes, a lone CR or NUL, and
//     no unquoted `,` (an array in PowerShell). A backslash only where the
//     known shell reads it as itself: inside quotes when the shell is known
//     (not `\\` or a line-end `\` inside POSIX double quotes), and outside
//     quotes in PowerShell. A CRLF line end is read as LF. Output plumbing at
//     the very end of the whole command (`stripTrailingOutput`) is dropped
//     first. In PowerShell, `A; if ($?) { B }` - B one command with no braces,
//     `;`, `&`, `|`, `$`, backtick or line break, no `else` after it - is read
//     as `A && B` (`readPsIfOk`).
//   - Segments are split on newline, `;` and `&&` only (`||`, `|` and a single
//     `&` are not simple). `&&` at the end of a line continues on the next.
//   - Each segment starts with an unquoted command word from a closed list:
//     `git`, `gh`, a build/test runner (RUNNERS), case-insensitive, or a
//     location change - `cd`, `pushd`, `popd` in lower case, and in
//     PowerShell also `Set-Location` / `sl` / `chdir` / `Push-Location` /
//     `Pop-Location` in any case (elsewhere they are refused, naming the
//     equivalent). No `NAME=value` prefix.
//   - `git`: global options are `-C <path>` (also attached, `-C<path>`) and
//     `--no-pager` only - no `-c`, `--git-dir`, `--work-tree`, `--exec-path`,
//     `--namespace`, `--super-prefix`, `--config-env` or anything else. The
//     subcommand is from GIT_SUBCOMMANDS (so no `config`, no alias) and carries
//     no option that makes git run a command string (`runsCommand`).
//     `gh`: the subcommand is from GH_SUBCOMMANDS (no `alias`, no extension).
//     A runner: no gate word in its arguments (`npx -c "git push"`).
//     A location change: exactly one path (in PowerShell optionally after
//     `-Path` / `-LiteralPath`); `popd` none.
//   - In `git` / `gh` words: no unquoted single-dash option carrying anything
//     but letters, digits, `_` and `-` (PowerShell splits `-o:main` into `-o:`
//     and `main`), no word starting with `@` (splatting), no `--%`.
//   - A path (`checkPath`) is relative, or absolute with `/` (`C:/…` or, where
//     the backslash is read as itself, `C:\…` on Windows; Git Bash's `/c/…` is
//     read as `C:/…` in the POSIX reading and refused with that guidance
//     elsewhere); never a network path (`//host`, `\\host`), drive-relative (`C:x`),
//     drive-less absolute on Windows, `~…`, `-…`, `+…`, or holding `%`. With
//     CDPATH set in the hook's environment a `cd` / `pushd` target must
//     start with `/`, `./` or `../`.
//
// Rule 1 (gated candidates): `gh pr merge` (any args); `gh api` with a
//   `pulls/<n>/merge` word, case insensitive; `git merge` / `git pull` /
//   `git rebase` (any args, except --abort/--continue/--quit/--skip) - gated
//   only once ctx says the current branch is main/master; `git push` whose
//   refspec DESTINATION is exactly `main`/`master` (after stripping `+` and
//   `refs/heads/`, case insensitive; `--delete <ref>` counts as a
//   destination), or a push with no refspec at all - or a bare `HEAD`/`@`,
//   which is the same thing written out - (gated only on main/master, or off
//   them when the refspec is omitted and the branch's `@{push}` is
//   `<remote>/main|master` - H-19(d)); a push that writes every matching
//   branch (`--all`, `--branches`, `--mirror`, a refspec with no destination
//   such as `:`) on any branch. Trunk rewrites, on any branch (H-13, H-19(c)):
//   `git branch -f|--force <trunk> [<start>]`,
//   `git fetch <remote> [+]<src>:<trunk>` - each alone
//   in its command, with no other gated call.
//   Substring matches never count: `feature/main-nav` and `main:feature-x` are
//   not candidates. A refspec carrying `%` or a leading `~` is a candidate
//   because its destination cannot be read.
// Rule 2 (blocked with no exemption): an unreadable PowerShell script (see
//   ALWAYS REFUSED - gate word or not); a command with a gate word that is not
//   simple; force/delete/`+refspec`/`--mirror`/`--all`/`--branches` pushes
//   (short bundles such as `-fu` and long abbreviations such as `--forc`
//   included) - except a push whose only such flag is `--force-with-lease`
//   written out, to the branch's own upstream (no refspec or HEAD): that is
//   judged with the branch, allowed off the trunk and always refused on it;
//   a git command from the mover set (commit, reset, checkout,
//   switch, cherry-pick, rebase, revert, am, bisect, update-ref, stash
//   pop|apply, fetch, and on the same line branch -f|-d|-D|--force) other than
//   the gated call itself - the set is CLOSED, so status, add, log, diff, tag,
//   remote, restore, ... may share the command; `%` or a leading `~` in a word
//   of a line that holds a candidate, except the value of gh's free-text
//   options (`-t`/`--subject`, `-b`/`--body`, `-F`/`--body-file` and their `=`
//   spellings); a directory the location walk cannot place, one outside any
//   git work tree, or candidates in two repositories (see "Where each gated
//   call runs"); more than one gated operation on a line; a push that writes
//   every matching branch; a trunk-bound refspec whose source is neither
//   HEAD/`@` nor the current branch (`<x>:main`, and `main` / `refs/heads/main`
//   alone, which push the LOCAL main, off main).
//   The movers that move HEAD or make a commit, and `fetch` (it rewrites the
//   ref a later merge reads), are judged over the WHOLE command;
//   `branch -f|-d|-D|--force` per line. The one fetch let through is the
//   daily trunk sync - plain `git fetch [origin] [<trunk>]` and then
//   `git merge [--ff-only] origin/<trunk>` on that trunk - as the WHOLE command
//   with nothing else in it (`isPlainTrunkSync`), and only while
//   `origin/<trunk>` resolves to the remote-tracking ref; the same shape with
//   `git rebase origin/<trunk>` lets the rebase be judged as usual. The one
//   commit let through is on a feature branch: `git add` / `git commit` and
//   then a push to the branch's own upstream (`git push [options] [remote]
//   [HEAD]`) as the last command, and nothing else (`isPlainCommitPush`).
//   With no location change or git global option in the command, these
//   movers are judged with the branch instead (`deferralPlan`): plain fetches
//   next to `git merge|rebase origin/<trunk>` and refspec-less pushes, off the
//   trunk, with any other command around them; `git checkout -b <x>` /
//   `git switch -c <x>` chained by `&&` to pushes of HEAD (they land on <x>);
//   and the trunk sync below with `git checkout|switch <trunk> &&` before it
//   and `&& git branch -d <x>` after it. Several gated calls may share a line
//   when all of them are refspec-less pushes and sync merges / rebases (off
//   the trunk none of them is gated).
// Rule 3 (pass): `.quality-check-passed` at the repo root with `commit` an
//   abbreviated prefix of (or equal to) HEAD (`branch` is diagnostic only), or
//   `commit` an ancestor of HEAD whose `commit..HEAD` diff is harness files
//   only. On the trunk, `git merge|rebase <src>` (one source, no `--onto`) and
//   the trunk rewrites are judged against the commit the trunk RECEIVES, not
//   HEAD (H-11, `judgeTrunkMove`): allowed when it is origin's trunk, already
//   in the trunk, or a fast-forward whose new commits are harness files only
//   or are covered by the flag (the flag names it, or an ancestor with a
//   harness-only diff); a trunk with commits the source lacks is refused. A
//   `git pull` on the trunk from anything but its upstream / `origin <trunk>`
//   is refused (fetch, then merge). A fetch into the trunk from a remote is
//   allowed only as `origin <trunk>:<trunk>`; a delete or `+` force never.
//   `gh` with `-R` / `--repo` naming another repository than origin's (or
//   with no origin) is refused: run it from that repository. Plus the closed set of sync forms on the CURRENT trunk (or the trunk
//   the command checks out first): `git pull`, `git pull origin <trunk>`,
//   `git merge origin/<trunk>`, each also with one `--ff-only`, and
//   `git pull --rebase` while the local trunk has no commit origin's lacks -
//   exact word sequences, as the WHOLE command apart from the checkout and
//   `git branch -d` above (another line could create the ref the form reads);
//   the merge form only while `origin/<trunk>` resolves to the remote-tracking
//   ref (a local tag or branch of that name is what git would merge instead).
// Rule 4 (exemption): a non-empty `<base>...HEAD` diff made up entirely of
//   harness files - the three config files and the `.md` / `.mdc` documents
//   under the harness directories (H-47). `<base>` is the first of
//   origin/main, origin/master, main, master that exists (H-13: the local
//   trunk only without a remote-tracking one; quality-context uses the same). Gate control-plane paths and `Quality Gate Overrides` /
//   `mutation_budget_minutes` string changes are carved out of both rule 3
//   and rule 4 (no validity analysis of the declaration - over-detection is
//   fine). The control plane is the quality-check / test-recommendation skills
//   and their schemas, the brainstorming / writing-plans skills (Design
//   Gate), the review guides, and - under `.claude`, `.codex` or `.cursor` -
//   `hooks/`, the `skills` node itself, `agents/`, `commands/`, `prompts/`,
//   `rules/`, plus the hook's registration files (see GATE_CONTROL_PATTERNS,
//   which is the authority).
// Rule 5 (fail-open, exactly twice): a payload whose `tool_input.command` is
//   not a string (malformed JSON, a missing field) - unless `tool_name` is a
//   shell tool (`Bash`, `PowerShell`): a shell call whose command cannot be
//   read is refused (H-52(5)) - and a PAYLOAD cwd that is
//   not inside a git work tree - decided by rev-parse's EXIT STATUS, never by
//   its (localized) message. The second one is about the payload cwd only: a
//   block decided where a `cd` / `-C` moved the call stands even when the cwd
//   is not a repository, and a refusal of a command that is not simple never
//   reads git at all, so it stands too. Any other git failure or timeout on a
//   command with a candidate blocks. Both fail-opens write their reason to
//   stderr, so a hook that has stopped gating is visible rather than silent.
// Rule 6 (output): a block prints both the legacy `decision: "block"` with its
//   `reason` and `hookSpecificOutput.permissionDecision: "deny"` with the same
//   reason (`emitBlock`); an allow prints nothing. Every reason says what to
//   run next.
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
// outside the plans above is evaluated before the branch is known, so it also
// blocks on a feature branch; a detached HEAD is an UNRESOLVED branch;
// `git push --force` with no refspec blocks anywhere. A block decided in
// another repository names that repository and its branch (`judgedThere`).
//
// NESTED SHELLS (H-52). `powershell` / `pwsh` / `cmd` / `bash` are not in the
// closed list of command words, so a shell nested in the command string
// (`powershell -Command "..."`, `pwsh -c '...'`, `cmd /c "..."`,
// `bash -lc "..."`) is never simple: when a gate word is visible anywhere in
// it, it is refused with the same guidance, whatever the branch and the flag
// (`powershell -Command "git push origin main"` with a flag on HEAD is
// refused; run `git push origin main` itself).
//
// ALWAYS REFUSED (`alwaysDeny`, checked before the gate words, so with or
// without one): a PowerShell script the gate cannot read. The text is read
// once - in lower case, with quote characters and line continuations removed,
// cut into words at blanks and at `; & | ( )` - and refused when a
// `powershell` / `pwsh` word (any path, optional `.exe`) is followed in the
// same command by an encoded-command parameter (`-e`, `-ec`, `-en` ...
// `-encodedcommand`, also after `--` or `/`) or by `-command -` / `-c -` (a
// script read from standard input). A message or a search term that mentions
// such a parameter after the name is refused too; rerun it without them.
//
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
// The second screen (H-13, H-19(c)): `git branch -f` and `git fetch` move the trunk without a gate word. A command
// holding one of those words and a trunk name is parsed too; when it is not simple it is
// allowed (only an ordinary, simple trunk rewrite is judged).
const TRUNK_WRITE_RE = /(?<![A-Za-z-])(?:branch|fetch)(?![A-Za-z-])/i;
const TRUNK_NAME_RE = /(?<![A-Za-z0-9_-])(?:main|master)(?![A-Za-z0-9_-])/i;
const trunkWriteIn = (text) => TRUNK_WRITE_RE.test(text) && TRUNK_NAME_RE.test(text);

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

const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'gradle', 'gradlew', './gradlew', 'mvn', './mvnw']);
// A location change, in the exact lower-case spelling both shells run. Bash
// builtins are case-sensitive, so every other spelling (`Set-Location`, `sl`,
// `chdir`, `CD`, ...) moves in PowerShell only, and where the push would run
// would depend on the shell: not simple.
const MOVE_WORDS = new Map([['cd', 'cd'], ['pushd', 'push'], ['popd', 'pop']]);
const PS_MOVE_RE = /^(cd|chdir|sl|set-location|pushd|push-location|popd|pop-location)$/i;
// ...which, read as PowerShell (the shell is known), are moves like these.
const PS_MOVE_OPS = new Map([
  ['cd', 'cd'], ['chdir', 'cd'], ['sl', 'cd'], ['set-location', 'cd'],
  ['pushd', 'push'], ['push-location', 'push'], ['popd', 'pop'], ['pop-location', 'pop'],
]);
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

// The shell the command runs in, from the payload's `tool_name` (`shellOf`):
// 'powershell' for the PowerShell tool, 'posix' for Bash (Claude Code's Git
// Bash, Codex's Bash), null when the hook cannot tell - then every form must
// mean the same thing to both shells. Set by `classify` / `parseSimple` for
// the duration of one synchronous call.
let reading = null;
function shellOf(toolName) {
  const tool = String(toolName || '').replace(/^.*\./, '');
  if (tool === 'PowerShell') return 'powershell';
  if (tool === 'Bash') return 'posix';
  return null;
}

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
      // PowerShell reads `\` outside quotes as an ordinary character
      // (`cd C:\work`); a POSIX shell drops it, so there it is not simple.
      const plain = (c) => PLAIN_CHAR_RE.test(c) || (c === '\\' && reading === 'powershell');
      let word = '';
      while (i < text.length && plain(text[i])) word += text[i++];
      const bare = word; // The unquoted part.
      let quoted = false;
      if (text[i] === '"' || text[i] === "'") {
        if (word !== '' && !word.endsWith('=')) notSimple('a quote inside a word');
        const close = text.indexOf(text[i], i + 1);
        if (close === -1) notSimple('an unterminated quote');
        const body = text.slice(i + 1, close);
        if (body === '') notSimple('an empty quoted argument');
        for (const c of body) {
          // A quoted `"C:\work"` reads the same in both shells once the shell
          // is known; only a POSIX double-quoted `\\` (one `\`) and `\` at a
          // line end (a continuation) read differently, so they are refused.
          if (c === '\\' && reading !== null) continue;
          if (!QUOTED_CHAR_RE.test(c)) notSimple(`\`${describe(c)}\` inside quotes`);
        }
        if (reading === 'posix' && text[i] === '"' && /\\(\\|\n)/.test(body)) notSimple('`\\\\` or a line continuation inside double quotes');
        word += body;
        quoted = true;
        i = close + 1;
      }
      if (text[i] === '\\') notSimple(reading === 'posix'
        ? 'an unquoted backslash - quote a Windows path ("C:\\work") or write it with `/` (C:/work)'
        : 'a backslash outside quotes - write a path with `/` (C:/work)');
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
// (`''` at the start of a line, `;`, `&&`) and after it. `shell`: read the
// text as that shell runs it (see `reading`); omitted, the current reading.
function parseSimple(text, shell) {
  if (shell === undefined) return parseLines(text);
  const saved = reading;
  reading = shell;
  try {
    return parseLines(text);
  } finally {
    reading = saved;
  }
}
function parseLines(text) {
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

// A path a location change (`move`) or `-C` may name. Returns it, or refuses.
// On Windows a path is relative or starts with a drive (`C:/…`, `C:\…`); Git
// Bash's `/c/…` is read as `C:/…` when the shell is known to be Git Bash.
const GIT_BASH_DRIVE_RE = /^\/([A-Za-z])(?=\/|$)/;
function checkPath(p, move) {
  if (/^[~+-]/.test(p) || p.includes('%')) notSimple(`the path \`${p}\``);
  if (/^[\\/]{2}/.test(p)) notSimple('a network path');
  if (IS_WIN) {
    const drive = GIT_BASH_DRIVE_RE.exec(p);
    if (drive && reading === 'posix') {
      p = `${drive[1].toUpperCase()}:/${p.slice(3)}`;
    } else if (drive) {
      notSimple(`the Git Bash path \`${p}\` - write it as \`${drive[1].toUpperCase()}:/${p.slice(3)}\``);
    } else if (/^[\\/]/.test(p)) {
      notSimple('an absolute path without a drive letter');
    }
    if (p.includes(':') && !/^[A-Za-z]:[\\/][^:]*$/.test(p)) notSimple(`the path \`${p}\``);
  } else if (p.includes(':')) {
    notSimple(`the path \`${p}\``);
  }
  // bash looks a bare name up in CDPATH before the current directory.
  if (move && reading !== 'powershell' && process.env.CDPATH && !CDPATH_SAFE_RE.test(p)) notSimple(`a bare \`cd\` name while CDPATH is set - write \`cd ./${p}\``);
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
    // PowerShell's stop-parsing token. Unquoted, it passes the rest of the
    // line on verbatim (quotes left in, `%VAR%` expanded); quoted, Windows
    // PowerShell still honours it but parses the rest as usual and passes the
    // arguments unquoted. Either way the words git gets are not these.
    if (words[i] === '--%') notSimple('`--%`');
    if (seg.quoted[i]) continue;
    if (words[i].length > 1 && words[i].startsWith('@')) notSimple(`\`${words[i]}\``);
  }
  const op = MOVE_WORDS.get(words[0]) || (reading === 'powershell' && PS_MOVE_OPS.get(first));
  if (op) {
    seg.kind = 'move';
    const equivalent = op === 'pop' ? '`popd` alone' : `\`${op === 'push' ? 'pushd' : 'cd'} <path>\``;
    if (op === 'pop') {
      if (words.length !== 1) notSimple(`arguments to \`${words[0]}\` - write ${equivalent}`);
      seg.move = { op };
      return;
    }
    // PowerShell's `Set-Location -Path <path>` (or `-LiteralPath`) is the
    // same move as `Set-Location <path>`.
    const args = words.slice(1);
    if (reading === 'powershell' && args.length === 2 && !seg.quoted[1] && /^-(path|literalpath)$/i.test(args[0])) args.shift();
    if (args.length !== 1 || (args[0].startsWith('-') && !seg.quoted[words.length - 1])) {
      notSimple(`\`${words[0]}\` without exactly one path - write ${equivalent}`);
    }
    seg.move = { op, path: checkPath(args[0], true) };
    return;
  }
  if (PS_MOVE_RE.test(first)) {
    const ps = PS_MOVE_OPS.get(first);
    const equivalent = ps === 'push' ? '`pushd <path>` (and `popd`)' : ps === 'pop' ? '`popd`' : '`cd <path>`';
    notSimple(`\`${words[0]}\`, which moves in PowerShell only - write ${equivalent}`);
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
    // Every word carries its refspec reading: after `--` a word starting
    // with `-` is a refspec too (pushCandidate decides which reading holds).
    const { src, dst } = splitSpec(w);
    const spec = {
      src,
      dst,
      plus: w.startsWith('+'),
      main: isMainRef(dst),
      upstream: src === null && UPSTREAM_REFS.has(dst.toLowerCase()),
    };
    if (w.startsWith('-')) {
      // `--repo`, or an abbreviation git expands to it (`--rep`).
      const name = w.startsWith('--') ? w.slice(2).split('=')[0].toLowerCase() : '';
      const repo = name.length >= 3 && 'repo'.startsWith(name);
      words[i] = {
        ...spec,
        flag: true,
        hard: isHardPushFlag(w),
        // `--force-with-lease` written out: a rewrite that refuses to drop
        // commits it has not seen - the everyday update after a rebase.
        lease: w === '--force-with-lease' || w.startsWith('--force-with-lease='),
        wide: longPrefixOf(w, PUSH_WIDE_LONG),
        value: PUSH_VALUE_OPTS.has(w) || (repo && !w.includes('=')),
        repo,
        // `-:main`: a single-dash word with a `:` may be a refspec as well.
        colon: !w.startsWith('--') && w.includes(':'),
      };
    } else {
      words[i] = { ...spec, flag: false };
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
  const cand = { kind: 'gh', mainOnly: false, seg, repo: ghRepoOf(seg.words) };
  if (sub === 'api') return facts.mergeApiFrom[j + 1] ? cand : null;
  if (sub !== 'pr') return null;
  let k = j + 1;
  while (k < seg.words.length && seg.words[k].startsWith('-')) {
    k += GH_VALUE_OPTS.has(seg.words[k]) ? 2 : 1;
  }
  return (seg.words[k] || '').toLowerCase() === 'merge' ? cand : null;
}
// The `-R` / `--repo` value of a gh call, or null (H-19(a)).
function ghRepoOf(words) {
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '-R' || words[i] === '--repo') return words[i + 1] || '';
    if (words[i].startsWith('--repo=')) return words[i].slice(7);
  }
  return null;
}
// `OWNER/REPO`, `HOST/OWNER/REPO` or a URL, as lower-case `owner/repo`, or null.
function repoName(text) {
  const parts = String(text || '').replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/^git@[^:]+:/i, '')
    .replace(/\.git\/?$/i, '').split('/').filter((p) => p !== '');
  return parts.length >= 2 ? parts.slice(-2).join('/').toLowerCase() : null;
}

// H-13 / H-19(c): git calls that move the trunk ref without checking it out.
// Each returns `{ trunk, ref }` - the trunk as written and the commit it moves
// to - with `never` for a delete or a forced fetch, or null when the call is
// not one of these forms.
//   git branch -f|--force <trunk> [<start>]
//   git fetch <remote> [+]<src>:[refs/heads/]<trunk>
const positionalsOf = (inv, valueOpts) => {
  const out = [];
  const opts = [];
  const { words } = inv.seg;
  for (let i = inv.start; i < words.length; i++) {
    if (words[i].startsWith('-') && words[i] !== '-') {
      opts.push(words[i]);
      if (valueOpts.has(words[i])) i++;
    } else {
      out.push(words[i] === '-' ? '@{-1}' : words[i]); // a lone `-` is the previous branch
    }
  }
  return { pos: out, opts };
};
function trunkWrite(inv) {
  if (inv.sub === 'branch') {
    const { pos, opts } = positionalsOf(inv, new Set());
    if (!opts.some((o) => o === '-f' || o === '--force') || opts.some((o) => /^(-[mMcC]|--move|--copy)$/.test(o))) return null;
    if (pos.length < 1 || pos.length > 2 || !isMainBranch(pos[0])) return null;
    return { trunk: pos[0], ref: pos[1] || 'HEAD' };
  }
  if (inv.sub === 'fetch') {
    const { pos } = positionalsOf(inv, new Set(['--depth', '--deepen', '-j', '--jobs', '-o', '--server-option']));
    for (const spec of pos.slice(1)) {
      const { src, dst } = splitSpec(spec);
      if (src === null || !isMainRef(dst)) continue;
      const trunk = dst.replace(/^refs\/heads\//i, '');
      if (spec.startsWith('+')) return { trunk, never: true };
      // From this repository (`.`) the source is a local ref the gate can
      // read; from a remote only the same-name sync (`origin main:main`,
      // fast-forward only - git refuses anything else) is readable.
      if (pos[0] === '.') return { trunk, ref: src };
      return { trunk, sameName: pos[0] === 'origin' && src.replace(/^refs\/heads\//i, '').toLowerCase() === trunk.toLowerCase() };
    }
  }
  return null;
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
  let forced = false; // A hard flag other than --force-with-lease.
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

  let endOfOptions = false; // After `--`, every word is a positional.
  for (let i = inv.start; i < words.length; i++) {
    const f = facts[i];
    if (f.flag && !endOfOptions) {
      if (words[i] === '--') {
        endOfOptions = true;
        continue;
      }
      if (f.colon) {
        // Read both ways: a refspec, and an option that leaves the push
        // refspec-less (which lands on whatever the branch tracks).
        refspec(i);
        upstream = true;
      }
      if (f.hard) hard = true;
      if (f.hard && !f.lease) forced = true;
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
    // Only --force-with-lease, on the branch's own upstream: judged with the
    // branch (allowed off the trunk, always refused on it).
    lease: hard && !forced && !neverExempt && mainCount === 0 && !unreadable && !matching,
    toTrunk: mainCount > 0,
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
    } else {
      const write = trunkWrite(inv);
      if (!write) continue;
      inv.gated = true;
      cands.push({ kind: 'write', mainOnly: false, inv, ...write });
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

// The everyday commit and push on a feature branch: `git add` / `git commit`
// segments, then ONE push that lands on the branch's own upstream (no
// refspec, or a bare `HEAD`) as the last segment - joined by newlines, `;` or
// `&&`, with no global option, location change or other command, so nothing
// before the push can switch the branch or the repository. contextRules lets
// it through only once ctx says the branch is not the trunk.
const COMMIT_PUSH_SUBS = new Set(['add', 'commit']);
function isPlainCommitPush(lines, analyzed) {
  const segs = lines.flatMap((line) => line.segments);
  const cands = analyzed.flatMap((a) => a.cands);
  if (cands.length !== 1 || cands[0].kind !== 'push' || !cands[0].mainOnly) return false;
  const push = cands[0].inv.seg;
  return segs[segs.length - 1] === push && segs.every((seg) => seg.kind === 'git'
    && seg.git.globals.length === 0 && (seg === push || COMMIT_PUSH_SUBS.has(seg.git.sub)));
}

// The words after a git call's subcommand, or null when the call has a global
// option or an expanded word (then it is never one of the shapes below).
function plainArgs(inv) {
  if (inv.globals.length > 0 || inv.seg.expand.some(Boolean)) return null;
  return inv.seg.words.slice(inv.start);
}
// `git checkout -b|-B <x> [<start>]` / `git switch -c|-C <x> [<start>]`, x not
// a trunk: the new branch's name, or null.
function newBranchOf(inv) {
  const rest = plainArgs(inv);
  const opts = { checkout: ['-b', '-B'], switch: ['-c', '-C'] }[inv.sub];
  if (!rest || !opts || !opts.includes(rest[0]) || rest.length < 2 || rest.length > 3) return null;
  if (rest.slice(1).some((w) => w.startsWith('-')) || isMainBranch(rest[1])) return null;
  return rest[1];
}
// `git checkout <trunk>` / `git switch <trunk>`: the trunk as written, or null.
function trunkSwitchOf(inv) {
  const rest = plainArgs(inv);
  if (!rest || (inv.sub !== 'checkout' && inv.sub !== 'switch') || rest.length !== 1) return null;
  return isMainBranch(rest[0]) ? rest[0] : null;
}
// `git branch -d <x>`, x not a trunk.
function isBranchDelete(inv) {
  const rest = plainArgs(inv);
  return Boolean(rest) && inv.sub === 'branch' && rest.length === 2 && rest[0] === '-d'
    && !rest[1].startsWith('-') && !isMainBranch(rest[1]);
}
// A sync form of either trunk, as written (see `syncForms`).
const sameWords = (form, words) => form.length === words.length && form.every((x, i) => x === words[i]);
function syncFormShape(inv) {
  const rest = plainArgs(inv);
  return Boolean(rest) && ['main', 'master'].some((t) => syncForms(t).some((f) => sameWords(f, [inv.sub, ...rest])));
}

// Which movers a command may hold next to its gated calls (`deferralPlan`).
// Every plan needs a command with no location change and no git global option,
// so each call runs in the payload cwd's repository. The movers of a plan are
// not split off by rule 2; `contextRules` judges them with the branch:
//   sync      - the trunk sync, as the whole command:
//               [`git checkout|switch <trunk>` &&] <sync form>
//               [&& `git branch -d <x>`]...; judged on the trunk named (or the
//               current branch) by the sync forms. `branch` is that trunk.
//   newBranch - `git checkout -b <x>` (or `switch -c`), then - every segment
//               joined by `&&` - pushes of HEAD only, with `git add` / `git
//               commit` and other commands between: the pushes land on <x>,
//               which is not a trunk. `branch` is <x>.
//   fetch     - plain fetches (`plainFetch`) next to `git merge|rebase
//               origin/<trunk>` and refspec-less pushes: allowed off the
//               trunk; on it only the exact `isPlainTrunkSync` command.
//   commit    - `isPlainCommitPush`: allowed off the trunk, refused on it.
// A plan with no kind holds no mover; `multiOk` lets several gated calls
// stand on one line (all refspec-less pushes and sync merges / rebases, so
// off the trunk none of them is gated).
function deferralPlan(text, lines, analyzed, commandMover) {
  const segs = lines.flatMap((line) => line.segments);
  const invs = analyzed.flatMap((a) => a.invocations);
  const cands = analyzed.flatMap((a) => a.cands);
  if (cands.length === 0) return null;
  if (segs.some((seg) => seg.kind === 'move' || (seg.kind === 'git' && seg.git.globals.length > 0))) return null;
  const movers = invs.filter((inv) => moverName(inv, 'line'));

  // sync
  if (cands.length === 1 && cands[0].kind === 'git' && syncFormShape(cands[0].inv)) {
    const at = segs.indexOf(cands[0].inv.seg);
    const before = segs.slice(0, at);
    const after = segs.slice(at + 1);
    const inv = (seg) => seg.kind === 'git' && invs.find((i) => i.seg === seg);
    const trunk = before.length === 1 && inv(before[0]) ? trunkSwitchOf(inv(before[0])) : null;
    if ((before.length === 0 || (trunk && segs[at].before === '&&'))
      && after.every((seg) => seg.before === '&&' && inv(seg) && isBranchDelete(inv(seg)))) {
      const mover = movers.length > 0 ? moverName(movers[0], 'line') : null;
      return { kind: 'sync', branch: trunk, seg: cands[0].inv.seg, mover };
    }
  }

  if (!cands.every((c) => c.mainOnly)) return null;
  const syncCands = cands.filter((c) => c.kind === 'git');
  const multiOk = syncCands.every((c) => syncTarget(c) !== null);
  if (movers.length === 0) return { kind: null, multiOk };

  // newBranch
  const created = movers.filter((m) => newBranchOf(m) !== null);
  if (created.length === 1 && syncCands.length === 0
    && movers.every((m) => m === created[0] || m.sub === 'commit')) {
    const from = segs.indexOf(created[0].seg);
    const last = Math.max(...cands.map((c) => segs.indexOf(c.inv.seg)));
    const chained = segs.slice(from + 1, last + 1).every((seg) => seg.before === '&&');
    const pushesAfter = cands.every((c) => segs.indexOf(c.inv.seg) > from && !c.inv.chdirs.length);
    if (chained && pushesAfter) return { kind: 'newBranch', branch: newBranchOf(created[0]), multiOk: true };
  }

  // fetch
  if (multiOk && movers.every((m) => plainFetch(m) !== null)) {
    const target = cands.length === 1 ? syncTarget(cands[0]) : null;
    const trunkSync = target && isPlainTrunkSync(text, lines) ? { ...fetchOnlyMovers(invs), sub: target.sub } : null;
    return { kind: 'fetch', trunkSync, multiOk };
  }

  // commit
  if (commandMover === 'commit' && isPlainCommitPush(lines, analyzed)) return { kind: 'commit', multiOk: false };
  return null;
}

// --------------------------------------------------------------------------
// Path sets
// --------------------------------------------------------------------------

// Harness config files that may carry a `### Quality Gate Overrides` block.
const GATE_CONFIG_PATTERNS = [/(^|\/)CLAUDE\.md$/, /(^|\/)AGENTS\.md$/, /^\.cursorrules$/];

// The gate's own control plane: the quality-check skill and its schemas, the
// Design Gate skills (brainstorming, writing-plans), the review guides, the
// hooks and their registration. A diff touching any of them is never exempt -
// an unreviewed edit here disables the gate as effectively as weakening a
// threshold. Case-INSENSITIVE: on Windows/macOS `.claude/Hooks/quality-gate.cjs`
// is the same real file. The skills under `.claude/skills` (a link, or a real copy
// in some adopters - H-48) are control plane only where the patterns above name
// them; the `.claude/skills` node itself is, so re-pointing the link is caught.
const GATE_CONTROL_PATTERNS = [
  /(^|\/)skills\/(project\/)?(quality-check|test-recommendation|_schemas)\//i,
  /(^|\/)skills\/(superpowers\/)?(brainstorming|writing-plans)\//i,
  /^\.github\/review-[^/]*\.md$/i,
  /^\.(claude|codex|cursor)\/hooks(\/|$)/i,
  /^\.(claude|codex|cursor)\/skills$/i,
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

// Diffs made up entirely of these skip the gate (rule 4): the three config
// files, and the DOCUMENTS (`.md` / `.mdc`, H-47) under the harness
// directories - a script or config file there is code and needs the check.
const HARNESS_DOC_DIRS = [
  /^\.claude\//,
  /^\.codex\//,
  /^\.cursor\//,
  /^skills\/(project|superpowers)\//,
  /^\.github\/review-[^/]*\.md$/,
  /^documents\/development\/coding-rules\//,
];
const HARNESS_DOC_RE = /\.(md|mdc)$/i;

// Gate-parameter carve-out (quality-policy §2). Only the STRINGS are looked
// for, in added/removed diff lines: whether a declaration is live or
// commented out is not analysed - over-detection is fine here.
const OVERRIDE_STRINGS = [/quality[-_\s]*gate[-_\s]*overrides/i, /mutation[-_\s]*budget[-_\s]*minutes/i];

const isHarness = (f) => GATE_CONFIG_PATTERNS.some((re) => re.test(f))
  || (HARNESS_DOC_RE.test(f) && HARNESS_DOC_DIRS.some((re) => re.test(f)));
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
const splitReason = (mover) => `Split this into separate commands: in one call with git ${mover}, the gate cannot tell which branch or commit the push/merge acts on. Run the git ${mover} command first, then the push/merge on its own.`;
const COMMIT_PUSH = 'Split this into separate commands: git commit and a push to main/master in one call are refused, because the push to the trunk needs a passing quality check on the new commit, and that commit does not exist until git commit has run. Run git commit on its own, run the quality-check skill, then push.';
const FORCE = 'Force, delete, --all, --branches and --mirror pushes are never allowed here. Push a plain refspec after a quality check; to update your own feature branch after a rebase, use `git push --force-with-lease` from that branch.';
const FORCE_TRUNK = 'Force, delete, --all, --branches and --mirror pushes to main/master are always refused, with or without a quality check: they rewrite or delete trunk history that others have already pulled. Push a branch and merge it through a pull request instead.';
const ONE_OPERATION = 'Run one gated operation per command: split the merge, pull and push apart.';
// H-11 / H-13 / H-19.
const ONE_SOURCE = 'Merge or rebase one branch at a time on main/master (no --onto): run `git merge <branch>` with a single source.';
const pullSource = (trunk) => `On ${trunk}, a \`git pull\` from another branch brings in commits the gate cannot check. Run \`git fetch\`, then \`git merge <remote>/<branch>\` once the quality-check skill has passed on that branch - or use one of the sync forms (\`git pull\`, \`git pull origin ${trunk}\`).`;
const diverged = (trunk, ref) => `${trunk} has commits that ${ref} does not have, so the result would not be the commit the quality check ran on. Merge ${trunk} into the branch (or rebase it onto ${trunk}), re-run the quality-check skill there, then integrate.`;
const integrateReason = (trunk, ref, noRemote) => `The quality-check flag here does not cover ${ref}: the flag must name the commit that ${trunk} receives. Run the quality-check skill on ${ref} in this checkout, then integrate it.${noRemote ? ` From a separate worktree of the branch, run \`git push . HEAD:${trunk}\` there instead (see the branch-workflow skill).` : ''}`;
const TRUNK_NEVER = 'Deleting main/master or force-fetching into it is never allowed here. Integrate a branch with `git merge`, a pull request, or - without a remote - `git push . HEAD:main` from the checked branch.';
const FETCH_INTO_TRUNK = 'A fetch into main/master from another remote branch cannot be checked here. Fetch the branch, run the quality-check skill on it, then integrate it (`git merge`, a pull request, or `git push . HEAD:main`).';
const otherRepo = (repo, origin) => `This gh call names another repository (${repo}) than this checkout's origin (${origin || 'none'}), so this checkout's quality-check flag says nothing about it. Run it from that repository's own directory, without -R / --repo, after its quality check.`;
const PR_HINT = ' - or push the feature branch (`git push -u origin HEAD`) and open a pull request (`gh pr create`) instead of merging here.';
const PUSH_TARGET = 'This push has no refspec, and its push target (@{push}) is main/master. ';
// H-49: a harness-only diff that is not exempt only because of the override
// strings says so, instead of reading like an ordinary code change.
const overrideReason = (files) => `Quality Gate Overrides / mutation_budget_minutes changed in ${gateConfigFiles(files).join(', ')}: such a change is not harness-exempt. Run the quality-check skill before merging into main.`;
const overrideOnly = (diff) => diff.overrideChanged && diff.files.every(isHarness);
// H-49: a pull or merge on the trunk that is close to a sync form names the
// exact forms that need no flag.
function needFlagReason(a, branch) {
  const c = a.cands[0];
  if (c.kind !== 'git' || (c.sub !== 'pull' && c.sub !== 'merge') || !isMainBranch(branch)) return NEED_FLAG;
  const trunk = String(branch).toLowerCase();
  return `${NEED_FLAG} To sync ${trunk} without a flag, run exactly \`git pull\`, \`git pull origin ${trunk}\` or \`git merge origin/${trunk}\` (optionally with --ff-only), or \`git pull --rebase\` with no local commits ahead of origin/${trunk}, as the whole command (optionally after \`git checkout ${trunk} &&\` and before \`&& git branch -d <branch>\`).`;
}

// Rule 3's closed set of sync forms, parameterized by the trunk the session is
// actually on: on `master`, `git pull origin master` and
// `git merge origin/master` are the sync forms and `git pull origin main` is
// an ordinary gated operation. Exact word sequences only: a global option, an
// extra flag or a different remote needs a flag. The merge form also needs
// `origin/<trunk>` to BE the remote-tracking ref: a local tag or branch of
// that name is what git would merge instead, and a ctx that cannot say is no
// exemption. `git pull --rebase` is a sync form only while the local trunk has
// no commit origin's lacks (then the rebase is a fast-forward).
const syncForms = (trunk) => [
  ['pull'], ['pull', 'origin', trunk], ['merge', `origin/${trunk}`],
  ['pull', '--ff-only'], ['pull', '--ff-only', 'origin', trunk], ['merge', '--ff-only', `origin/${trunk}`],
  ['pull', '--rebase'],
];
// Only inside a `sync` plan (see `deferralPlan`): nothing else in the command
// can create a ref named `origin/<trunk>` or re-point `origin` after this
// check has read them.
function isSyncForm(seg, branch, ctx) {
  const w = seg.words;
  if (w.length < 2 || w[0].toLowerCase() !== 'git') return false;
  const trunk = String(branch).toLowerCase();
  const rest = [w[1].toLowerCase(), ...w.slice(2)];
  const form = syncForms(trunk).find((f) => sameWords(f, rest));
  if (!form) return false;
  if (form[1] === '--rebase') return typeof ctx.localAhead === 'function' && ctx.localAhead(trunk) === 0;
  if (form[0] !== 'merge') return true;
  const source = form[form.length - 1];
  return typeof ctx.fullRef === 'function' && ctx.fullRef(source) === `refs/remotes/origin/${trunk}`;
}

// Rule 2, items 1-5: no ctx is touched. `commandMover` is the whole command's
// HEAD mover, computed once by the caller; the movers of a `plan` (see
// `deferralPlan`) are judged with the branch in `contextRules` instead.
function staticRules(a, commandMover, plan) {
  if (a.cands.length === 0) return null;
  for (const c of a.cands) {
    if (c.kind === 'write' && c.never) return deny('2', TRUNK_NEVER);
    if (c.kind !== 'push') continue;
    if ((c.neverExempt || c.hard) && !c.lease) return deny('2', c.toTrunk ? FORCE_TRUNK : FORCE);
    if (c.matching) {
      return deny('2', 'A push that writes every matching branch (a `:` refspec or one with no destination) is never allowed here. Push one branch with an explicit refspec, from that branch.');
    }
  }
  const mover = moverOf(a.invocations, 'line') || commandMover;
  if (mover && !(plan && plan.kind)) {
    return deny('2', mover === 'commit' && a.cands.some((c) => c.kind === 'push') ? COMMIT_PUSH : splitReason(mover));
  }
  if (a.expansion) {
    return deny('2', 'Write refs without shell expansion (no %VAR% word and no word starting with ~).');
  }
  if (a.cands.length > 1 && !(plan && plan.multiOk)) return deny('2', ONE_OPERATION);
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
      return deny('2', `Push from the branch itself: ${src}:${dst} pushes a branch other than the current one; only HEAD or the current branch can be pushed to the trunk here. Check out that branch and push from it, or push this branch with \`git push -u origin HEAD\`.`);
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

// Rule 3: the flag. `noFlag` is the reason to give when there is none. The
// flag is checked against HEAD, or - with `tip` (a sha) - against the commit
// a merge, rebase or trunk rewrite brings into the trunk (H-11); `stale` is
// then the reason for a flag that does not cover it.
function rule3Flag(ctx, noFlag, tip = null, stale = STALE) {
  const flag = ctx.flag;
  if (!flag) return deny('3', noFlag);
  const head = tip || ctx.head;
  if (!head) {
    return deny('5', 'Cannot verify HEAD. Re-run the quality-check skill.');
  }
  // `flag.commit` is lower-cased once, where the flag is read.
  if (head.startsWith(flag.commit)) return allow();

  const ancestor = tip ? ctx.ancestor(flag.commit, tip) : ctx.isAncestor;
  if (ancestor === null) {
    return deny('5', 'Cannot verify the commit the quality check ran on. Re-run the quality-check skill.');
  }
  if (!ancestor) return deny('3', stale);

  const since = tip ? ctx.diffRange(`${flag.commit}..${tip}`) : ctx.diffSinceFlag;
  if (since === null) {
    return deny('5', 'Cannot verify what changed since the last quality check. Re-run the quality-check skill.');
  }
  if (since.files.length === 0) return allow();
  const hits = controlHits(since.files);
  if (hits.length > 0) return deny('3', controlReason(hits));
  if (since.files.every(isHarness) && !since.overrideChanged) return allow();
  return deny('3', overrideOnly(since) ? overrideReason(since.files) : stale);
}

// H-11 / H-13: the trunk `trunk` moves to `ref` (a merge or rebase on it, or a
// rewrite of its ref). Allowed when that is a sync with origin's trunk, a
// no-op or a rewind, or a fast-forward whose new commits are harness files
// only or are covered by the flag - the flag is bound to `ref`, not to HEAD,
// so a flag left from an earlier run does not let another branch in.
// `reasons`: `{ noFlag, stale }`.
function judgeTrunkMove(ctx, trunk, ref, reasons) {
  const cannot = (what) => deny('5', `Cannot verify ${what}. Re-run the command after checking the repository state.`);
  const target = ctx.resolveCommit(ref);
  if (!target) return cannot(`the commit \`${ref}\` names`);
  const t = String(trunk);
  if (target === ctx.resolveCommit(`refs/remotes/origin/${t.toLowerCase()}`)) return allow();
  const tip = ctx.resolveCommit(`refs/heads/${t}`);
  if (!tip) return cannot(`the current ${t}`);
  const contained = tip === target || ctx.ancestor(target, tip);
  if (contained === null) return cannot(`whether ${t} already holds \`${ref}\``);
  if (contained) return allow();
  const ff = ctx.ancestor(tip, target);
  if (ff === null) return cannot(`whether ${t} can fast-forward to \`${ref}\``);
  if (!ff) return deny('3', diverged(t, ref));
  const gained = ctx.diffRange(`${tip}..${target}`);
  if (gained === null) return cannot(`what \`${ref}\` adds to ${t}`);
  const hits = controlHits(gained.files);
  if (hits.length === 0 && !gained.overrideChanged && gained.files.every(isHarness)) return allow(); // Rule 4.
  let noFlag = reasons.noFlag;
  if (hits.length > 0) noFlag = controlReason(hits);
  else if (overrideOnly(gained)) noFlag = overrideReason(gained.files);
  return rule3Flag(ctx, noFlag, target, reasons.stale);
}

// The source a `git merge` / `git rebase` / `git pull` on the trunk brings in
// (H-11): `{ ref }`, `{ head: true }` when none is written or it is origin's
// trunk (judged against HEAD), or `{ deny }`.
const SOURCE_VALUE_OPTS = new Set([
  '-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup',
]);
function integrationSource(cand, trunk) {
  const { pos, opts } = positionalsOf(cand.inv, SOURCE_VALUE_OPTS);
  if (cand.sub === 'pull') {
    const t = String(trunk).toLowerCase();
    if (pos.length === 0 || (pos[0] === 'origin' && (pos.length === 1 || (pos.length === 2 && pos[1].toLowerCase() === t)))) return { head: true };
    return { deny: deny('2', pullSource(t)) };
  }
  if (opts.some((o) => o === '--onto' || o.startsWith('--onto='))) return { deny: deny('2', ONE_SOURCE) };
  if (pos.length === 0) return { head: true };
  if (pos.length > 1) return { deny: deny('2', ONE_SOURCE) };
  return { ref: pos[0] };
}

// Everything that needs ctx. Always returns a decision. `plan` is the
// command's `deferralPlan` (null when it is not one).
function contextRules(a, ctx, plan = null) {
  // A plan that switches branch judges its calls on the branch it switches
  // to, without reading the current one.
  const branch = plan && plan.branch ? plan.branch : ctx.branch;
  if (!branch) {
    // Includes a detached HEAD: an unresolved branch with a candidate blocks.
    return deny('5', 'Cannot verify the current branch. Check out a branch, then re-run the command.');
  }
  // H-19(d): a refspec-less push off the trunk still lands on the trunk when
  // the branch's push target is one (an upstream set to origin/main).
  const toTrunk = (c) => c.kind === 'push' && c.omittedRefspec && !(plan && plan.branch)
    && /^[^/]+\/(main|master)$/i.test(ctx.pushTarget || '');
  const gated = a.cands.filter((c) => !c.mainOnly || isMainBranch(branch) || toTrunk(c));
  if (gated.length === 0) return allow();
  if (gated.length > 1) return deny('2', ONE_OPERATION);
  const cand = gated[0];
  if (cand.kind === 'push' && cand.hard) return deny('2', FORCE_TRUNK);
  if (cand.kind === 'gh' && cand.repo !== null) {
    // H-19(a): another repository's PR is judged in that repository.
    const origin = ctx.originRepo;
    if (!origin || repoName(cand.repo) !== origin) return deny('2', otherRepo(cand.repo, origin));
  }
  const kind = plan ? plan.kind : null;
  if (kind === 'commit') return deny('2', COMMIT_PUSH);
  if (kind === 'newBranch') return deny('2', splitReason('checkout')); // Its branch is never a trunk.
  if (kind === 'fetch') {
    // On the trunk only the daily trunk sync: a plain fetch, then a merge
    // whose source really is the remote-tracking ref - a local tag or branch
    // named `origin/<trunk>` is what git would merge instead, and a ctx that
    // cannot answer is no exemption - or a rebase, judged by the flag below.
    const sync = plan.trunkSync;
    if (!sync) return deny('2', splitReason('fetch'));
    if (sync.sub === 'merge') {
      const trunk = String(branch).toLowerCase();
      const target = syncTarget(a.cands[0]);
      const ok = target !== null && target.trunk === trunk && sync.trunks.every((t) => t === trunk)
        && typeof ctx.fullRef === 'function' && ctx.fullRef(target.source) === `refs/remotes/origin/${trunk}`;
      return ok ? allow() : deny('2', splitReason('fetch'));
    }
  }

  const reverse = reverseRefspec(gated, branch); // Rule 2 item 6, ahead of every exemption.
  if (reverse) return reverse;

  if (kind === 'sync') {
    if (isSyncForm(plan.seg, branch, ctx)) return allow(); // Rule 3, sync form.
    if (plan.mover) return deny('2', splitReason(plan.mover));
  }

  // H-11 / H-13: the flag is bound to the commit the trunk receives. A ctx
  // without `resolveCommit` (a test stub) judges the flag against HEAD.
  const resolves = typeof ctx.resolveCommit === 'function';
  if (cand.kind === 'write') {
    if (cand.ref === undefined) return cand.sameName ? allow() : deny('2', FETCH_INTO_TRUNK);
    const why = integrateReason(cand.trunk, cand.ref, ctx.hasRemote === false);
    return resolves ? judgeTrunkMove(ctx, cand.trunk, cand.ref, { noFlag: why, stale: why }) : rule3Flag(ctx, why);
  }
  if (cand.kind === 'git') {
    const source = integrationSource(cand, branch);
    if (source.deny) return source.deny;
    if (source.ref !== undefined && resolves) {
      const why = integrateReason(branch, source.ref, ctx.hasRemote === false);
      const noFlag = SYNC_SOURCE_RE.test(source.ref) ? needFlagReason(a, branch) : why;
      return judgeTrunkMove(ctx, branch, source.ref, { noFlag, stale: why });
    }
  }

  const base = ctx.diffSinceBase;
  if (base === null) {
    return deny('5', 'Cannot verify what changed since the base ref (origin/main, or main without a remote). Re-run the quality-check skill.');
  }
  const baseControl = controlHits(base.files);
  if (rule4Exempt(base, baseControl)) return allow();
  let noFlag = needFlagReason(a, branch);
  if (baseControl.length > 0) noFlag = controlReason(baseControl);
  else if (overrideOnly(base)) noFlag = overrideReason(base.files);
  const verdict = rule3Flag(ctx, noFlag);
  // A trunk push from a feature branch can go through a pull request instead
  // (`gh pr merge` already has one).
  const offTrunk = cand.kind === 'push' && !isMainBranch(branch);
  if (verdict.decision !== 'block' || verdict.rule !== '3' || !offTrunk) return verdict;
  const prefix = cand.kind === 'push' && cand.mainOnly ? PUSH_TARGET : '';
  return { ...verdict, reason: `${prefix}${verdict.reason.replace(/\.$/, '')}${PR_HINT}` };
}

// A command line the classifier will not read (over the byte budget, or a
// classifier exception) is judged on its gate words alone. Stripping quotes
// cannot undo an EXPANSION (`$'\x70'ush` is `push`, `${x}ush` may be
// anything), so a text still holding one of the expansion characters blocks
// whether or not a gate word is left visible.
const TOO_LONG = 'Command line too long to classify. Split the gated git/gh call into its own command.';
const UNCLASSIFIABLE = 'This command line could not be classified. Run the git/gh call as a single plain command.';
const EXPANDED = 'A shell expansion ($, backtick, brace or %) in a command line that cannot be classified could spell anything. Run the git/gh call as a single plain command without expansions.';
const UNREADABLE_COMMAND = 'This shell call carries no readable command (tool_input.command is missing or not a string), so the quality gate cannot check it. Run the command as a plain command string.';
const HUGE_PAYLOAD = 'The hook payload is too large to read, so this command cannot be checked. Run the git/gh call as a single plain command.';
const EXPAND_CHARS_RE = /[$`{}%]/;
function gateWordFallback(text, reason) {
  if (gateWordIn(text)) return deny('2', reason);
  if (EXPAND_CHARS_RE.test(text)) return deny('2', EXPANDED);
  return allow();
}

// --------------------------------------------------------------------------
// Always refused: a PowerShell script the gate cannot read (H-52)
// --------------------------------------------------------------------------
// See ALWAYS REFUSED in the header: one reading of the text, nothing parsed.
const UNREADABLE_PS = 'An encoded or stdin PowerShell script cannot be read by the quality gate, so it is refused whether or not it pushes or merges. Run the script as plain text instead (`pwsh -File <script>.ps1` or `pwsh -Command "<script>"`). If the command only mentions these parameters (a search term, a message), rerun it without them.';
const PS_WORD_RE = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/;
const PS_PARAM_RE = /^(?:--?|\/)([a-z]+)$/;
const PS_SEPARATOR_RE = /^[;&|()\n]$/;

function alwaysDeny(text) {
  const words = text.toLowerCase().replace(/[\\`^]\r?\n/g, '').replace(/["']/g, '')
    .match(/[;&|()\n]|[^\s;&|()]+/g) || [];
  let ps = false; // A PowerShell word earlier in this command.
  for (let i = 0; i < words.length; i++) {
    if (PS_WORD_RE.test(words[i])) {
      ps = true;
    } else if (PS_SEPARATOR_RE.test(words[i])) {
      ps = false;
    } else if (ps) {
      const m = PS_PARAM_RE.exec(words[i]);
      if (!m) continue;
      const name = m[1];
      if (name === 'ec' || 'encodedcommand'.startsWith(name)) return deny('2', UNREADABLE_PS);
      if ((name === 'command' || name === 'c') && words[i + 1] === '-') return deny('2', UNREADABLE_PS);
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Everyday forms that need not be refused
// --------------------------------------------------------------------------
// Output plumbing at the very END of the whole command is dropped before the
// command is parsed: a last pipe into `tail` / `head` (`-5`, `-n 5`) or
// `Select-Object -Last|-First <n>`, and before it any number of ` 2>&1`,
// ` >/dev/null`, ` 2> /dev/null` and the like, each after a blank. Exactly
// these, nowhere else. Each pattern is tried on a short window at the end, so
// a long run of blanks costs linear time.
const TRAILING_PIPE_RE = /[ \t]*\|[ \t]*(?:(?:tail|head)[ \t]+-(?:n[ \t]*)?|select-object[ \t]+-(?:last|first)[ \t]+)[1-9][0-9]{0,5}$/i;
const TRAILING_REDIRECT_RE = /[ \t](?:2>&1|[12]?>[ \t]*\/dev\/null)$/;
const TRAILING_WINDOW = 64;
function stripTrailingOutput(text) {
  let body = text.trimEnd();
  const cut = (re) => {
    const m = re.exec(body.slice(-TRAILING_WINDOW));
    if (m) body = body.slice(0, body.length - m[0].length).trimEnd();
    return m !== null;
  };
  cut(TRAILING_PIPE_RE);
  while (cut(TRAILING_REDIRECT_RE));
  return body;
}

// PowerShell 5.1 has no `&&`; `A; if ($?) { B }` is how it is written there,
// and it runs B exactly when A succeeded. Read as PowerShell, that exact
// shape - B one command with no braces, `;`, `&`, `|`, `$`, backtick or line
// break, and no `else` after it - is read as `A && B`. Text inside quotes is
// left alone.
const PS_IF_OK_RE = /;[ \t]*if[ \t]*\([ \t]*\$\?[ \t]*\)[ \t]*\{([^{}\n;&|$`]+)\}(?![ \t]*[^ \t\n;])(?!\s*(?:;\s*)?else)/iy;
function readPsIfOk(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ';') {
      PS_IF_OK_RE.lastIndex = i;
      const m = PS_IF_OK_RE.exec(text);
      if (m && m[1].trim() !== '') {
        out += ` && ${m[1].trim()}`;
        i = PS_IF_OK_RE.lastIndex;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// Message values. A gate word that only appears in the message of
// `git commit|tag` or `gh pr|issue create|edit|comment|review` is not a push
// or a merge. Such a value is masked before the gate words are looked for
// when it is a literal both shells read the same way:
//   - a quoted string with no `$`, backtick, backslash, typographic quote
//     (U+2018-U+201E), CR or NUL, ending at a word boundary (so no `'a''b'`
//     or `"a""b"`, which PowerShell reads as one string and a POSIX shell as
//     two), after the option (`-m "..."`) or attached to it (`-m"..."`,
//     `--message="..."`);
//   - `"$(cat <<'DELIM'` <LF> lines <LF> `DELIM` <LF> `)"`, also `<<-`: a
//     quoted here-document whose body ends at the first line that is exactly
//     the delimiter (a line starting `DELIM)` may end it early inside `$(`);
//   - a quoted here-document given as standard input (`--body-file -
//     <<'EOF'`, `-F - <<'EOF'`) as the last thing on its line; PowerShell
//     refuses `<<` outright, so it never runs there;
//   - PowerShell's `@'` <LF> lines <LF> `'@` with no `'` in it (a POSIX shell
//     reads that as one literal word).
// The value of a file option (`-F`, `--file`, `--body-file`) is a path and is
// masked too, written plainly or with backslashes. No form may hold a
// typographic quote anywhere: PowerShell reads U+2018-U+201B as `'` and
// U+201C-U+201E as `"`, so one of them can close a string early.
// A value that itself holds a git/gh word AND a gate word is not masked. The
// whole text must be read by this small grammar - plain words, literal quoted
// strings, separators - or nothing is masked. A masked value becomes the
// placeholder `"x"`; with no gate word left the command is allowed, and
// otherwise the masked text - every other word as written - is judged.
const MASK_OPTS = {
  git: { subs: [['commit'], ['tag']], opts: new Set(['-m', '--message']), files: new Set(['-F', '--file']) },
  gh: {
    subs: ['pr', 'issue'].flatMap((n) => ['create', 'edit', 'comment', 'review'].map((v) => [n, v])),
    opts: new Set(['-t', '--title', '-b', '--body']),
    files: new Set(['-F', '--body-file']),
  },
};
const LITERAL_RE = /^[^$`\\‘-„\r\0]*$/;
const TYPOGRAPHIC_QUOTE_RE = /[‘-„]/;
const GIT_GH_WORD_RE = /(?<![A-Za-z])(?:git|gh)(?![A-Za-z])/i;
const HEREDOC_VALUE_RE = /"\$\(cat <<(-?)'([A-Za-z_][A-Za-z0-9_]*)'\n/y;
const HEREDOC_STDIN_RE = /<<(-?)'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\n/y;
const VALUE_CLOSE_RE = /\n[ \t]*\)"/y;
const WORD_END = ' \t\n;&|';
function harmlessValue(content) {
  const plain = content.replace(LINE_CONTINUATION_RE, '').replace(ESCAPE_CHARS_RE, '');
  return !(GIT_GH_WORD_RE.test(content) || GIT_GH_WORD_RE.test(plain)) || !gateWordIn(content);
}
// A quoted here-document whose head `re` matches at `i`: `{ stop, content }`,
// `stop` at the line break after the terminator (or the end), or null.
function heredoc(re, text, i) {
  re.lastIndex = i;
  const head = re.exec(text);
  if (!head) return null;
  const [, dash, delim] = head;
  const lines = [];
  for (let k = re.lastIndex; ;) {
    let nl = text.indexOf('\n', k);
    if (nl === -1) nl = text.length;
    const line = text.slice(k, nl);
    const bare = dash ? line.replace(/^\t+/, '') : line;
    if (bare === delim) return { stop: nl, content: lines.join('\n') };
    if (nl === text.length || bare.startsWith(`${delim})`) || /[\r\0]/.test(line) || TYPOGRAPHIC_QUOTE_RE.test(line)) return null;
    lines.push(line);
    k = nl + 1;
  }
}
// A here-document or here-string message value starting at `i`:
// `{ end, content }`, or null.
function messageValue(text, i) {
  const ends = (k) => k >= text.length || WORD_END.includes(text[k]);
  const doc = heredoc(HEREDOC_VALUE_RE, text, i);
  if (doc) {
    VALUE_CLOSE_RE.lastIndex = doc.stop;
    if (!VALUE_CLOSE_RE.test(text) || !ends(VALUE_CLOSE_RE.lastIndex)) return null;
    return { end: VALUE_CLOSE_RE.lastIndex, content: doc.content };
  }
  if (text.startsWith("@'\n", i)) {
    const close = text.indexOf("'", i + 2);
    if (close === -1 || text[close - 1] !== '\n' || text[close + 1] !== '@' || !ends(close + 2)) return null;
    const content = text.slice(i + 3, close - 1);
    if (/[\r\0]/.test(content) || TYPOGRAPHIC_QUOTE_RE.test(content)) return null;
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
// After PowerShell's stop-parsing token `--%` the words git gets are not the
// ones written (see checkSegment), so a command holding it anywhere is never
// masked.
function maskMessages(text) {
  if (text.includes('--%')) return null;
  let out = '';
  let words = []; // The current segment's words so far (`"` for a quoted one).
  let i = 0;
  const spec = () => {
    const s = MASK_OPTS[words[0]];
    return s && s.subs.some((sub) => sub.every((w, k) => words[k + 1] === w)) ? s : null;
  };
  // The quoted value at `i`, masked when it belongs to `opt` and is harmless.
  const quoted = (opt) => {
    const s = spec();
    const isValue = s !== null && (s.opts.has(opt) || s.files.has(opt));
    const v = (isValue && messageValue(text, i)) || (text[i] !== '@' && literalString(text, i));
    if (!v) return null;
    const masked = isValue && harmlessValue(v.content) ? '"x"' : text.slice(i, v.end);
    i = v.end;
    words.push('"'); // A quoted word: never a command or option word.
    return masked;
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
    } else if (ch === '<' && spec() !== null) {
      const doc = heredoc(HEREDOC_STDIN_RE, text, i);
      if (!doc || !harmlessValue(doc.content)) return null;
      i = doc.stop; // The line break after it ends the segment.
    } else if (ch === '"' || ch === "'" || text.startsWith("@'\n", i)) {
      const v = quoted(words[words.length - 1]);
      if (v === null) return null;
      out += v;
    } else if (PLAIN_CHAR_RE.test(ch) || ch === '\\') {
      const s = spec();
      const file = s !== null && s.files.has(words[words.length - 1]);
      let w = '';
      while (i < text.length && (PLAIN_CHAR_RE.test(text[i]) || (file && text[i] === '\\'))) w += text[i++];
      if (w === '') return null;
      if (text[i] === '"' || text[i] === "'") {
        // Attached: `-m"..."`, `--message="..."`.
        const opt = w.startsWith('--') && w.endsWith('=') ? w.slice(0, -1) : w;
        if (s === null || !s.opts.has(opt) || (opt === w) === opt.startsWith('--')) return null;
        const v = quoted(opt);
        if (v === null) return null;
        out += v === '"x"' && opt === w ? `${w} ${v}` : `${w}${v}`;
        continue;
      }
      if (i < text.length && !WORD_END.includes(text[i])) return null;
      out += file ? 'x' : w;
      words.push(file ? '"' : w);
    } else {
      return null;
    }
  }
  return out;
}

const notSimpleReason = (why) => `This command mentions push, pull, merge or rebase but is not in the simple form the quality gate can judge (${why}), so run the git/gh push or merge as a separate command - optionally after \`cd <path>\` or as \`git -C <path>\` - without variables, special characters in quotes, or other shell constructs. A command that does not push or merge should avoid those words; for a commit message or a PR body that holds them, write the text to a file and use \`git commit -F <file>\` or \`gh pr create --body-file <file>\`.`;

// --------------------------------------------------------------------------
// Where each gated call runs (#158)
// --------------------------------------------------------------------------
// A location change on an earlier segment, or `-C <path>` on the call itself,
// changes the repository a gated call writes to. The segments are walked in
// ONE reading from the payload cwd: every move runs, in order, and pushd /
// popd keep a stack. A location is `null` (not moved) or a resolved
// `{ logical, physical }` pair. Where the reading cannot be trusted, a gated
// call after it blocks with guidance to run the push/merge on its own:
//   - a target that does not exist now, or whose logical `..` and physical
//     path disagree: git's `-C` is held to the same rule as `cd`, and on
//     Windows git and PowerShell resolve `..` lexically on the apparent path,
//     so `-C <link>/..` (or `-C ..` after a `cd` into a link) lands
//     somewhere else there (UNRESOLVED_MOVE);
//   - a move inside an `&&` chain after a command that may fail, when a
//     gated call follows once the chain has ended - it runs in either place -
//     and a move in a command with CRLF line ends (AMBIGUOUS_MOVE).
// (PowerShell-only spellings outside PowerShell and a bare name under CDPATH
// are not simple.)
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

// The candidate's effective directory: its segment's location, then each
// `-C` of the call in order.
function candidateLocation(cand, here, start) {
  for (const p of cand.inv ? cand.inv.chdirs : []) {
    const from = here || start();
    if (from === UNRESOLVED) return UNRESOLVED;
    here = changeDir(from, p);
    if (here === null) return UNRESOLVED;
  }
  return here;
}

const UNRESOLVED_MOVE = 'Run git from the target repository directory as a separate command: a cd/pushd/-C target must be a local directory that exists now (and no link under ..) before a gated push/merge. Run `cd <repository path>` on its own, then the push/merge alone.';
const AMBIGUOUS_MOVE = 'Run git from the target repository directory as a separate command: where this push/merge runs depends on whether an earlier command succeeds (a cd after another command in an && chain) or on the shell (a cd at the end of a CRLF line). Run `cd <repository path>` on its own, then the push/merge alone.';
const NOT_A_WORK_TREE = 'The directory this push/merge would run in is not inside a git work tree. Run git from the target repository directory as a separate command.';
const TARGET_GIT_FAILED = 'Cannot read the repository this push/merge would run in (git failed or timed out). Run git from the target repository directory as a separate command.';
const MULTI_REPO = 'Run gated operations for one repository per command: split the push/merge for each repository into its own command.';

// A verdict decided somewhere other than the payload cwd's repository carries
// `elsewhere: true`: it must not ride rule 5's "cwd is not a git work tree"
// fail-open, which is about the payload cwd alone.
const elsewhere = (verdict) => ({ ...verdict, elsewhere: true });

// The (line, ctx) pairs to judge, or a block. A candidate line holds exactly
// one candidate here, or several only under a `deferralPlan`, which has no
// move at all - so the line is placed by its first candidate. A ctx is
// made once per directory and shared per toplevel, so each repository's git
// state is read once per command. `crlf`: the command had CRLF line ends.
function locateCandidates(lines, candLines, ctx, crlf) {
  const segs = lines.flatMap((line) => line.segments);
  const candAt = new Map(); // segment -> its line's analysis
  for (const a of candLines) candAt.set(a.cands[0].inv ? a.cands[0].inv.seg : a.cands[0].seg, a);
  let origin;
  const start = () => {
    if (origin === undefined) origin = originOf(ctx);
    return origin;
  };
  const byDir = new Map();
  const byTop = new Map();

  // Where a candidate is judged from `here`: a ctx and whether it moved, or a block.
  const judgeFor = (a, here) => {
    const loc = candidateLocation(a.cands[0], here, start);
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
    if (!byTop.has(top)) byTop.set(top, there);
    return { ctx: byTop.get(top), moved: true };
  };

  let here = null; // null: not moved.
  const stack = [];
  let fallible = false; // A command that may fail ran earlier in this && chain.
  let conditional = false; // ...and a move followed it in the chain.
  let skippable = false; // A finished chain may have stopped before its move.
  let left = candAt.size;
  const out = [];
  for (const seg of segs) {
    if (left === 0) break; // Moves after the last candidate are not followed.
    if (seg.before !== '&&') {
      skippable = skippable || conditional;
      fallible = false;
      conditional = false;
    }
    const a = candAt.get(seg);
    if (a) {
      if (skippable) return elsewhere(deny('2', AMBIGUOUS_MOVE));
      const j = judgeFor(a, here);
      if (j.decision) return j;
      if (out.length > 0 && out[0].ctx !== j.ctx) return elsewhere(deny('2', MULTI_REPO));
      out.push({ a, ...j });
      left--;
    }
    if (seg.kind !== 'move') {
      fallible = true;
      continue;
    }
    // A POSIX shell keeps the CR of a CRLF line end in the path: the move
    // fails there and succeeds in PowerShell.
    if (crlf) return elsewhere(deny('2', AMBIGUOUS_MOVE));
    conditional = conditional || fallible;
    if (seg.move.op === 'pop') {
      if (stack.length === 0) return elsewhere(deny('2', UNRESOLVED_MOVE));
      here = stack.pop();
      continue;
    }
    const from = here || start();
    const next = from === UNRESOLVED ? null : changeDir(from, seg.move.path);
    if (next === null) return elsewhere(deny('2', UNRESOLVED_MOVE));
    if (seg.move.op === 'push') stack.push(here);
    here = next;
  }
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
//   diffSinceBase `{ files, overrideChanged }` for `<base>...HEAD` (BASE_REFS),
//                 or null on failure. An absent base ref is an EMPTY diff (no
//                 exemption), not null.
//   resolveCommit(ref) the sha `ref` names, or null. ancestor(a, b): a is an
//                 ancestor of b - true / false, null on failure. diffRange(r):
//                 like diffSinceFlag for the range r. A ctx without
//                 resolveCommit (a test stub) judges merges against HEAD.
//   pushTarget    `@{push}` (`origin/main`), or null/undefined.
//   hasRemote     false when the repository has no remote.
//   originRepo    origin's `owner/repo` in lower case, or null.
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
function classify(command, ctx, shell = null) {
  const saved = reading;
  reading = shell;
  try {
    return classifyText(String(command || ''), ctx);
  } finally {
    reading = saved;
  }
}
function classifyText(text, ctx) {
  const always = alwaysDeny(text);
  if (always) return always;
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) return gateWordFallback(text, TOO_LONG);
  if (!gateWordIn(text) && !trunkWriteIn(text)) return allow();
  // A CRLF line end is read as LF (a lone CR is still not simple).
  const crlf = text.includes('\r\n');
  const stripped = stripTrailingOutput(crlf ? text.replace(/\r\n/g, '\n') : text);
  const body = reading === 'powershell' ? readPsIfOk(stripped) : stripped;
  const masked = maskMessages(body);
  if (masked !== null && !gateWordIn(masked) && !trunkWriteIn(masked)) return allow(); // Only in a message.
  // The rest of the command is judged with its message values masked.
  const judged = masked === null ? body : masked;
  let lines;
  try {
    lines = parseSimple(judged);
  } catch (e) {
    // Without a gate word only a simple trunk rewrite is judged.
    if (e instanceof NotSimple) return gateWordIn(judged) ? deny('2', notSimpleReason(e.message)) : allow();
    throw e;
  }
  const analyzed = lines.map(analyzeLine);
  // A trunk rewrite (H-13) shares its command with no other gated call.
  const cands = analyzed.flatMap((a) => a.cands);
  const write = cands.find((c) => c.kind === 'write');
  if (write && cands.length > 1) return deny('2', splitReason(write.inv.sub));
  const all = analyzed.flatMap((a) => a.invocations);
  // The HEAD movers are judged over the whole command, so this answer is the
  // same for every line: compute it once.
  const commandMover = moverOf(all, 'command');
  const plan = deferralPlan(judged, lines, analyzed, commandMover);
  for (const a of analyzed) {
    const verdict = staticRules(a, commandMover, plan);
    if (verdict) return verdict;
  }
  const candLines = analyzed.filter((a) => a.cands.length > 0);
  if (candLines.length === 0) return allow();
  const placed = locateCandidates(lines, candLines, ctx, crlf);
  if (!Array.isArray(placed)) return placed;
  for (const p of placed) {
    const verdict = contextRules(p.a, p.ctx, plan);
    if (verdict.decision === 'block') return p.moved ? elsewhere(judgedThere(verdict, p.ctx)) : verdict;
  }
  return allow();
}

// A block decided in another repository (a `cd` / `-C` moved the call) says
// which repository and branch it judged.
function judgedThere(verdict, there) {
  const where = `This push/merge was judged in ${there.toplevel || 'another repository'} on branch ${there.branch || '(unknown)'}`;
  const why = verdict.rule === '3' ? ': it updates main/master there, and that repository has no current quality-check flag. ' : ': ';
  return { ...verdict, reason: `${where}${why}${verdict.reason}` };
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
const BASE_REFS = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];
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
    // Commits on the local trunk that origin's trunk lacks, or null when git
    // cannot say (read only for `git pull --rebase` on the trunk).
    localAhead(trunk) {
      return once(`ahead:${trunk}`, () => {
        const r = git(['rev-list', '--count', `refs/remotes/origin/${trunk}..refs/heads/${trunk}`]);
        const n = r.ok ? Number.parseInt(r.out.trim(), 10) : NaN;
        return Number.isInteger(n) ? n : null;
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
        // H-13: the base ref is origin's trunk, or - only when there is no
        // remote-tracking trunk at all - the local trunk (quality-check's
        // `quality-context` picks it the same way).
        for (const ref of BASE_REFS) {
          const r = git(['rev-parse', '--verify', '--quiet', ref]);
          if (r.ok && r.out.trim()) return diff(`${ref}...HEAD`);
        }
        return { files: [], overrideChanged: false }; // No base ref: no exemption.
      });
    },
    // H-11 / H-13: the commit `ref` names (lower case), or null.
    resolveCommit(ref) {
      return once(`commit:${ref}`, () => {
        const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return r.ok && r.out.trim() ? r.out.trim().toLowerCase() : null;
      });
    },
    // `a` is an ancestor of `b` (both shas): true / false, or null on failure.
    ancestor(a, b) {
      return once(`anc:${a}:${b}`, () => {
        const r = git(['merge-base', '--is-ancestor', a, b]);
        if (r.ok) return true;
        return r.status === 1 ? false : fail('git-error');
      });
    },
    diffRange(range) {
      return once(`diff:${range}`, () => diff(range));
    },
    // H-19(d): where a refspec-less push of this branch lands (`origin/main`),
    // or null when git cannot say (then the push itself fails or goes nowhere).
    get pushTarget() {
      return once('push', () => {
        const r = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
        return r.ok ? r.out.trim() || null : null;
      });
    },
    // True when the repository has no remote at all.
    get hasRemote() {
      return once('remotes', () => {
        const r = git(['remote']);
        return r.ok ? r.out.trim() !== '' : true;
      });
    },
    // H-19(a): origin's `owner/repo` (lower case), or null.
    get originRepo() {
      return once('origin', () => {
        const r = git(['remote', 'get-url', 'origin']);
        return r.ok ? repoName(r.out.trim()) : null;
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
    let shell = null;
    let cwd = process.cwd();
    try {
      // Windows producers may prefix JSON with a UTF-8 BOM. Strip only that
      // leading marker so valid payloads do not enter the malformed fail-open.
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      const raw = payload && payload.tool_input ? payload.tool_input.command : undefined;
      shell = shellOf(payload && payload.tool_name);
      if (typeof raw !== 'string' && shell !== null) {
        // H-52(5) / H-07: a shell call whose command cannot be read is
        // refused, not waved through.
        process.stderr.write('quality-gate: shell call without a readable command; blocking.\n');
        emitBlock(UNREADABLE_COMMAND);
        return;
      }
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
      verdict = classify(command, ctx, shell);
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

module.exports = { classify, parseSimple, shellOf };

if (require.main === module) main();
