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
          describe: 'Base ref the diff is taken against',
          default: 'origin/main',
        })
        .option('out', {
          type: 'string',
          describe: 'Output directory (<scratchpad>/quality-check), must be outside the repository. Default: OS temp dir. The pack contains the full diff - protect or delete it',
        })
        .option('verbose', {
          type: 'boolean',
          describe: 'Show detailed output and stack traces on error',
          default: false,
        });
    },
    (argv) => {
      const { buildContextPack } = require('../lib/quality-check-context');
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
      console.log(`changed files: ${result.names.length} (+ ${result.untracked.length} untracked), diff ${result.diffLines} lines${result.diffInline ? ' (inline)' : ' -> diff.patch'}`);
      console.log(`snapshot: ${result.snapshotDir} (${result.snapshotCopied.length} files${result.snapshotSkipped.length ? `, ${result.snapshotSkipped.length} not copied` : ''})${result.replacedSnapshot ? ' - replaced the previous snapshot of this cycle' : ''}`);
      if (result.fixDiff) {
        console.log(`fix diff: ${result.fixDiff.path} (${result.fixDiff.files.length} files)`);
      } else if (result.fixDiffSkippedReason) {
        console.log(`fix diff: not generated - ${result.fixDiffSkippedReason}`);
      }
      if (result.findingsError) {
        console.log(`findings: previous findings.json unreadable - ${result.findingsError}`);
      }
      if (result.untrackedOverLimit) {
        console.log(`warning: ${result.untracked.length} untracked files - only the first ${result.untrackedSnapshotted} untracked files snapshotted; fix .gitignore if these are build outputs`);
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
  .demandCommand(1, 'Please specify a command: init, personal, lint, quality-context, harness-inventory, codex-trust, quality-report, or review-budget')
  .strict()
  .help()
  .version()
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
