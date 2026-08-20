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

/** Timeout for git helper invocations (mirrors the runner) */
const GIT_TIMEOUT_MS = 5000;

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
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false; // git missing / not a repo / hung (timed out): fall back
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
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }
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
 * Collect lint target files.
 *
 * Binary (NUL-containing) files are NOT sniffed here; they pass through and
 * are recognized at read time (`readFileText` returns null), so the file is
 * opened only once. Only the cheap `statSync` size cap is applied here.
 *
 * @param {Object} opts
 * @param {string} opts.dir directory to scan (git-aware when inside a repo)
 * @param {string[]} [opts.paths] CLI positionals: restrict to these
 *   files/subtrees (Windows `\` separators and absolute paths accepted;
 *   absolute paths are relativized to `dir`)
 * @param {string[]} [opts.exclude] glob patterns from config to exclude
 * @param {number} [opts.maxBytes] per-file size limit
 * @returns {{files: string[], skipped: Array<{file: string, reason: string}>,
 *            unmatched: string[]}} `unmatched` lists positionals that matched
 *   no collected file (the caller treats these as an error).
 */
function collectFiles({
  dir,
  paths = [],
  exclude = [],
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const root = path.resolve(dir);
  let candidates;
  if (isInsideGitRepo(root)) {
    try {
      candidates = gitListFiles(root);
    } catch {
      candidates = walkDir(root); // git hung/failed after the probe: fall back
    }
  } else {
    candidates = walkDir(root);
  }

  const excludeRes = exclude.map(globToRegExp);
  // Relativize each positional to root (absolute paths included). An empty
  // rel means the positional IS the root -> match everything.
  const restrictTo = paths.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(root, String(p));
    return { orig: p, rel: normalizeRel(path.relative(root, abs)) };
  });
  const matchedSpec = new Set();

  const seen = new Set();
  for (const candidate of candidates) {
    const rel = normalizeRel(candidate);
    if (!rel || hasExcludedSegment(rel)) {
      continue;
    }
    if (excludeRes.some((re) => re.test(rel))) {
      continue;
    }
    if (restrictTo.length > 0) {
      let matched = false;
      restrictTo.forEach((spec, i) => {
        if (spec.rel === '' || rel === spec.rel || rel.startsWith(`${spec.rel}/`)) {
          matched = true;
          matchedSpec.add(i);
        }
      });
      if (!matched) {
        continue;
      }
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
    files.push(rel);
  }

  const unmatched = restrictTo
    .filter((_spec, i) => !matchedSpec.has(i))
    .map((spec) => spec.orig);

  return { files, skipped, unmatched };
}

/**
 * Read a text file for lint checks.
 * @param {string} absPath
 * @returns {{content: string, eol: 'crlf'|'lf'}|null} content with UTF-8 BOM
 *   stripped and eol ('crlf' when it contains `\r\n`, else 'lf'); or null when
 *   the file looks binary (a NUL byte in the first bytes). Read once.
 */
function readFileText(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return null; // binary: caller records it as skipped
  }
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return { content, eol: content.includes('\r\n') ? 'crlf' : 'lf' };
}

module.exports = { collectFiles, readFileText, globToRegExp };
