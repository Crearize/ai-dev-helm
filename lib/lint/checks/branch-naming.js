'use strict';

/**
 * Lint check: branch naming convention (Catalog C7). Repo scope.
 *
 * The current branch (`git rev-parse --abbrev-ref HEAD`) must match
 * `new RegExp(options.pattern)`. No violation when:
 *   - not inside a git repo (git returns null),
 *   - detached HEAD (result is the literal `HEAD`),
 *   - the branch is listed in `options.exempt` (defaults, from config.js,
 *     include main/master/develop).
 *
 * Fail-closed: a missing or invalid `pattern` yields a config violation
 * instead of throwing or silently passing.
 */

module.exports = {
  name: 'branch-naming',
  defaultEnabled: true,
  scope: 'repo',

  /**
   * @param {{repoRoot: string,
   *          options?: {pattern?: string, exempt?: string[]},
   *          git: (args: string[]) => string|null}} ctx
   * @returns {Array<{file: null, line: null, check: string,
   *          message: string}>}
   */
  run(ctx) {
    const options = ctx.options || {};
    const branch = ctx.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null || branch === '' || branch === 'HEAD') {
      return []; // not a repo / no commits / detached HEAD
    }

    const exempt = Array.isArray(options.exempt) ? options.exempt : [];
    if (exempt.includes(branch)) {
      return [];
    }

    const violation = (message) => [
      {
        file: null,
        line: null,
        check: 'branch-naming',
        message: `${message} (Catalog: C7)`,
      },
    ];

    let re;
    try {
      if (typeof options.pattern !== 'string') {
        throw new Error('pattern must be a string');
      }
      re = new RegExp(options.pattern);
    } catch {
      return violation(`invalid branch-naming pattern '${options.pattern}'`);
    }

    if (!re.test(branch)) {
      return violation(`branch name '${branch}' does not match pattern`);
    }
    return [];
  },
};
