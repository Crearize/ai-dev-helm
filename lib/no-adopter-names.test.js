'use strict';

// 3.7.2 (#234, design S1): the repository and the npm package are public, so no tracked file may carry the name of an
// adopter (a product the harness is installed in), an adopter's own identifiers (the prefix of its local patches) or
// the like. The names themselves are not written here either - only the SHA-256 of each one, lowercased.
//
// A file (its content and its path), after NFKC (full-width letters, half-width katakana), is cut into words: runs of
// ASCII letters and digits; runs of katakana and every part of 3 to 16 characters of them (a name inside a compound);
// and two or three such ASCII runs in a row separated by anything that is not a letter or a digit of any script (a
// name of several words - hyphenated, snake case, spaced, or with a dot, a middle dot, a slash, a Unicode hyphen or the
// katakana long vowel mark between them), taken as the runs joined by one hyphen. An invisible character (a format
// character or a default ignorable code point: soft hyphen, zero-width space, variation selector, ...) is read both as
// nothing and as a space. Each word is lowercased and hashed; a hash in NAME_HASHES fails the test with the file and line. The work per
// line is linear in its length (a test holds it to that).
// Limits (a review still has to catch these): common words that an adopter also uses as its name are not listed (they
// cannot be told apart from their ordinary use); names in kanji or hiragana, names of four words or more, a katakana
// name of more than 16 characters inside a longer run, and a name of several words written as one (CamelCase) unless
// that joined form is listed too.
//
// To add a name: node -e "console.log(require('crypto').createHash('sha256').update('<name, lowercased>').digest('hex'))"
// and add the hash below. Do not write the name in the commit, the PR or a comment. A katakana name of more than
// MAX_KANA (16) characters is found only as a whole run: raise MAX_KANA to its length when you add one.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
// describe / it / expect come from vitest globals (see vitest config).

const ROOT = path.resolve(__dirname, '..');

const NAME_HASHES = new Set([
  'e17305886f88f1772d5d15f4448ad59a195052b6d08433a883ccfad0e5080a54',
  'fe71e38407769f6169c1f4c2460ff0036490c09df6c298a61482849c9b1de206',
  '71cad2970a35da318537d08e0d22f89feccf9c459119523300df7c45e4d5d503',
  '66e007406e74cb2a71505ebe80864c9b9fe9d2328ebe898952f1e8ba6b3fc936',
  '12f6b23fbad1d9f39836f5119be49c8ad305d0e1d4b008139f82118f74033d6f',
  '8bfa5cbf39a400c93a99db78e66d0fc168a8ac6b86c63140c68f7b3c14812da9',
  '510755ac25f86e1ba853d7c1afc95b46f1e2004fd8de3dc26bab676cd1ec6dd0',
  '3052524142982e1d1ffc8b97e472eb577ac62fe12748938c92c5b01a527303e7',
  'cf4bbc0ac2890d651d36328cb7958874180cc28840b418c3e91c7b2655b856e2',
  'b494c4bdb982f9e12de46d0c6ea330753ccf358ab88cc976020f0d35c73ce038',
  '288fced6eb5fe50e72178f724e69a18cc3c4a8bdaa39c4366b291426fc19749c',
  'b93f97e565fb43e222ca475d7a7645c50e9c7f08b5f7f6c13b8981d3c3fced1b',
  'ce25caed711850a5e40304a20942da52537c0426515f5d8a0d49bb3bdc5e6906',
  '8ffefa3483ad5dee166ff9e1f5b0c3c03770f85086304e69a3ec76253751008d',
  '9f6cd345360d474b6201b0680913b799d35257b44e9950374e29c6e4063a1619',
  '7c84be5b9ba9f6749177e89397f11b49a4e16a64942744ca8f0b99b6618bf071',
  '4bdf5ee236c60b4fc3027f2727362a415fac0bebac4c50c316596978cb65e21e',
  '2ee5add84f13ad7e994721af30ae5044b89a386affb88da19453b7e8ec2db272',
  'f82b579052c7319dffb0d7c0bdc708c59f53d2ad16f40257aacef9ffe0dddd4e',
]);

const sha256 = (word) => crypto.createHash('sha256').update(word).digest('hex');

// The longest part of a katakana run taken as a word (besides the whole run): the parts of a run of L characters are
// then about L * MAX_KANA, not L * L / 2 strings of up to L characters each.
const MAX_KANA = 16;

// The words of one line, lowercased (see the header).
function wordsOf(line) {
  const words = new Set();
  const base = line.normalize('NFKC').toLowerCase();
  // An invisible character (soft hyphen, zero-width space or joiner, variation selector, ... - any default ignorable
  // code point) inside a name is read both ways: dropped (it splits nothing) and as a space (it separates two words).
  // Format characters (Cf) that are not default ignorable (U+FFF9, U+0600, ...) are read the same way, as they were
  // dropped before 3.7.3.
  const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
  for (const lower of new Set([base.replace(IGNORABLE, ''), base.replace(IGNORABLE, ' ')])) addWords(lower, words);
  return words;
}

function addWords(lower, words) {
  for (const m of lower.matchAll(/[a-z0-9]+/g)) words.add(m[0]);
  // Katakana without the middle dot (・ separates words in Japanese lists) and the double hyphen. A name joined to
  // another katakana word (a compound) is found as a part of the run: every part of 3 to MAX_KANA characters.
  for (const m of lower.matchAll(/[ァ-ヺー]+/g)) {
    const run = m[0];
    words.add(run);
    for (let i = 0; i < run.length; i++) for (let j = i + 3; j <= Math.min(run.length, i + MAX_KANA); j++) words.add(run.slice(i, j));
  }
  // ASCII runs in a row: `pieces` alternates what lies between the runs and the runs. Two runs belong to one name when
  // what lies between them has no letter or digit of any script; a modifier letter (the katakana long vowel mark typed
  // for a hyphen, U+02BC) counts as a separator. Walked once, without a backtracking regular expression (a long run of
  // separators before a letter of another script must not take exponential time).
  const pieces = lower.replace(/\p{Lm}/gu, '-').split(/([a-z0-9]+)/);
  let parts = [];
  const flush = () => {
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= parts.length; i++) words.add(parts.slice(i, i + n).join('-'));
    parts = [];
  };
  for (let k = 1; k < pieces.length; k += 2) {
    if (parts.length && !/^[^\p{L}\p{N}]+$/u.test(pieces[k - 1])) flush();
    parts.push(pieces[k]);
  }
  flush();
}

// [{ line, hash }] for every line of `text` with a word whose hash is in `hashes`. Hashes are cached per word.
function findHits(text, hashes, cache = new Map()) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const word of wordsOf(line)) {
      let hash = cache.get(word);
      if (hash === undefined) { hash = sha256(word); cache.set(word, hash); }
      if (hashes.has(hash)) hits.push({ line: i + 1, hash });
    }
  });
  return hits;
}

// Tracked files plus the untracked ones git does not ignore (about to be committed).
function repositoryFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0').filter(Boolean))];
}

describe('no adopter names in the repository (3.7.2, S1)', () => {
  it('finds a hashed word in ASCII, katakana and forms of several words with any separator, case-insensitively', () => {
    const hashes = new Set(['qxzv', 'qxzv-wq', 'クサズ'].map(sha256));
    const text = ['plain line', 'from QxZv here', 'id: my-qxzv-wq-patch', 'name クサズ', 'qxzvx and xqxzv', 'qxzv_wq'].join('\n');
    expect(findHits(text, hashes).map((h) => h.line)).toEqual([2, 3, 3, 4, 6, 6]);
    // A name of several words is found with any run of separators that are not letters or digits (a Unicode hyphen, a
    // middle dot, a dot, a slash), but not with the words apart, joined, in another order or with a word between.
    const several = new Set(['qxzv-wq'].map(sha256));
    const forms = ['by Qxzv Wq.', 'Qxzv  Wq', 'qxzvwq', 'wq qxzv', 'a qxzv wq b', 'qxzv\tWq', 'qxzv. wq', 'qxzv‐wq', 'qxzv·wq', 'qxzv・wq', 'qxzv/wq', 'qxzv の wq', 'qxzv x wq'];
    expect(findHits(forms.join('\n'), several).map((h) => h.line)).toEqual([1, 2, 5, 6, 7, 8, 9, 10, 11]);
    // The katakana long vowel mark typed for a hyphen (also full width), U+02BC, and invisible format characters.
    const marks = ['qxzvーwq', 'ＱｘｚｖーＷｑ', `qxzv${String.fromCharCode(0x2bc)}wq`, `qxzv${String.fromCharCode(0xad)}-wq`, `qxzv-${String.fromCharCode(0x200b)}wq`];
    expect(findHits(marks.join('\n'), several).map((h) => h.line)).toEqual([1, 2, 3, 4, 5]);
    expect(findHits(`q${String.fromCharCode(0xad)}xzv\nqx${String.fromCharCode(0x200b)}zv`, hashes).map((h) => h.line)).toEqual([1, 2]);
    // An invisible character alone between two words separates them; other default ignorable code points (a combining
    // grapheme joiner, a variation selector, the Hangul filler) inside a name are dropped too.
    const ch = (cp) => String.fromCodePoint(cp);
    const between = [0x200b, 0xad, 0x2060].map((cp) => `qxzv${ch(cp)}wq`);
    expect(findHits(between.join('\n'), several).map((h) => h.line)).toEqual([1, 2, 3]);
    expect(findHits(`qxzv${ch(0x200b)}team`, hashes).map((h) => h.line)).toEqual([1]);
    const inside = [0x34f, 0xfe0f, 0x3164].map((cp) => `qx${ch(cp)}zv`).concat([`クサ${ch(0xfe0f)}ズ`]);
    expect(findHits(inside.join('\n'), hashes).map((h) => h.line)).toEqual([1, 2, 3, 4]);
    // Format characters that are not default ignorable (an interlinear annotation anchor, an Arabic number sign) were
    // dropped before 3.7.3 and still are.
    const format = [0xfff9, 0x600].map((cp) => `qx${ch(cp)}zv`).concat([`クサ${ch(0xfff9)}ズ`, `qxzv${ch(0xfffb)}wq`]);
    expect(findHits(format.slice(0, 3).join('\n'), hashes).map((h) => h.line)).toEqual([1, 2, 3]);
    expect(findHits(format[3], several).map((h) => h.line)).toEqual([1]);
    // A long run of separators before a letter of another script takes no time (it took exponential time with a
    // backtracking regular expression).
    const started = Date.now();
    expect(findHits(`signature${'_'.repeat(60)}é and a${' -'.repeat(5000)}é`, several)).toEqual([]);
    // Nor a long katakana run (its parts were quadratic in number and cubic in characters).
    const kanaRun = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(0x30a1 + ((i * 7919) % 90))).join('');
    expect(findHits(kanaRun, several)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    // A katakana name inside a compound is found up to MAX_KANA characters; a longer one only as a whole run.
    expect(findHits('ニクサズチーム', hashes).map((h) => h.line)).toEqual([1]);
    const kana16 = 'アイウエオカキクケコサシスセソタ';
    const kana17 = `${kana16}チ`;
    expect([kana16.length, kana17.length]).toEqual([MAX_KANA, MAX_KANA + 1]);
    expect(findHits(`ニ${kana16}チーム`, new Set([sha256(kana16)])).map((h) => h.line)).toEqual([1]);
    expect(findHits([`ニ${kana17}チーム`, kana17, `・${kana17}・`].join('\n'), new Set([sha256(kana17)])).map((h) => h.line)).toEqual([2, 3]);
    // Full-width letters and half-width katakana (NFKC), a katakana name beside the middle dot or inside a compound.
    const kana = ['Ｑｘｚｖ', 'ｸｻｽﾞ', 'クサズ・レビュアー', '・クサズ', 'クサズチーム', 'ニクサズ', 'クサ', 'クサ・ズ'];
    expect(findHits(kana.join('\n'), hashes).map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 6]);
    // A path is checked by the same rule (a folder or file named after an adopter).
    expect(findHits('test/fixtures/QxZv-wq/a.js', hashes).map((h) => h.line)).toEqual([1, 1]);
    expect(findHits('test/fixtures/qxzvx/a.js', hashes)).toEqual([]);
  });

  it('no tracked file carries a listed name, in its content or its path', () => {
    const files = repositoryFiles();
    expect(files.length).toBeGreaterThan(100);
    const cache = new Map();
    const hits = [];
    for (const rel of files) {
      for (const hit of findHits(rel, NAME_HASHES, cache)) hits.push(`${rel} (path, ${hit.hash.slice(0, 12)})`);
      let buf;
      try {
        const file = path.join(ROOT, rel);
        if (!fs.lstatSync(file).isFile()) continue;
        buf = fs.readFileSync(file);
      } catch (e) {
        if (e.code === 'ENOENT') continue; // deleted in the working tree, not yet committed
        throw e;
      }
      if (buf.includes(0)) continue; // binary
      for (const hit of findHits(buf.toString('utf8'), NAME_HASHES, cache)) hits.push(`${rel}:${hit.line} (${hit.hash.slice(0, 12)})`);
    }
    expect(hits).toEqual([]);
  });
});
