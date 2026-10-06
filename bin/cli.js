#!/usr/bin/env node
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { printHeader } = require('../lib/utils');

// H-10: locate the review-budget script installed in the project (config key, then .claude, then .codex).
function findProjectReviewBudget(cwd) {
  const fs = require('node:fs');
  const path = require('node:path');
  const candidates = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(cwd, '.ai-dev-helm.json'), 'utf8'));
    if (typeof config.reviewBudgetScript === 'string' && config.reviewBudgetScript) candidates.push(path.resolve(cwd, config.reviewBudgetScript));
  } catch { /* no config */ }
  candidates.push(path.join(cwd, '.claude', 'hooks', 'review-budget.cjs'), path.join(cwd, '.codex', 'hooks', 'review-budget.cjs'));
  return candidates.find((file) => fs.existsSync(file));
}

yargs(hideBin(process.argv))
  .scriptName('ai-dev-helm')
  .usage('$0 <command> [options]')
  .command(
    'init',
    'Set up development foundation in a project',
    (yargs) => {
      return yargs
        .option('dry-run', {
          type: 'boolean',
          describe: 'Show what would be done without making changes',
          default: false,
        })
        .option('yes', {
          alias: 'y',
          type: 'boolean',
          describe: 'Never prompt; use defaults for anything not given (project name = directory name, tools = claude-code, skills = all)',
          default: false,
        })
        .option('project-name', { type: 'string', describe: 'Project name (non-interactive)' })
        .option('tools', { type: 'string', describe: 'Comma-separated: claude-code,codex,cursor' })
        .option('stacks', { type: 'string', describe: 'Comma-separated tech stacks' })
        .option('skills', { type: 'string', describe: 'all | superpowers | project | comma-separated project skill names' })
        .option('verbose', {
          type: 'boolean',
          describe: 'Show detailed output and stack traces on error',
          default: false,
        });
    },
    async (argv) => {
      printHeader();
      console.log('Project initialization mode');
      console.log('');
      const { doInit } = require('../lib/init');
      await doInit({
        dryRun: argv.dryRun,
        yes: argv.yes,
        projectName: argv.projectName,
        tools: argv.tools,
        stacks: argv.stacks,
        skills: argv.skills,
      });
    }
  )
  .command(
    'personal',
    'Apply global settings to personal environment',
    (yargs) => {
      return yargs
        .option('verbose', {
          type: 'boolean',
          describe: 'Show detailed output and stack traces on error',
          default: false,
        })
        .option('upgrade-model', {
          type: 'boolean',
          describe: 'Force-upgrade Claude model version from template (skip confirmation)',
          default: false,
        });
    },
    async (argv) => {
      printHeader();
      const { doPersonal } = require('../lib/personal');
      await doPersonal({ upgradeModel: argv.upgradeModel });
    }
  )
  .command(
    'lint [paths..]',
    'Run the cross-cutting text-level linter',
    (yargs) => {
      return yargs
        .positional('paths', {
          type: 'string',
          array: true,
          describe: 'Files or directories to lint (default: whole project)',
        })
        .option('config', {
          type: 'string',
          describe: 'Explicit config file path (.ai-dev-helm-lint.json)',
        })
        .option('checks', {
          type: 'string',
          describe: 'Comma-separated check names to run',
        })
        .option('json', {
          type: 'boolean',
          describe: 'Output violations as a JSON array',
          default: false,
        })
        .option('verbose', {
          type: 'boolean',
          describe: 'Show detailed output and stack traces on error',
          default: false,
        });
    },
    (argv) => {
      if (!argv.json) {
        printHeader();
      }
      const { runLint } = require('../lib/lint/runner');
      const only = argv.checks
        ? String(argv.checks)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const result = runLint({
        dir: process.cwd(),
        paths: argv.paths || [],
        configPath: argv.config,
        only,
        json: argv.json,
      });
      console.log(result.output);
      if (argv.json) {
        for (const warning of result.warnings) {
          console.error(`warning: ${warning}`);
        }
      }
      for (const error of result.errors) {
        console.error(`error: ${error}`);
      }
      // exitCode + natural exit, not process.exit(): stdout writes are
      // asynchronous when piped, and process.exit() discards the pending
      // buffer — truncating --json output mid-document.
      process.exitCode = result.exitCode;
    }
  )
  .command(
    'quality-context',
    'Generate the shared context pack for a quality-check review cycle',
    (yargs) => {
      return yargs
        .option('cycle', {
          type: 'number',
          describe: 'Cycle number (1-based)',
          demandOption: true,
        })
        .option('base', {
          type: 'string',
          describe: 'Base ref the diff is taken against. Default: origin/main (or origin/master); without a remote-tracking trunk, the local main (or master)',
        })
        .option('out', {
          type: 'string',
          describe: 'Output directory (<scratchpad>/quality-check), must be outside the repository. Default: OS temp dir. The pack contains the full diff - protect or delete it',
        })
        .option('check-untracked', {
          type: 'boolean',
          describe: 'quality-check Step 6: build nothing; check that no file untracked at cycle <N>\'s review is now part of the change (exit 1 if one is)',
          default: false,
        })
        .option('verbose', {
          type: 'boolean',
          describe: 'Show detailed output and stack traces on error',
          default: false,
        });
    },
    (argv) => {
      const { buildContextPack, checkUntrackedReviewGap } = require('../lib/quality-check-context');
      if (argv.checkUntracked) {
        try {
          const gap = checkUntrackedReviewGap({ dir: process.cwd(), cycle: argv.cycle, baseRef: argv.base, outDir: argv.out });
          if (gap.ok) {
            console.log(`untracked-check: OK - none of the ${gap.untrackedAtReview} file(s) untracked at cycle ${argv.cycle}'s review is part of the change`);
          } else {
            for (const name of gap.gap) console.log(`  ${name}`);
            console.log('Create no flag and push nothing. For each name: if it belongs to the change, rebuild the context as a new cycle and redo the review. If it does not (the user\'s file), keep the file and take it out of the change - its content stays in the history and goes up with a push: if it is only staged, git rm --cached -- <names> is enough; if it is in the last commit and not pushed yet, git rm --cached -- <names>, then git commit --amend --no-edit (when that commit holds only the files listed here, git reset --soft HEAD~1, then git rm --cached -- <names>); if it is in an earlier commit or already pushed, stop and name the files (exception X3). Then run this check again. If unsure, stop and ask the owner, naming the files.');
            console.log(`untracked-check: NG - ${gap.gap.length} file(s) untracked (so not reviewed) at cycle ${argv.cycle} are now part of the change (listed above)`);
            process.exitCode = 1;
          }
        } catch (err) {
          // Not a verdict: exit 2, never the NG's 1.
          console.error(`Error: ${err.message}`);
          console.error('No verdict. If the context has to be rebuilt, rebuild it as a new cycle and redo the review: rebuilding the same cycle loses the untracked list of the review and lets this check pass unseen.');
          process.exitCode = 2;
        }
        return;
      }
      let result;
      try {
        result = buildContextPack({
          dir: process.cwd(),
          cycle: argv.cycle,
          baseRef: argv.base,
          outDir: argv.out,
        });
      } catch (err) {
        console.error(`Error: ${err.message}`);
        if (argv.verbose) console.error(err.stack);
        process.exitCode = 1;
        return;
      }
      console.log(`context: ${result.contextPath}`);
      if (result.measurementPath) console.log(`measurements: ${result.measurementPath} (helper timing and on-disk inventory; not runtime token usage)`);
      console.log(`changed files: ${result.names.length} (untracked, not part of the change: ${result.untracked.length}), diff ${result.diffLines} lines${result.diffInline ? ' (inline)' : ' -> diff.patch'}`);
      console.log(`snapshot: ${result.snapshotDir} (${result.snapshotCopied.length} files${result.snapshotSkipped.length ? `, ${result.snapshotSkipped.length} not copied` : ''})${result.replacedSnapshot ? ' - replaced the previous snapshot of this cycle' : ''}`);
      if (result.fixDiff) {
        console.log(`fix diff: ${result.fixDiff.path} (${result.fixDiff.files.length} files)`);
      } else if (result.fixDiffSkippedReason) {
        console.log(`fix diff: not generated - ${result.fixDiffSkippedReason}`);
      }
      if (result.findingsError) {
        console.log(`findings: previous findings.json unreadable - ${result.findingsError}`);
      }
      if (result.untracked.length > 0) {
        const shown = result.untracked.slice(0, 20).join(', ');
        const more = result.untracked.length > 20 ? ` ... and ${result.untracked.length - 20} more` : '';
        console.log(`WARNING: ${result.untracked.length} untracked file(s) are not part of the reviewed change: ${shown}${more}. If any belongs to the change, git add it (git add -N is enough) and rebuild the context.`);
      }
      if (result.untrackedOverLimit) {
        console.log(`warning: ${result.untracked.length} untracked files (not reviewed, not snapshotted) - fix .gitignore if these are build outputs; commit what belongs to the change`);
      }
      console.log(`integrity: ${result.integrityOk ? 'ok' : 'MISMATCH - name-only list and diff headers differ'}`);
      if (!result.integrityOk) process.exitCode = 1;
    }
  )
  .command(
    'harness-inventory',
    'Read-only inventory of installed harness files and optional distributor baseline',
    (yargs) => yargs
      .option('dir', { type: 'string', describe: 'Consumer directory', default: process.cwd() })
      .option('baseline', { type: 'string', describe: 'Unpacked distributor for comparison (caller must verify its version)' }),
    (argv) => {
      try {
        const { inventoryHarness } = require('../lib/harness-diagnostics');
        console.log(JSON.stringify(inventoryHarness({ projectDir: argv.dir, baselineDir: argv.baseline }), null, 2));
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }
    }
  )
  .command(
    'link-skills',
    'Create missing .claude/.codex/.cursor skills links (junction on Windows, symlink elsewhere); never overwrites a real directory. Run after clone / git worktree add',
    (yargs) => yargs
      .option('dir', { type: 'string', describe: 'Project directory', default: process.cwd() })
      .option('tools', { type: 'string', describe: 'Comma-separated: claude,codex,cursor (default: runtimes present in the project)' })
      .option('dry-run', { type: 'boolean', default: false, describe: 'Report only; write nothing' }),
    (argv) => {
      try {
        const { linkSkills } = require('../lib/link-skills');
        const tools = argv.tools ? String(argv.tools).split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        const result = linkSkills({ dir: argv.dir, tools, dryRun: argv.dryRun });
        console.log(result.lines.join(String.fromCharCode(10)));
        process.exitCode = result.exitCode;
      } catch (error) {
        console.error('Error: ' + error.message);
        process.exitCode = 1;
      }
    }
  )
  .command(
    'integrate-check',
    'Read-only pre-check of the remote-less integration, run in the feature worktree: the main checkout is on the trunk with no tracked change, the trunk is an ancestor, nothing there stands at a path the feature adds, and no skip-worktree / assume-unchanged file there is one the feature changes (exit 0 OK, 1 problems found, 2 error; the last line is the verdict). Changes nothing',
    (yargs) => yargs
      .option('main', { type: 'string', demandOption: true, describe: 'The checkout that has the trunk open (a relative path is resolved against the current directory)' })
      .option('trunk', { type: 'string', default: 'main', describe: 'Trunk branch name' })
      .option('dir', { type: 'string', describe: 'Feature worktree', default: process.cwd() }),
    (argv) => {
      try {
        const { integrateCheck } = require('../lib/integrate-check');
        const result = integrateCheck({ dir: argv.dir, main: argv.main, trunk: argv.trunk });
        console.log(result.lines.join(String.fromCharCode(10)));
        process.exitCode = result.exitCode;
      } catch (error) {
        console.error('Error: ' + error.message);
        process.exitCode = 2;
      }
    }
  )
  .command(
    'hook-selftest',
    'Run the bundled decision table against the hooks installed in the project (exit 0 all pass, 1 any mismatch)',
    (yargs) => yargs.option('dir', { type: 'string', describe: 'Project directory', default: process.cwd() }),
    (argv) => {
      try {
        const { runHookSelftest } = require('../lib/hook-selftest');
        const result = runHookSelftest({ dir: argv.dir });
        console.log(result.lines.join(String.fromCharCode(10)));
        process.exitCode = result.exitCode;
      } catch (error) {
        console.error('Error: ' + error.message);
        process.exitCode = 1;
      }
    }
  )
  .command(
    'codex-trust',
    'Read-only check that Codex trusts the project and its .codex/hooks.json hooks (exit 0 ok, 1 action required, 2 unreadable)',
    (yargs) => yargs
      .option('dir', { type: 'string', describe: 'Project directory', default: process.cwd() })
      .option('codex-home', { type: 'string', describe: 'Codex config location to read (default: CODEX_HOME, then ~/.codex)' }),
    (argv) => {
      try {
        const { checkCodexTrust } = require('../lib/codex-trust');
        const result = checkCodexTrust({ projectDir: argv.dir, codexHome: argv.codexHome });
        console.log(result.lines.join('\n'));
        process.exitCode = result.exitCode;
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 2;
      }
    }
  )
  .command(
    'quality-report',
    'Normalize historical quality report findings to stdout without modifying the input',
    (yargs) => yargs.option('input', { type: 'string', demandOption: true, describe: 'Quality report JSON file' }),
    (argv) => {
      try {
        const fs = require('node:fs');
        const { normalizeQualityReport } = require('../lib/quality-report');
        const input = JSON.parse(fs.readFileSync(argv.input, 'utf8').replace(/^\uFEFF/, ''));
        const { report, warnings } = normalizeQualityReport(input);
        console.log(JSON.stringify(report, null, 2));
        for (const warning of warnings) console.error(`warning: ${warning}`);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }
    }
  )
  .command(
    'review-budget <action>',
    'Reserve, extend or inspect review-only round budgets (shared by Claude Code and Codex)',
    (yargs) => yargs
      .positional('action', { choices: ['begin', 'status', 'extend'], type: 'string' })
      .option('phase', { choices: ['requirements', 'design', 'plan', 'quality', 'production', 'mutation'], type: 'string' })
      .option('roles', { type: 'string', describe: 'Comma-separated review roster' })
      .option('limit', { type: 'number', describe: 'Lower review ceiling (1-3); cannot raise an existing ceiling' })
      .option('rounds', { type: 'number', describe: 'extend: rounds to add after the owner approved exceeding the limit (1-3)' })
      .option('reason', { type: 'string', describe: 'extend: the owner approval, quoted (10-500 characters)' }),
    (argv) => {
      try {
        const words = [argv.action]; // rebuilt from parsed values so --phase=design works too
        for (const key of ['phase', 'roles', 'limit', 'rounds', 'reason']) if (argv[key] !== undefined) words.push(`--${key}`, String(argv[key]));
        // Prefer the project's own copy of the hook (same state, same rules as the hook that gates reviews).
        const script = findProjectReviewBudget(process.cwd());
        if (script) {
          // A project hook from 3.2.x has no extend; it would read stdin as a hook event instead of failing.
          if (argv.action === 'extend' && !/function extendLimit/.test(require('node:fs').readFileSync(script, 'utf8'))) {
            console.error('Error: the project review-budget hook is older and does not support extend; run harness-upgrade to update it.');
            process.exitCode = 1;
            return;
          }
          const run = require('node:child_process').spawnSync(process.execPath, [script, ...words], { stdio: ['ignore', 'inherit', 'inherit'] });
          process.exitCode = run.status === null ? 1 : run.status;
          return;
        }
        console.error('Warning: no project review-budget script found (.ai-dev-helm.json reviewBudgetScript, .claude/hooks, .codex/hooks); using the bundled one.');
        const budget = require('../templates/hooks/review-budget.cjs');
        console.log(JSON.stringify(budget.runCommand(words), null, 2));
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }
    }
  )
  .demandCommand(1, 'Please specify a command: init, personal, lint, quality-context, harness-inventory, link-skills, integrate-check, hook-selftest, codex-trust, quality-report, or review-budget')
  .strict()
  .help()
  .version(require('../package.json').version)
  .fail((msg, err, yargs) => {
    if (err) {
      console.error(`Error: ${err.message}`);
      if (process.argv.includes('--verbose')) {
        console.error(err.stack);
      }
      console.error('');
      console.error('Run with --verbose for more details.');
    } else {
      console.error(msg);
      console.error('');
      yargs.showHelp();
      // A usage error (unknown argument, missing option) is exit 2, so that a
      // command whose exit 1 means 'found a problem' (integrate-check) is never
      // confused with a mistyped call (3.4.3).
      process.exit(2);
    }
    process.exit(1);
  })
  .parse();

process.on('unhandledRejection', (err) => {
  console.error(`Error: ${err && err.message ? err.message : err}`);
  if (process.argv.includes('--verbose')) {
    console.error(err && err.stack ? err.stack : '');
  }
  process.exit(1);
});
