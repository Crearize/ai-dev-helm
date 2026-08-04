#!/usr/bin/env node
'use strict';

// PreToolUse hook: block `git push` until the quality check has passed.
//
// Reads the hook payload from stdin, and if the Bash command is a git push,
// requires the .quality-check-passed flag file (created by /quality-check)
// to exist in the project root. The flag is consumed on a successful push
// so every push requires a fresh quality check.
//
// Implemented in Node (a documented prerequisite of ai-dev-helm) instead of
// jq/bash so the hook works identically on Windows (cmd/PowerShell), macOS,
// and Linux. See https://github.com/Crearize/ai-dev-helm/issues/63.

const fs = require('fs');

const FLAG_FILE = '.quality-check-passed';
// A git push anywhere in the command line, including chained commands
// (`cd x && git push`), subshells, and `git -C <dir> push`.
const GIT_PUSH_RE = /(^|[;&|(])\s*git\s+(-C\s+\S+\s+)?push([\s;&|)]|$)/;

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
    // Malformed payload: never block unrelated commands.
    return;
  }

  if (!GIT_PUSH_RE.test(command)) {
    return;
  }

  if (!fs.existsSync(FLAG_FILE)) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason: 'Quality check not passed. Run /quality-check before pushing.',
      })
    );
    return;
  }

  fs.rmSync(FLAG_FILE, { force: true });
});
