const { classify } = require('../templates/hooks/quality-gate.cjs');

// 3.7.0 (C3i): MovieMarketer's local quality-gate patches, taken into the distributed hook, with the regression cases
// moved from its .claude/hooks/quality-gate.test.cjs (the [MM-PATCH 3] / [MM-PATCH 11] rows):
//   MM-PATCH 3  - `git push --dry-run` / `-n` publishes nothing, so it is not gated;
//   MM-PATCH 11 - a merge / pull / rebase on ANOTHER line of the command is a HEAD mover for a push or merge that
//                 reaches the trunk (design decision 4). The one distributed test whose expectation this changes is
//                 in quality-gate.test.js ("refuses a merge on another line before a push to main").

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEED_FLAG = /Quality check not passed/;
const NOT_SIMPLE = /not in the simple form/;
const SPLIT = /Split this into separate commands/;

const ctxOf = (over = {}) => {
  const values = {
    branch: 'feat',
    head: HEAD,
    flag: null,
    isAncestor: false,
    diffSinceFlag: null,
    diffSinceBase: { files: ['src/app.js'], overrideChanged: false },
    fullRef: (name) => (name.startsWith('refs/') ? name : `refs/remotes/${name}`),
    localAhead: () => 0,
    ...over,
  };
  const ctx = {};
  for (const key of Object.keys(values)) Object.defineProperty(ctx, key, { get: () => values[key], enumerable: true });
  return ctx;
};
const flagged = (over = {}) => ctxOf({ flag: { commit: HEAD }, ...over });
const onTrunk = (over = {}) => flagged({ branch: 'main', ...over });

const check = (rows) => {
  for (const [command, ctx, expected, reason, shell = null] of rows) {
    const verdict = classify(command, ctx, shell);
    expect(verdict.decision, `${JSON.stringify(command)}${shell ? ` (${shell})` : ''}: ${verdict.reason || ''}`).toBe(expected);
    if (reason) expect(verdict.reason, JSON.stringify(command)).toMatch(reason);
  }
};

describe('MM-PATCH 3: a dry-run push publishes nothing', () => {
  test('--dry-run / -n pushes to main pass without a flag, even with a force flag or a mover', () => {
    // Break: without the patch each of these asks for a quality check (or refuses the force push / the commit).
    check([
      ['git push --dry-run origin HEAD:main', ctxOf(), 'allow'],
      ['git push -n origin HEAD:main', ctxOf(), 'allow'],
      ['git push -f --dry-run origin HEAD:main', ctxOf(), 'allow'],
      ['git push --dry-run origin main', ctxOf({ branch: 'main' }), 'allow'],
      ['git push --dry-run -- --no-dry-run origin HEAD:main', ctxOf(), 'allow'], // after `--` it is a refspec word
      ['git commit -am wip && git push --dry-run origin HEAD:main', ctxOf(), 'allow'],
    ]);
  });

  test('the exemption is exact and per push: a negation, a bundle, `--` or another push keeps the gate', () => {
    check([
      ['git push --dry-run --no-dry-run origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
      ['git push -n --no-dry-run origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
      ['git push --no-dry-run --dry-run origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
      ['git push origin HEAD:main # --dry-run', ctxOf(), 'block', NOT_SIMPLE],
      ['git push --dry-run origin HEAD:main && git push origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
      ['git push -nv origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
      ['git push -- --dry-run origin HEAD:main', ctxOf(), 'block', NEED_FLAG],
    ]);
  });
});

describe('MM-PATCH 11: a merge, pull or rebase on another line moves HEAD before the push', () => {
  test('refuses it before a push to main or gh pr merge, on any branch and in either shell, even with a flag', () => {
    // Break: until 3.6.0 the lines were judged one by one, each against the HEAD before the merge / pull / rebase.
    check([
      ['git merge origin/main\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git pull origin main\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git rebase origin/main\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git pull --rebase origin main\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git pull --ff-only\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git merge origin/main\ngh pr merge 1 --squash', flagged(), 'block', SPLIT],
      ['git pull origin main\ngh pr merge 1 --squash', flagged(), 'block', SPLIT],
      ['git rebase origin/main\r\ngit push origin HEAD:main', flagged(), 'block', SPLIT],
      ['git merge origin/main\ngit push origin HEAD:main', flagged(), 'block', SPLIT, 'powershell'],
      ['git pull origin main\r\ngh pr merge 1 --squash', flagged(), 'block', SPLIT, 'powershell'],
    ]);
  });

  test('refuses it before a refspec-less push once that push is gated: on the trunk, or with @{push} on it', () => {
    check([
      ['git pull\ngit push', onTrunk(), 'block', SPLIT],
      ['git pull origin main\ngit push', onTrunk(), 'block', SPLIT],
      ['git pull --rebase\ngit push', onTrunk(), 'block', SPLIT],
      ['git merge origin/main\ngit push', onTrunk(), 'block', SPLIT],
      ['git rebase origin/main\ngit push', onTrunk(), 'block', SPLIT],
      ['git pull\ngit push origin HEAD', onTrunk(), 'block', SPLIT],
      ['git pull\ngit push -u origin HEAD', onTrunk(), 'block', SPLIT],
      ['git pull\ngit push origin', onTrunk(), 'block', SPLIT],
      ['git pull\r\ngit push', onTrunk(), 'block', SPLIT],
      ['git pull\ngit push', onTrunk(), 'block', SPLIT, 'powershell'],
      ['git merge origin/main\r\ngit push', onTrunk(), 'block', SPLIT, 'powershell'],
      ['git pull\ngit push', flagged({ branch: 'featup', pushTarget: 'origin/main' }), 'block', SPLIT],
      // The push alone is judged as before.
      ['git push', onTrunk(), 'allow'],
      ['git push', flagged({ branch: 'featup', pushTarget: 'origin/main' }), 'allow'],
      ['git push', ctxOf({ branch: 'featup', pushTarget: 'origin/main' }), 'block', NEED_FLAG],
    ]);
  });

  test('keeps the everyday feature-branch sync and a push to the branch\'s own upstream on the next line', () => {
    check([
      ['git merge origin/main\ngit push', ctxOf(), 'allow'],
      ['git rebase origin/main\ngit push --force-with-lease', ctxOf(), 'allow'],
      ['git pull\ngit push', ctxOf(), 'allow'],
      ['git pull --rebase origin main\ngit push --force-with-lease', ctxOf(), 'allow'],
      ['git pull\ngit push -u origin HEAD', ctxOf(), 'allow'],
      ['git pull\r\ngit push', ctxOf(), 'allow', null, 'powershell'],
    ]);
  });
});
