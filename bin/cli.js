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
  .demandCommand(1, 'Please specify a command: init, personal, or lint')
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
