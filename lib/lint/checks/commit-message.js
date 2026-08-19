'use strict';

/**
 * Lint check: commit message convention (Catalog C7). Repo scope.
 *
 * Range: commits since `merge-base origin/main HEAD`, falling back to the
 * local `main` merge-base, then to the last 20 commits (`HEAD~20..HEAD`;
 * when the repo has fewer commits, all of them). Not a git repo -> no
 * violations. Merge-base equal to HEAD (branch at main) -> empty range.
 *
 * Each commit subject in the range must match `new RegExp(options.pattern)`
 * (default conventional-commit style, from config.js). Skipped:
 *   - merge commits (2+ parents),
 *   - revert commits (`Revert ` prefix or `^revert\b`, case-insensitive).
 *
 * Fail-closed: a missing or invalid `pattern` yields a config violation
 * instead of throwing or silently passing.
 */

/** One `git log` line per commit: shorthash NUL parents NUL subject */
const LOG_FORMAT = '%h%x00%p%x00%s';

/** Parse `git log --format=LOG_FORMAT` output into commit records */
function parseLog(out) {
  const commits = [];
  for (const line of out.split('\n')) {
    if (!line) {
      continue;
    }
    const parts = line.split('\0');
    if (parts.length < 3) {
      continue; // malformed line: ignore
    }
    commits.push({
      hash: parts[0],
      parents: parts[1].split(' ').filter(Boolean),
      subject: parts.slice(2).join('\0'),
    });
  }
  return commits;
}

module.exports = {
  name: 'commit-message',
  defaultEnabled: true,
  scope: 'repo',

  /**
   * @param {{repoRoot: string, options?: {pattern?: string},
   *          git: (args: string[]) => string|null}} ctx
   * @returns {Array<{file: null, line: null, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const options = ctx.options || {};
    const { git } = ctx;

    let mergeBase = git(['merge-base', 'origin/main', 'HEAD']);
    if (mergeBase === null) {
      mergeBase = git(['merge-base', 'main', 'HEAD']);
    }

    let out;
    if (mergeBase !== null) {
      out = git(['log', `--format=${LOG_FORMAT}`, `${mergeBase}..HEAD`]);
    } else {
      out = git(['log', `--format=${LOG_FORMAT}`, 'HEAD~20..HEAD']);
      if (out === null) {
        // fewer than 21 commits (or no commits/repo): scan from the root
        out = git(['log', `--format=${LOG_FORMAT}`, 'HEAD']);
      }
    }
    if (out === null || out === '') {
      return []; // not a git repo, or empty range
    }

    const violation = (message) => ({
      file: null,
      line: null,
      check: 'commit-message',
      message: `${message} (Catalog: C7)`,
    });

    let re;
    try {
      if (typeof options.pattern !== 'string') {
        throw new Error('pattern must be a string');
      }
      re = new RegExp(options.pattern);
    } catch {
      return [violation(`invalid commit-message pattern '${options.pattern}'`)];
    }

    const violations = [];
    for (const commit of parseLog(out)) {
      if (commit.parents.length >= 2) {
        continue; // merge commit
      }
      if (commit.subject.startsWith('Revert ') || /^revert\b/i.test(commit.subject)) {
        continue; // revert commit
      }
      if (!re.test(commit.subject)) {
        violations.push(
          violation(`commit ${commit.hash}: message does not match pattern`)
        );
      }
    }
    return violations;
  },
};
