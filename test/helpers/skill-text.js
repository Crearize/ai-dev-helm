'use strict';

// 3.7.0 (C1a): a large skill is split into SKILL.md (the rules kept every time) and
// references/*.md (read at the step that needs them). Tests that pin a rule's wording read
// the whole skill - SKILL.md first, then references/ in name order - so a rule that moves
// between the body and a reference keeps passing, while one that disappears still fails.
// Not shipped: package.json `files` does not include test/.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const normalize = (text) => text.replace(/\r\n/g, '\n');

// Repository-relative paths of a skill's files: SKILL.md, then references/*.md.
function skillFiles(dir) {
  const files = [`${dir}/SKILL.md`];
  const refs = path.join(ROOT, dir, 'references');
  if (fs.existsSync(refs)) {
    for (const name of fs.readdirSync(refs).filter((n) => n.endsWith('.md')).sort()) files.push(`${dir}/references/${name}`);
  }
  return files;
}

// `name` is a project skill name (`quality-check`) or a repository-relative skill directory.
function readSkill(name) {
  const dir = name.includes('/') ? name : `skills/project/${name}`;
  return skillFiles(dir).map((rel) => normalize(fs.readFileSync(path.join(ROOT, rel), 'utf8'))).join('\n');
}

module.exports = { ROOT, normalize, readSkill, skillFiles };
