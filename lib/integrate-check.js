'use strict';

/**
 * `ai-dev-helm integrate-check` (3.4.3, E1): the read-only pre-check of the
 * remote-less integration (branch-workflow "リモートの無いプロジェクトの取り込み").
 *
 * Run in the feature worktree, with the checkout that has the trunk open as
 * `--main`. It changes nothing: no push, merge, switch, file move or delete -
 * the integration itself stays in plain git commands the quality gate sees.
 * git is called with argument arrays (no shell), and every list is read with
 * `-z`, so quoting, globs, encodings and the shell in use do not matter.
 *
 * It reports, with names:
 *   1. the main checkout is not on the trunk;
 *   2. uncommitted changes to tracked files in the main checkout;
 *   3. the trunk is not an ancestor of the feature (HEAD);
 *   4. for each path the feature adds (a rename's target counts as added),
 *      anything in the main checkout that git would have to overwrite or that
 *      would stop `git switch <trunk>`: an untracked or ignored file at the
 *      path, a directory there holding untracked or ignored files, or a parent
 *      of the path that is a file. Case differences follow the file system
 *      (whatever `lstat` resolves);
 *   5. a file the main checkout marks skip-worktree or assume-unchanged (its
 *      local edits are hidden from `git status`) that the feature changes.
 * The paths compared are those `git switch <trunk>` will write: the trunk's
 * tree against HEAD's (two points, not `trunk...HEAD`). Unrelated untracked
 * files are not looked at. Every git call runs with GIT_OPTIONAL_LOCKS=0, so
 * the check never takes index.lock while the user works in the main checkout.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class IntegrateCheckError extends Error {}

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error) throw new IntegrateCheckError(`git ${args.join(' ')} failed in ${cwd}: ${r.error.message}`);
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new IntegrateCheckError(`git ${args.join(' ')} failed in ${cwd}: ${r.err || `exit ${r.status}`}`);
  return r.out;
}

const zList = (out) => out.split('\0').filter((s) => s !== '');

// `status --porcelain=v1 -z`: "XY path\0", and a rename / copy adds "orig\0".
function trackedChanges(main) {
  const parts = gitOk(main, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    out.push({ status: xy, path: rec.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return out;
}

function realTop(dir) {
  return fs.realpathSync(gitOk(dir, ['rev-parse', '--show-toplevel']).trim());
}

function commonDir(dir) {
  const raw = gitOk(dir, ['rev-parse', '--git-common-dir']).trim();
  return fs.realpathSync(path.resolve(dir, raw));
}

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

// The name actually on disk for `rel` under `top`, component by component:
// the exact name if present, else the one the file system resolved (a case
// variant on a case-insensitive file system). null when nothing is there.
function actualPath(top, rel) {
  const parts = rel.split('/');
  const found = [];
  let dir = top;
  for (const part of parts) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    let name = names.includes(part) ? part : null;
    if (name === null) {
      if (!lstat(path.join(dir, part))) return null;
      name = names.find((n) => n.toLowerCase() === part.toLowerCase()) || part;
    }
    found.push(name);
    dir = path.join(dir, name);
  }
  return found.join('/');
}

const literal = (p) => `:(literal)${p}`;
const article = (word) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/**
 * @param {{ dir?: string, main: string, trunk?: string }} options `main` is
 *   resolved against the process's working directory, like any CLI path.
 * @returns {{ ok: boolean, problems: object[], lines: string[], exitCode: number }}
 */
function integrateCheck({ dir = process.cwd(), main, trunk = 'main' }) {
  if (!main) throw new IntegrateCheckError('--main <the checkout that has the trunk open> is required');
  const featureTop = realTop(dir);
  const mainTop = realTop(path.resolve(main));
  if (featureTop === mainTop) {
    throw new IntegrateCheckError('--main names this checkout; run integrate-check in the feature worktree and pass the main checkout as --main');
  }
  if (commonDir(featureTop) !== commonDir(mainTop)) {
    throw new IntegrateCheckError(`${mainTop} is not a worktree of the same repository as ${featureTop}`);
  }
  const trunkRef = `refs/heads/${trunk}`;
  if (git(featureTop, ['rev-parse', '--verify', '--quiet', trunkRef]).status !== 0) {
    throw new IntegrateCheckError(`branch ${trunk} does not exist`);
  }
  const featureBranch = git(featureTop, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
  if (featureBranch === trunk) throw new IntegrateCheckError(`this checkout is on ${trunk}; run integrate-check in the feature worktree`);

  const problems = [];
  const lines = [`integrate-check: ${featureBranch || 'HEAD (detached)'} -> ${trunk} (main checkout: ${mainTop})`];

  // 1. The main checkout has the trunk open.
  const mainBranch = git(mainTop, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
  if (mainBranch !== trunk) {
    problems.push({ kind: 'main-not-on-trunk', detail: mainBranch || 'detached HEAD' });
    lines.push(`NG  main checkout is on ${mainBranch || 'a detached HEAD'}, not ${trunk}`);
  } else {
    lines.push(`OK  main checkout is on ${trunk}`);
  }

  // 2. No uncommitted change to a tracked file in the main checkout.
  const changes = trackedChanges(mainTop);
  if (changes.length > 0) {
    for (const c of changes) problems.push({ kind: 'tracked-change', path: c.path, detail: c.status });
    lines.push(`NG  uncommitted changes to tracked files in the main checkout (${changes.length}):`);
    for (const c of changes) lines.push(`      ${c.status} ${c.path}`);
  } else {
    lines.push('OK  no uncommitted change to a tracked file in the main checkout');
  }

  // 3. The trunk is an ancestor of the feature.
  const ancestor = git(featureTop, ['merge-base', '--is-ancestor', trunkRef, 'HEAD']);
  if (ancestor.status === 1) {
    problems.push({ kind: 'not-ancestor' });
    lines.push(`NG  ${trunk} is not an ancestor of HEAD: merge ${trunk} into the feature (or rebase), re-run quality-check, then integrate`);
  } else if (ancestor.status !== 0) {
    throw new IntegrateCheckError(`git merge-base --is-ancestor failed: ${ancestor.err || `exit ${ancestor.status}`}`);
  } else {
    lines.push(`OK  ${trunk} is an ancestor of HEAD`);
  }

  // 4. Nothing in the main checkout stands where the feature adds a path.
  // What `git switch <trunk>` will write after the integration: the trunk's
  // tree against HEAD's. Two points, so a path the trunk and the feature both
  // added is not reported.
  const diffNames = (filter) => zList(gitOk(featureTop, ['diff', '--name-only', '-z', '--no-renames', `--diff-filter=${filter}`, trunkRef, 'HEAD', '--']));
  const added = diffNames('A');
  const deleted = new Set(diffNames('D'));
  const changedByFeature = new Set(diffNames('ACDMRTUXB'));
  const tracked = new Set(zList(gitOk(mainTop, ['ls-files', '-z'])));
  const untrackedUnder = (rel) => zList(gitOk(mainTop, ['ls-files', '-z', '--others', '--', literal(`${rel}/`)]));
  const ignored = (rel) => git(mainTop, ['check-ignore', '-q', '--no-index', '--', rel]).status === 0;
  // A tracked entry the feature deletes (a case-only rename, a file turned into a directory) is git's to replace.
  const replaceable = (rel) => tracked.has(rel) && deleted.has(rel);
  const clashes = [];
  for (const rel of added) {
    const parts = rel.split('/');
    let blocked = false;
    for (let i = 1; i < parts.length && !blocked; i++) {
      const prefix = parts.slice(0, i).join('/');
      const st = lstat(path.join(mainTop, prefix));
      if (!st) break;
      if (st.isDirectory()) continue;
      const actual = actualPath(mainTop, prefix) || prefix;
      if (replaceable(actual)) break;
      clashes.push({ kind: 'parent-is-file', path: rel, found: actual, detail: tracked.has(actual) ? 'tracked' : ignored(actual) ? 'ignored' : 'untracked' });
      blocked = true;
    }
    if (blocked) continue;
    const st = lstat(path.join(mainTop, rel));
    if (!st) continue;
    const actual = actualPath(mainTop, rel) || rel;
    if (st.isDirectory()) {
      // Empty directories and tracked contents the feature removes are git's to replace.
      const inside = untrackedUnder(actual);
      if (inside.length > 0) clashes.push({ kind: 'directory', path: rel, found: actual, detail: `${inside.length} untracked or ignored file(s)`, files: inside });
      continue;
    }
    if (replaceable(actual)) continue;
    if (tracked.has(actual)) {
      // Same name: staged in the main checkout, already reported as a tracked change.
      if (actual !== rel) clashes.push({ kind: 'tracked-case', path: rel, found: actual, detail: 'tracked in the main checkout under another case' });
      continue;
    }
    clashes.push({ kind: ignored(actual) ? 'ignored' : 'untracked', path: rel, found: actual });
  }
  if (clashes.length > 0) {
    problems.push(...clashes);
    lines.push(`NG  ${clashes.length} of the ${added.length} path(s) the feature adds collide with the main checkout:`);
    for (const c of clashes) {
      const where = c.kind === 'parent-is-file' || c.found === c.path ? c.path : `${c.path} (on disk: ${c.found})`;
      const label = { 'parent-is-file': `a parent of it is ${article(c.detail)} file: ${c.found}`, directory: `a directory with ${c.detail}`, 'tracked-case': c.detail, ignored: 'an ignored file', untracked: 'an untracked file' }[c.kind];
      lines.push(`      ${where}: ${label}`);
      for (const f of c.files || []) lines.push(`        ${f}`);
    }
  } else {
    lines.push(`OK  nothing in the main checkout stands at the ${added.length} path(s) the feature adds (other untracked files are not looked at)`);
  }

  // 5. Hidden local edits: skip-worktree (tag S) or assume-unchanged (a
  // lower-case tag) on a file that exists and that the feature changes.
  const hidden = [];
  for (const rec of zList(gitOk(mainTop, ['ls-files', '-v', '-z']))) {
    const tag = rec[0];
    const rel = rec.slice(2);
    if (!(tag === 'S' || (tag >= 'a' && tag <= 'z'))) continue;
    if (!changedByFeature.has(rel) || !lstat(path.join(mainTop, rel))) continue;
    hidden.push({ kind: tag === 'S' || tag === 's' ? 'skip-worktree' : 'assume-unchanged', path: rel });
  }
  if (hidden.length > 0) {
    problems.push(...hidden);
    lines.push(`NG  ${hidden.length} file(s) the feature changes are marked skip-worktree or assume-unchanged in the main checkout (local edits git status does not show):`);
    for (const h of hidden) lines.push(`      ${h.path}: ${h.kind}`);
  } else {
    lines.push('OK  no skip-worktree / assume-unchanged file in the main checkout that the feature changes');
  }

  const ok = problems.length === 0;
  const onlyNotAncestor = !ok && problems.every((pr) => pr.kind === 'not-ancestor');
  lines.push(ok
    ? 'integrate-check: OK - detach the main checkout and integrate (branch-workflow)'
    : onlyNotAncestor
      ? `integrate-check: NG (${trunk} is not an ancestor only) - merge ${trunk} into the feature, re-run quality-check, then run integrate-check again (not exception X3: the main checkout is not touched; do not stop)`
      : 'integrate-check: NG - change nothing; report the above in the final message and wait for the owner (exception X3)');
  return { ok, onlyNotAncestor, problems, lines, exitCode: ok ? 0 : 1 };
}

module.exports = { integrateCheck, IntegrateCheckError, actualPath };
