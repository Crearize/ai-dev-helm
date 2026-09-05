#!/usr/bin/env node
'use strict';

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { printHeader } = require('../lib/utils');

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
      await doInit({ dryRun: argv.dryRun });
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
    'review-budget <action>',
    'Reserve or inspect review-only round budgets (shared by Claude Code and Codex)',
    (yargs) => yargs
      .positional('action', { choices: ['begin', 'status'], type: 'string' })
      .option('phase', { choices: ['requirements', 'design', 'plan', 'quality'], type: 'string' })
      .option('roles', { type: 'string', describe: 'Comma-separated review roster' })
      .option('limit', { type: 'number', describe: 'Lower review ceiling (1-3); cannot raise an existing ceiling' }),
    (argv) => {
      const budget = require('../templates/hooks/review-budget.cjs');
      try {
        const result = argv.action === 'status' ? budget.status() : budget.beginRound({
          phase: argv.phase, roles: argv.roles?.split(','), limit: argv.limit,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }
    }
  )
  .demandCommand(1, 'Please specify a command: init, personal, lint, quality-context, or review-budget')
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
