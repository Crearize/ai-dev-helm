import { exec, execSync } from 'child_process';
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

// Violation 3: interpolation in the middle of a longer pipeline
export function grepLog(pattern: string): void {
  exec(`cat /var/log/app.log | grep ${pattern} | head -20`, () => undefined);
}
