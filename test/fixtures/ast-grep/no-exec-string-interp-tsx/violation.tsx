import { exec, execSync, spawn, spawnSync } from 'child_process';
import childProcess from 'child_process';

// Violation 1: user-supplied branch name interpolated into a shell command
export function checkout(branch: string): void {
  execSync(`git checkout ${branch}`);
}

// Violation 2: interpolation through a namespaced receiver
export function listDir(dir: string): void {
  childProcess.exec(`ls -la ${dir}`, (err) => {
    if (err) throw err;
  });
}

// Violation 3: command built by string concatenation
export function grepLog(pattern: string): void {
  exec('cat /var/log/app.log | grep ' + pattern, () => undefined);
}

// Violation 4: interpolated command line passed to spawn with shell:true
export function runShell(dir: string): void {
  spawn(`ls -la ${dir}`, { shell: true });
}

// Violation 5: spawnSync with a concatenated command line
export function kill(pid: string): void {
  spawnSync('kill -9 ' + pid, { shell: true });
}
