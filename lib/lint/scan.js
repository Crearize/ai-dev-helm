'use strict';

/**
 * Target file collection for `ai-dev-helm lint`.
 *
 * Inside a git repo, candidates come from
 * `git ls-files -z --cached --others --exclude-standard` run at the scan
 * directory (results are relative to it — scanning is scoped to the
 * invocation directory, not the repo root). Outside a git repo, a recursive
 * directory walk is used instead.
 *
 * All returned paths are `/`-separated, relative to the scan directory,
 * sorted and deduplicated. `node_modules/` and `.git/` segments are always
 * excluded; config `exclude` globs are applied on top.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Bytes inspected when sniffing for binary (NUL) content */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Default per-file size limit */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Convert a minimal glob pattern to an anchored RegExp over `/`-normalized
 * relative paths. Supported: `**` (any path segments), `*` (within a
 * segment), `?` (single non-separator char). A pattern ending in `/**` also
 * matches the bare directory prefix.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '');
  let suffix = '';
  if (p.endsWith('/**')) {
    p = p.slice(0, -3);
    suffix = '(?:/.*)?';
  }
  let source = '';
  let i = 0;
  while (i < p.length) {
    if (p.startsWith('**/', i)) {
      source += '(?:[^/]+/)*'; // zero or more whole segments
      i += 3;
    } else if (p.startsWith('**', i)) {
      source += '.*';
      i += 2;
    } else if (p[i] === '*') {
      source += '[^/]*';
      i += 1;
    } else if (p[i] === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${source}${suffix}$`);
}

/** Normalize a path to forward slashes and strip leading `./`, trailing `/` */
function normalizeRel(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** True when the path contains a node_modules or .git segment anywhere */
function hasExcludedSegment(relPath) {
  return relPath
    .split('/')
    .some((seg) => seg === 'node_modules' || seg === '.git');
}

/** True when `dir` is inside a git work tree */
function isInsideGitRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List candidate files via git, relative to `dir` (tracked + untracked,
 * respecting .gitignore). Deleted-but-still-cached entries survive here and
 * are dropped later when the file is stat'ed.
 */
function gitListFiles(dir) {
  const out = execFileSync(
    'git',
    ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return out.split('\0').filter(Boolean);
}

/** Recursively walk `root`, returning `/`-relative file paths */
function walkDir(root) {
  const files = [];
  const visit = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip silently
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  visit('');
  return files;
}

/**
 * Sniff the first bytes of a file for a NUL byte (binary marker).
 * @returns {boolean} true when the file looks binary
 */
function looksBinary(absPath, size) {
  const length = Math.min(size, BINARY_SNIFF_BYTES);
  if (length === 0) {
    return false;
  }
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(absPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, buf, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.subarray(0, bytesRead).includes(0);
}

/**
 * Collect lint target files.
 * @param {Object} opts
 * @param {string} opts.dir directory to scan (git-aware when inside a repo)
 * @param {string[]} [opts.paths] CLI positionals: restrict to these
 *   files/subtrees (Windows `\` separators accepted)
 * @param {string[]} [opts.exclude] glob patterns from config to exclude
 * @param {number} [opts.maxBytes] per-file size limit
 * @returns {{files: string[], skipped: Array<{file: string, reason: string}>}}
 */
function collectFiles({
  dir,
  paths = [],
  exclude = [],
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const root = path.resolve(dir);
  const candidates = isInsideGitRepo(root)
    ? gitListFiles(root)
    : walkDir(root);

  const excludeRes = exclude.map(globToRegExp);
  const restrictTo = paths.map(normalizeRel).filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    const rel = normalizeRel(candidate);
    if (!rel || hasExcludedSegment(rel)) {
      continue;
    }
    if (excludeRes.some((re) => re.test(rel))) {
      continue;
    }
    if (
      restrictTo.length > 0 &&
      !restrictTo.some((p) => rel === p || rel.startsWith(`${p}/`))
    ) {
      continue;
    }
    seen.add(rel);
  }

  const files = [];
  const skipped = [];
  for (const rel of [...seen].sort()) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // deleted-but-still-cached (or vanished): drop silently
    }
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size > maxBytes) {
      skipped.push({ file: rel, reason: 'too-large' });
      continue;
    }
    if (looksBinary(abs, stat.size)) {
      skipped.push({ file: rel, reason: 'binary' });
      continue;
    }
    files.push(rel);
  }

  return { files, skipped };
}

/**
 * Read a text file for lint checks.
 * @param {string} absPath
 * @returns {{content: string, eol: 'crlf'|'lf'}} content with UTF-8 BOM
 *   stripped; eol is 'crlf' when the content contains `\r\n`, else 'lf'
 */
function readFileText(absPath) {
  let content = fs.readFileSync(absPath, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return { content, eol: content.includes('\r\n') ? 'crlf' : 'lf' };
}

module.exports = { collectFiles, readFileText, globToRegExp };
