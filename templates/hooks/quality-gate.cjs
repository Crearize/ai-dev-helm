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
// Implemented in Node (a documented prerequisite of ai-dev-helm) so the hook
// works identically on Windows (cmd/PowerShell), macOS, and Linux.

const fs = require('fs');
const { execSync } = require('child_process');

const FLAG_FILE = '.quality-check-passed';

// Subcommand detection anywhere in the command line, including chained
// commands, subshells, and `git -C <dir> ...`. Group 2 captures the argument
// segment up to the next shell operator.
const GIT_PUSH_RE = /(^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?push\b([^;&|()]*)/;
const GIT_MERGE_RE = /(^|[;&|(])\s*git\s+(?:-C\s+\S+\s+)?merge\b([^;&|()]*)/;
const GH_PR_MERGE_RE = /(^|[;&|(])\s*gh\s+pr\s+merge\b([^;&|()]*)/;
const MERGE_CONTROL_RE = /\s--(abort|continue|quit|skip)\b/;

// Merges/pushes whose entire (non-empty) diff matches these paths skip the
// gate. Aligned with the self-improvement skill's reflection targets, minus
// user-facing docs (README/docs/documents stay under the reduced review).
const HARNESS_PATTERNS = [
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
  /^\.cursorrules$/,
  /^\.claude\//,
  /^\.codex\//,
  /^\.cursor\//,
  /^skills\/(project|superpowers)\//,
  /^\.github\/review-[^/]*\.md$/,
  /^documents\/development\/coding-rules\//,
];

function trySh(cmd, timeoutMs = 5000) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    }).trim();
  } catch {
    return null;
  }
}

function shOk(cmd, timeoutMs = 5000) {
  try {
    execSync(cmd, { stdio: 'ignore', timeout: timeoutMs });
    return true;
  } catch {
    return false;
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

function isHarnessOnly(files) {
  return (
    files.length > 0 &&
    files.every((f) => HARNESS_PATTERNS.some((re) => re.test(f)))
  );
}

function diffFiles(range) {
  const out = trySh(`git diff --name-only ${range}`);
  if (out === null) return null;
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function mergeBaseRef() {
  for (const ref of ['origin/main', 'origin/master']) {
    if (trySh(`git rev-parse --verify --quiet ${ref}`)) return ref;
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
    // and other flag values that are not refs.
    for (const ref of positionalArgs(mergeMatch[2])) {
      const sha = trySh(`git rev-parse --verify --quiet "${ref}"`);
      if (sha) return sha;
    }
    return null;
  }
  if (!isMainBranch(branch) || isPush) {
    // Feature-branch gh pr merge / any gated push: HEAD is the content.
    return trySh('git rev-parse --verify --quiet HEAD');
  }
  // gh pr merge while on main: resolve the PR head via gh (network call,
  // bounded timeout; failure means "cannot verify" and blocks).
  const ghMatch = command.match(GH_PR_MERGE_RE);
  if (ghMatch) {
    const prArg = positionalArgs(ghMatch[2])[0];
    if (prArg) {
      const head = trySh(
        `gh pr view "${prArg}" --json headRefName --jq .headRefName`,
        3000
      );
      if (head) {
        return (
          trySh(`git rev-parse --verify --quiet "origin/${head}"`) ||
          trySh(`git rev-parse --verify --quiet "${head}"`)
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

  const branch = trySh('git branch --show-current');
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
    if (files !== null && isHarnessOnly(files)) return;
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
    if (shOk(`git merge-base --is-ancestor ${flag.commit} HEAD`)) return;
    return block(
      'Code changed after the last quality check. Re-run /quality-check before merging.'
    );
  }

  const changed = diffFiles(`${flag.commit}..${tip}`);
  if (changed === null) {
    return block(
      'Cannot verify changes since the last quality check. Re-run /quality-check.'
    );
  }
  if (changed.length === 0 || isHarnessOnly(changed)) return;
  return block(
    'Code changed after the last quality check. Re-run /quality-check before merging.'
  );
});
