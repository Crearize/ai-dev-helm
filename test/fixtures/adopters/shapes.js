'use strict';

// 3.7.0 (acceptance, 4g): products installed by the published 3.6.0 and then shaped like the adopters' layouts, for
// the 3.6.0 -> 3.7.0 upgrade integration test (lib/upgrade-adopters.test.js). Each shape names the adopters it models.

const fs = require('node:fs');
const path = require('node:path');

const NOTICE_EN = 'Reinstall it with npx @crearize/ai-dev-helm init.';
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCAL_ANCHOR = '- The "Create GitHub Issue" and "Issue number required" rules in the three entry files apply only to projects that use Issues.';
const LOCAL_BLOCK = '<!-- ai-dev-helm:local:start -->\n##### Our Issue rules\n\nWe track work in the client portal, not GitHub Issues.\n<!-- ai-dev-helm:local:end -->';
const NOTICE_JA = '導入し直してください（npx @crearize/ai-dev-helm init）。';

const move = (dir, from, to) => {
  fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
  fs.cpSync(path.join(dir, from), path.join(dir, to), { recursive: true });
};
const unlink = (dir, rel) => fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const writeJson = (dir, rel, value) => fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
const dropIgnore = (dir, entries) => {
  const file = path.join(dir, '.gitignore');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !entries.includes(l.trim()));
  fs.writeFileSync(file, lines.join('\n'));
};

/** Replace the skills/ tree and its links with real copies at `targets` ({ project: [...], superpowers: [...] }). */
function copySkills(dir, targets) {
  for (const runtime of ['.claude', '.codex', '.cursor']) unlink(dir, `${runtime}/skills`);
  for (const [tree, list] of Object.entries(targets)) for (const target of list) move(dir, `skills/${tree}`, target);
  unlink(dir, 'skills');
  dropIgnore(dir, ['/.claude/skills', '/.codex/skills', '/.cursor/skills']);
}

/** Add a statusMessage to the Claude gate registration (MovieMarketer, platform, MasterPlan). */
function statusMessage(dir, calls = /quality-gate\.cjs/) {
  const settings = readJson(dir, '.claude/settings.json');
  for (const group of settings.hooks.PreToolUse) {
    for (const hook of group.hooks) if (calls.test(hook.command)) hook.statusMessage = '品質ゲートを確認中';
  }
  writeJson(dir, '.claude/settings.json', settings);
}

const SHAPES = {
  // eLPi, client-massmedian-ai-data-checker, OlbaDataMatching, auFinancialPromotions: skills/ with links.
  // eLPi, client-massmedian-ai-data-checker: skills/ with links; a product section kept in a distributed document
  // (ai-dev-helm:local) right where the release adds a paragraph.
  standard: {
    tools: 'claude-code,codex',
    stacks: '',
    models: 'eLPi / massmedian',
    shape(dir) {
      const file = path.join(dir, 'documents/development/development-policy.md');
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes(`${LOCAL_ANCHOR}\n\n`)) throw new Error('the 3.6.0 development-policy anchor line was not found');
      fs.writeFileSync(file, text.replace(`${LOCAL_ANCHOR}\n\n`, `${LOCAL_ANCHOR}\n\n${LOCAL_BLOCK}\n\n`));
    },
  },

  // MovieMarketer: .claude/skills holds the project skills flat and superpowers/ under it; the product's own skill
  // next to them; a statusMessage on the gate.
  flat: {
    tools: 'claude-code,codex',
    stacks: 'java-springboot,nextjs-react',
    models: 'MovieMarketer',
    manifest: { skillTargets: { project: ['.claude/skills'], superpowers: ['.claude/skills/superpowers'] } },
    shape(dir) {
      copySkills(dir, this.manifest.skillTargets);
      fs.mkdirSync(path.join(dir, '.claude/skills/staging-log-investigation'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude/skills/staging-log-investigation/SKILL.md'), '---\nname: staging-log-investigation\n---\n\n# product skill\n');
      statusMessage(dir);
    },
  },

  // MasterPlan: three real copies (project/ and superpowers/ under each runtime), a custom-* stack next to the
  // known one, the external superpowers plugin switched on.
  copies: {
    tools: 'claude-code,codex,cursor',
    stacks: 'nextjs-react',
    models: 'MasterPlan',
    manifest: {
      stacks: ['custom-hono-react', 'nextjs-react'],
      skillTargets: {
        project: ['.claude/skills/project', '.codex/skills/project', '.cursor/skills/project'],
        superpowers: ['.claude/skills/superpowers', '.codex/skills/superpowers', '.cursor/skills/superpowers'],
      },
      settings: { enabledPlugins: { 'superpowers@claude-plugins-official': true } },
    },
    shape(dir) {
      copySkills(dir, this.manifest.skillTargets);
      statusMessage(dir);
    },
  },

  // Kakaseru, OlbaDataMatching: a CRLF working tree, apps in their own directory.
  crlf: {
    tools: 'claude-code,cursor',
    stacks: 'nextjs-react',
    models: 'Kakaseru / OlbaDataMatching',
    manifest: { apps: { frontend: 'apps/web' } },
    crlf: true,
    shape() {},
  },

  // platform: three flat copies without superpowers, its own gate and review-budget under scripts/ registered by
  // hand (Claude and Codex), release protected too, its own deny list.
  gate: {
    tools: 'claude-code,codex,cursor',
    stacks: 'java-springboot,nextjs-react',
    models: 'platform',
    manifest: {
      skillTargets: { project: ['.claude/skills', '.codex/skills', '.cursor/skills'] },
      exclude: [{ part: 'superpowers', reason: 'platform uses the external superpowers plugin' }],
      gate: { script: 'scripts/gate.cjs' },
      reviewBudgetScript: 'scripts/review-budget.cjs',
      workflow: { protectedBranches: ['main', 'release'] },
      settings: { mergeDeny: false },
    },
    shape(dir) {
      copySkills(dir, { project: this.manifest.skillTargets.project });
      for (const rel of ['.claude/hooks/quality-gate.cjs', '.claude/hooks/review-budget.cjs', '.codex/hooks/quality-gate.cjs', '.codex/hooks/review-budget.cjs']) unlink(dir, rel);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'templates/hooks/quality-gate.cjs'), path.join(dir, 'scripts/gate.cjs'));
      fs.copyFileSync(path.join(PACKAGE_ROOT, 'templates/hooks/review-budget.cjs'), path.join(dir, 'scripts/review-budget.cjs'));
      const own = (command) => (command.includes('quality-gate.cjs') ? 'node scripts/gate.cjs' : command.includes('review-budget.cjs') ? 'node scripts/review-budget.cjs' : command);
      for (const rel of ['.claude/settings.json', '.codex/hooks.json']) {
        const settings = readJson(dir, rel);
        for (const groups of Object.values(settings.hooks)) for (const group of groups) for (const hook of group.hooks) hook.command = own(hook.command);
        writeJson(dir, rel, settings);
      }
      statusMessage(dir, /scripts\/gate\.cjs/);
    },
  },

  // auFinancialPromotions: the "not found" notice of the gate wrapper rewritten by hand, the external superpowers
  // plugin switched off.
  notice: {
    tools: 'claude-code,cursor',
    stacks: 'nextjs-react',
    models: 'auFinancialPromotions',
    manifest: { settings: { enabledPlugins: { 'superpowers@superpowers-marketplace': false, 'superpowers@claude-plugins-official': false } } },
    shape(dir) {
      const settings = readJson(dir, '.claude/settings.json');
      let edited = 0;
      for (const groups of Object.values(settings.hooks)) {
        for (const group of groups) for (const hook of group.hooks) {
          if (hook.command.includes(NOTICE_EN)) { hook.command = hook.command.replace(NOTICE_EN, NOTICE_JA); edited++; }
        }
      }
      if (!edited) throw new Error('the 3.6.0 notice text was not found in the registrations');
      writeJson(dir, '.claude/settings.json', settings);
    },
  },
};

module.exports = { SHAPES, NOTICE_JA, LOCAL_ANCHOR, LOCAL_BLOCK };
