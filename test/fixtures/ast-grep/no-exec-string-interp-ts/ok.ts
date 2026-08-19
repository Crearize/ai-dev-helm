import { execFile, execFileSync, execSync } from 'child_process';

// OK: the recommended shape - argument array, no shell parsing
export function checkout(branch: string): void {
  execFileSync('git', ['checkout', branch]);
}

// OK: near-miss - a template literal with no interpolation at all
export function status(): void {
  execSync(`git status --porcelain`);
}

// OK: near-miss - a plain constant string command
export function version(): void {
  execSync('git --version');
}

// OK: near-miss - interpolation used for a message, not for a shell command
export function listDir(dir: string): void {
  execFile('ls', ['-la', dir], (err) => {
    if (err) throw new Error(`listing ${dir} failed`);
  });
}
