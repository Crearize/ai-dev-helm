import { exec, execSync, spawn, spawnSync } from 'child_process';
import childProcess from 'child_process';

// Violation 1: user-supplied branch name interpolated into a shell command
export function checkout(branch) {
  execSync(`git checkout ${branch}`);
}

// Violation 2: interpolation through a namespaced receiver
export function listDir(dir) {
  childProcess.exec(`ls -la ${dir}`, (err) => {
    if (err) throw err;
  });
}

// Violation 3: command built by string concatenation
export function grepLog(pattern) {
  exec('cat /var/log/app.log | grep ' + pattern, () => undefined);
}

// Violation 4: interpolated command line passed to spawn with shell:true
export function runShell(dir) {
  spawn(`ls -la ${dir}`, { shell: true });
}

// Violation 5: spawnSync with a concatenated command line
export function kill(pid) {
  spawnSync('kill -9 ' + pid, { shell: true });
}
