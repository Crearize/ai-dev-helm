'use strict';

const fs = require('fs');
const path = require('path');
const {
  PACKAGE_ROOT,
  SKILL_SCOPE,
  TOOL_IDS,
  ALL_TOOL_IDS,
  TOOL_LABELS,
  createPrompter,
  copyDirSync,
  copyFilesSync,
  copyFileKeepingLocal,
  linkOrCopy,
  detectStacks,
  detectProjectSkills,
  copySelectedSkills,
  parseNumberSelection,
} = require('./utils');
const { mergeSettings } = require('./merge-settings');
const { setupCodexRuntime } = require('./codex-runtime');
const { setupRuntimeHooks } = require('./runtime-hooks');
const { ensureSkillLink } = require('./link-skills');

/**
 * Resolve init choices from CLI flags (H-54). Returns, per field, a value or
 * undefined ("ask the prompter"). Interactive = a TTY without --yes. When
 * non-interactive, project name and tools must be given unless --yes (which
 * falls back to the directory name / claude-code); skills default to all and
 * stacks to the single detected one. Never prompts; throws on bad input.
 */
function resolveInitChoices(options = {}, { isTTY = false, cwd = process.cwd() } = {}) {
  const list = (v) => (v === undefined || v === null || v === ''
    ? undefined
    : String(v).split(',').map((s) => s.trim()).filter(Boolean));
  const nonInteractive = Boolean(options.yes) || !isTTY;
  const missing = [];
  const out = {};

  out.projectName = options.projectName;
  if (out.projectName === undefined && nonInteractive) {
    if (options.yes) out.projectName = path.basename(cwd);
    else missing.push('--project-name');
  }
  if (out.projectName !== undefined && !(out.projectName.length > 0 && /^[^\x00-\x1f]+$/.test(out.projectName))) {
    throw new Error('Invalid --project-name: use a non-empty name without control characters.');
  }

  out.tools = list(options.tools);
  if (out.tools === undefined && nonInteractive) {
    if (options.yes) out.tools = [TOOL_IDS.CLAUDE_CODE];
    else missing.push('--tools');
  }
  const badTool = (out.tools || []).find((t) => !ALL_TOOL_IDS.includes(t));
  if (badTool) throw new Error(`Unknown tool "${badTool}". Valid: ${ALL_TOOL_IDS.join(', ')}`);

  const skills = list(options.skills);
  if (skills === undefined && nonInteractive) {
    out.skillChoice = SKILL_SCOPE.ALL;
  } else if (skills !== undefined) {
    const first = skills[0].toLowerCase();
    if (skills.length === 1 && first === 'all') out.skillChoice = SKILL_SCOPE.ALL;
    else if (skills.length === 1 && first === 'superpowers') out.skillChoice = SKILL_SCOPE.SUPERPOWERS_ONLY;
    else if (skills.length === 1 && first === 'project') out.skillChoice = SKILL_SCOPE.PROJECT_ONLY;
    else {
      const available = detectProjectSkills(path.join(PACKAGE_ROOT, 'skills', 'project'));
      const bad = skills.find((s) => !available.includes(s));
      if (bad) throw new Error(`Unknown skill "${bad}" in --skills. Use all|superpowers|project or: ${available.join(', ')}`);
      out.skillChoice = SKILL_SCOPE.CUSTOM;
      out.selectedProjectSkills = skills;
    }
  }

  const stacks = list(options.stacks);
  const available = detectStacks();
  if (stacks !== undefined) {
    const bad = stacks.find((s) => !available.includes(s));
    if (bad) throw new Error(`Unknown stack "${bad}". Available: ${available.join(', ')}`);
    out.stacks = stacks;
  } else if (nonInteractive) {
    out.stacks = available.length === 1 ? [available[0]] : [];
    if (options.yes && available.length > 1) {
      console.log(`--yes: ${available.length} stacks detected (${available.join(', ')}); none chosen. Pass --stacks <name> to apply one.`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Non-interactive init (no TTY) requires ${missing.join(' and ')} (or pass --yes for defaults).`);
  }
  return out;
}

async function doInit(options = {}) {
  const { dryRun = false } = options;
  const choices = resolveInitChoices(options, { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  const interactive = [choices.projectName, choices.tools, choices.skillChoice, choices.stacks].some((v) => v === undefined);
  const prompter = interactive ? createPrompter() : { close() {} };
  const projectDir = process.cwd();
  // Two copy policies. Harness-owned trees (skills, documents/development,
  // hooks, review-prompt.md ...) are always overwritten. Adopter-editable
  // files (rules, review guides, lint configs) use `editable`: hashes of what
  // init wrote are recorded in .ai-dev-helm.json (`files`); an edited or
  // unrecorded file is kept and the new version goes to *.ai-dev-helm-new
  // (collected in `kept`).
  const prior = readRecordedHashes(projectDir);
  const fileOpts = { dryRun, kept: [], projectDir, prior, records: { ...prior } };
  const editable = { ...fileOpts, protect: true };

  try {
    // 1. Project name (with validation)
    let projectName = choices.projectName;
    while (projectName === undefined) {
      const input = await prompter.promptInput('Project name: ');
      if (input.length > 0 && /^[^\x00-\x1f]+$/.test(input)) {
        projectName = input;
      } else {
        console.log('Invalid project name. Please enter a non-empty name without control characters.');
      }
    }

    // 2. AI tool selection (multi-select)
    let selectedTools = choices.tools || [];
    if (choices.tools === undefined) {
      console.log('');
      console.log('Select AI tool(s) (enter numbers separated by spaces, e.g. "1 3"):');
      ALL_TOOL_IDS.forEach((id, i) => console.log(`  ${i + 1}) ${TOOL_LABELS[id]}`));
      while (selectedTools.length === 0) {
        const toolInput = await prompter.promptMultiple('> ');
        const { selected, warnings } = parseNumberSelection(toolInput, ALL_TOOL_IDS);
        warnings.forEach((w) => console.log(`  Warning: ${w}`));
        selectedTools = selected;
        if (selectedTools.length === 0) {
          console.log('Please select at least one AI tool.');
        }
      }
    }

    // 3. Skill scope
    let skillChoice = choices.skillChoice;
    if (skillChoice === undefined) {
      console.log('');
      skillChoice = await prompter.promptSelect('Select skill scope:', [
        'All skills (superpowers + project)',
        'superpowers skills only',
        'project skills only',
        'Custom selection',
      ]);
    }

    let selectedProjectSkills = choices.selectedProjectSkills || null;
    if (skillChoice === SKILL_SCOPE.CUSTOM && choices.selectedProjectSkills === undefined) {
      const projectSkillsDir = path.join(PACKAGE_ROOT, 'skills', 'project');
      const availableSkills = detectProjectSkills(projectSkillsDir);

      if (availableSkills.length === 0) {
        console.log('No project skills found. Continuing with superpowers only.');
        selectedProjectSkills = [];
      } else {
        console.log('');
        console.log('superpowers skills: (all included)');
        console.log('');
        console.log('Select project skills (enter numbers, space-separated, or \'all\'):');
        availableSkills.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
        const skillInput = await prompter.promptMultiple('> ');

        if (skillInput.length === 1 && skillInput[0].toLowerCase() === 'all') {
          selectedProjectSkills = availableSkills;
        } else if (skillInput.length === 0) {
          console.log('No skills selected. Continuing with superpowers only.');
          selectedProjectSkills = [];
        } else {
          const { selected, warnings } = parseNumberSelection(skillInput, availableSkills);
          warnings.forEach((w) => console.log(`  Warning: ${w}`));
          selectedProjectSkills = selected;
        }
      }
    }

    // 4. Detect and select stacks
    const stacks = detectStacks();
    let selectedStacks = [];

    if (choices.stacks !== undefined) {
      selectedStacks = choices.stacks;
    } else if (stacks.length === 1) {
      console.log('');
      console.log(`Tech stack: ${stacks[0]} (auto-applied)`);
      selectedStacks = [stacks[0]];
    } else if (stacks.length > 1) {
      console.log('');
      console.log('Available tech stacks (enter numbers separated by spaces):');
      stacks.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
      const stackInput = await prompter.promptMultiple('> ');
      const { selected, warnings } = parseNumberSelection(stackInput, stacks);
      warnings.forEach((w) => console.log(`  Warning: ${w}`));
      selectedStacks = selected;
    }

    if (dryRun) {
      console.log('');
      console.log('[dry-run] The following actions would be performed:');
    }

    // 5. Copy skills
    console.log('');
    console.log('--- Setting up skills ---');
    const skillsDest = path.join(projectDir, 'skills');
    if (!dryRun) {
      fs.mkdirSync(skillsDest, { recursive: true });
    }

    // Copy superpowers (all options except "project only")
    if (skillChoice === SKILL_SCOPE.ALL || skillChoice === SKILL_SCOPE.SUPERPOWERS_ONLY || skillChoice === SKILL_SCOPE.CUSTOM) {
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'superpowers'),
        path.join(skillsDest, 'superpowers'),
        fileOpts
      );
    }
    // Copy project skills
    if (skillChoice === SKILL_SCOPE.ALL || skillChoice === SKILL_SCOPE.PROJECT_ONLY) {
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        path.join(skillsDest, 'project'),
        fileOpts
      );
    } else if (skillChoice === SKILL_SCOPE.CUSTOM && selectedProjectSkills && selectedProjectSkills.length > 0) {
      copySelectedSkills(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        path.join(skillsDest, 'project'),
        selectedProjectSkills,
        fileOpts
      );
    }
    if (!dryRun) {
      if (skillChoice === SKILL_SCOPE.CUSTOM && (!selectedProjectSkills || selectedProjectSkills.length === 0)) {
        console.log('  Superpowers skills copied to skills/ (no project skills selected)');
      } else {
        console.log('  Skills copied to skills/');
      }
    }

    // 6. Copy stacks and shared resources
    console.log('');
    console.log('--- Setting up documents and review guides ---');
    for (const stack of selectedStacks) {
      const stackDir = path.join(PACKAGE_ROOT, 'stacks', stack);
      if (!fs.existsSync(stackDir)) continue;

      const reviewDir = path.join(stackDir, 'review-guides');
      if (fs.existsSync(reviewDir)) {
        copyFilesSync(reviewDir, path.join(projectDir, '.github'), editable);
      }

      const docsDir = path.join(stackDir, 'documents');
      if (fs.existsSync(docsDir)) {
        copyDirSync(docsDir, path.join(projectDir, 'documents', 'development'), fileOpts);
      }
    }

    const sharedReview = path.join(PACKAGE_ROOT, 'shared', 'review-guides');
    if (fs.existsSync(sharedReview)) {
      copyFilesSync(sharedReview, path.join(projectDir, '.github'), { ...editable, ownedNames: ['review-prompt.md'] });
    }
    const sharedDocs = path.join(PACKAGE_ROOT, 'shared', 'documents');
    if (fs.existsSync(sharedDocs)) {
      copyDirSync(sharedDocs, path.join(projectDir, 'documents', 'development'), fileOpts);
    }
    seedTestRecommendationLedger(projectDir, fileOpts);
    if (!dryRun) {
      console.log('  Documents and review guides copied');
    }

    // 6.5. Copy pre-built lint assets
    copyLintAssets(projectDir, selectedStacks, editable);

    // 7. PR template
    const prTemplateSrc = path.join(PACKAGE_ROOT, 'templates', 'PULL_REQUEST_TEMPLATE.md');
    if (fs.existsSync(prTemplateSrc)) {
      if (dryRun) {
        console.log(`  [dry-run] Would copy PR template to .github/PULL_REQUEST_TEMPLATE.md`);
      } else {
        fs.mkdirSync(path.join(projectDir, '.github'), { recursive: true });
        fs.copyFileSync(prTemplateSrc, path.join(projectDir, '.github', 'PULL_REQUEST_TEMPLATE.md'));
        console.log('  PR template copied');
      }
    }

    // 7.5. Ignore local workflow artifacts
    ensureGitignoreEntries(projectDir, fileOpts);

    // 8. AI tool specific setup
    console.log('');
    console.log('--- Setting up AI tool configuration ---');

    // Collects the ACTION REQUIRED warnings from ensureClaudeGateRegistration
    // / upgradeCodexHooksFile (a settings.json/hooks.json shape they don't
    // understand leaves the gate unregistered). Printed once more, right
    // before "Setup complete!", so they aren't missed mid-run.
    const actionRequiredWarnings = [];

    if (selectedTools.includes(TOOL_IDS.CLAUDE_CODE)) {
      actionRequiredWarnings.push(...setupClaudeCode(projectDir, selectedStacks, fileOpts, editable));
    }

    if (selectedTools.includes(TOOL_IDS.CURSOR)) {
      setupCursor(projectDir, selectedStacks, fileOpts);
    }

    if (selectedTools.includes(TOOL_IDS.CODEX)) {
      actionRequiredWarnings.push(...setupCodex(projectDir, selectedStacks, fileOpts, editable));
    }

    // 9. Replace placeholders
    if (!dryRun) {
      for (const file of ['CLAUDE.md', '.cursorrules', 'AGENTS.md']) {
        const filePath = path.join(projectDir, file);
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf8');
          content = content.replace(/\{\{PROJECT_NAME\}\}/g, () => projectName);
          fs.writeFileSync(filePath, content, 'utf8');
        }
      }
    } else {
      console.log('  [dry-run] Would replace {{PROJECT_NAME}} placeholders');
    }

    // 10. Record applied ai-dev-helm version
    writeVersionManifest(
      projectDir,
      { tools: selectedTools, stacks: selectedStacks, skillScope: skillChoice, files: fileOpts.records },
      fileOpts
    );

    if (fileOpts.kept.length > 0) {
      console.log('');
      console.log(`  ACTION REQUIRED: ${fileOpts.kept.length} file(s) ${dryRun ? 'would be ' : ''}kept (edited or not recorded by an earlier init; local edits not overwritten). ${dryRun ? 'Each would get' : 'Each has'} a *.ai-dev-helm-new with the upstream version: merge it into the file (keep project customizations, take upstream changes), then delete the .new (see documents/development/harness-upgrade.md):`);
      fileOpts.kept.forEach((f) => console.log(`    ${path.relative(projectDir, f)}.ai-dev-helm-new`));
    }
    if (actionRequiredWarnings.length > 0) {
      console.log('');
      actionRequiredWarnings.forEach((warning) => console.log(`  ${warning}`));
    }
    console.log('');
    console.log(dryRun ? '[dry-run] No files were modified.' : 'Setup complete!');
    if (!dryRun) {
      console.log('');
      console.log('Next steps:');
      console.log('  1. Review and customize CLAUDE.md / .cursorrules');
      console.log('  2. Update tech stack and port information');
      console.log('  3. Add project-specific coding rules');
      console.log('  4. Run the lint-scaffolding skill to wire the lint/ assets and create the lint:all command');
      console.log('  5. Commit the generated files');
      if (selectedTools.includes(TOOL_IDS.CODEX)) {
        console.log('');
        CODEX_TRUST_GUIDANCE.forEach((line) => console.log(line));
      }
    }
  } finally {
    prompter.close();
  }
}

// Codex skips hooks it has not been told to trust, without a warning (H-52),
// so a fresh or re-run init with Codex ends with how to turn the gate on.
const CODEX_TRUST_GUIDANCE = [
  'ACTION REQUIRED (Codex): quality-gate and review-budget do not run until you trust',
  '  the .codex/hooks.json hooks in Codex (/hooks) - and Codex shows no warning.',
  '  - Trust them again whenever hooks.json changes (matcher, command, timeout, order).',
  '  - Trust is recorded per Codex config location (CODEX_HOME): after switching Codex',
  '    accounts or config locations (an orca account switch, for example), trust them there too.',
  '  - The project itself must be trusted, or Codex does not read .codex/.',
  '  - Check (read-only): npx @crearize/ai-dev-helm codex-trust --dir . [--codex-home <dir>]',
];

const SKILL_SCOPE_LABELS = {
  [SKILL_SCOPE.ALL]: 'all',
  [SKILL_SCOPE.SUPERPOWERS_ONLY]: 'superpowers-only',
  [SKILL_SCOPE.PROJECT_ONLY]: 'project-only',
  [SKILL_SCOPE.CUSTOM]: 'custom',
};

/**
 * Write .ai-dev-helm.json recording which ai-dev-helm version was applied,
 * so consuming projects can diff against future releases when re-syncing.
 * Overwrites any existing manifest (re-running init updates the record).
 * `files` maps adopter-editable paths to the sha256 init last wrote, so the
 * next init can tell an unedited file (refresh) from an edited one (keep).
 * @param {string} projectDir - Project root path
 * @param {Object} applied
 * @param {string[]} applied.tools - Selected tool ids
 * @param {string[]} applied.stacks - Selected stack names
 * @param {number} applied.skillScope - SKILL_SCOPE value
 * @param {Object} [fileOptions] - Options passed to file operations
 */
/** Recorded adopter-editable file hashes from an existing manifest (empty if none/unreadable). */
function readRecordedHashes(projectDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(projectDir, '.ai-dev-helm.json'), 'utf8'));
    return m && typeof m.files === 'object' && m.files !== null && !Array.isArray(m.files) ? { ...m.files } : {};
  } catch {
    return {};
  }
}

function writeVersionManifest(projectDir, { tools, stacks, skillScope, files }, fileOptions = {}) {
  const manifestPath = path.join(projectDir, '.ai-dev-helm.json');
  if (fileOptions.dryRun) {
    console.log('  [dry-run] Would write .ai-dev-helm.json');
    return;
  }

  const { version } = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
  );
  const manifest = {
    version,
    tools,
    stacks,
    skillScope: SKILL_SCOPE_LABELS[skillScope] ?? 'all',
    appliedAt: new Date().toISOString(),
  };
  if (files && Object.keys(files).length > 0) {
    manifest.files = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`  .ai-dev-helm.json written (applied version: ${version})`);
}

/**
 * Copy pre-built lint assets into the product's lint/ directory.
 * Generic ast-grep categories (shared/lint/ast-grep/<category>/) keep the same
 * layout for every stack, but each rule is copied only when the stack for its
 * language is selected (a JS product without nextjs-react gets no JS rules). Stack-specific assets are copied only
 * for selected stacks:
 *   stacks/<stack>/lint/ast-grep/  -> lint/ast-grep/<stack>/
 *   stacks/<stack>/lint/<tool>/    -> lint/<tool>/        (eslint, checkstyle, archunit)
 *   stacks/<stack>/lint/README.md  -> lint/README-<stack>.md (wiring guide)
 * shared/lint/README.md becomes lint/README.md. Existing files are
 * protected as adopter-editable (pass `fileOptions.protect`; lint-scaffolding
 * customizes them): unedited files are refreshed, edited or unrecorded ones
 * get a <file>.ai-dev-helm-new next to them. None of this wires the tools up -
 * that is the lint-scaffolding skill's job.
 * @param {string} projectDir - Project root path
 * @param {string[]} selectedStacks - Selected stack names
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function copyLintAssets(projectDir, selectedStacks, fileOptions = {}) {
  const { dryRun } = fileOptions;
  const lintDest = path.join(projectDir, 'lint');
  const sharedLint = path.join(PACKAGE_ROOT, 'shared', 'lint');

  // Generic ast-grep categories: the directory layout is stack-independent, but
  // rules are selected per stack by language suffix below (java -> java-springboot,
  // js/ts -> nextjs-react). A JS product that does not select nextjs-react gets no JS rules.
  const sharedAstGrep = path.join(sharedLint, 'ast-grep');
  if (fs.existsSync(sharedAstGrep)) {
    // Rules are named <rule>-<lang>.yml. Copy a language's rules only when the
    // matching stack is selected (no stack selected: copy all). The destination
    // path is unchanged so a product's sgconfig.yml ruleDirs keep working.
    const wantJava = selectedStacks.length === 0 || selectedStacks.includes('java-springboot');
    const wantJs = selectedStacks.length === 0 || selectedStacks.includes('nextjs-react');
    const filter = (file) => {
      const base = path.basename(file);
      if (/-java.yml$/.test(base)) return wantJava;
      if (/-(js|ts|tsx).yml$/.test(base)) return wantJs;
      return true;
    };
    copyDirSync(sharedAstGrep, path.join(lintDest, 'ast-grep'), { ...fileOptions, filter });
  }
  // shared/lint/README.md (and any future top-level files) -> lint/
  if (fs.existsSync(sharedLint)) {
    copyFilesSync(sharedLint, lintDest, fileOptions);
  }

  // Stack-specific lint assets
  for (const stack of selectedStacks) {
    const stackLint = path.join(PACKAGE_ROOT, 'stacks', stack, 'lint');
    if (!fs.existsSync(stackLint)) continue;

    for (const entry of fs.readdirSync(stackLint, { withFileTypes: true })) {
      const src = path.join(stackLint, entry.name);
      if (entry.isDirectory()) {
        // ast-grep rules are namespaced per stack; other tools (eslint,
        // checkstyle, archunit) each own a top-level lint/<tool>/ directory.
        const dest = entry.name === 'ast-grep'
          ? path.join(lintDest, 'ast-grep', stack)
          : path.join(lintDest, entry.name);
        copyDirSync(src, dest, fileOptions);
      } else if (entry.isFile() && entry.name === 'README.md') {
        const destFile = path.join(lintDest, `README-${stack}.md`);
        if (dryRun) {
          console.log(`  [dry-run] Would copy file: ${src} -> ${destFile}`);
          copyFileKeepingLocal(src, destFile, fileOptions);
        } else {
          fs.mkdirSync(lintDest, { recursive: true });
          copyFileKeepingLocal(src, destFile, fileOptions);
        }
      }
    }
  }

  if (!dryRun) {
    console.log('  Lint assets copied to lint/');
  }
}

/**
 * Seed documents/development/test-recommendation-ledger.md from the template.
 * Copy-if-missing ONLY: the ledger accumulates product history (declined
 * proposals, uncovered E2E flows), so unlike the other copyDirSync-based
 * copies, re-running init MUST NOT overwrite it.
 * Best-effort: a missing template or an unusable destination tree (e.g.
 * `documents` existing as a file, permission errors) must never abort the
 * rest of doInit - the test-recommendation skill generates the ledger on
 * first run if it is still missing.
 * @param {string} projectDir - Project root path
 * @param {Object} [fileOptions] - Options passed to file operations
 * @returns {boolean} true if the ledger was created, false otherwise
 */
function seedTestRecommendationLedger(projectDir, { dryRun } = {}) {
  const dest = path.join(projectDir, 'documents', 'development', 'test-recommendation-ledger.md');
  const src = path.join(PACKAGE_ROOT, 'templates', 'test-recommendation-ledger.md.template');
  if (fs.existsSync(dest)) return false;
  if (!fs.existsSync(src)) {
    console.warn(`  Warning: ledger template not found, skipped: ${src}`);
    return false;
  }
  if (dryRun) {
    console.log(`  [dry-run] Would seed: ${dest}`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // COPYFILE_EXCL: kernel-enforced "create only if absent" (no TOCTOU, no
    // writing through a dangling symlink left at dest).
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    // The ledger is recoverable: the test-recommendation skill generates it
    // on first run (generate-if-missing). Never abort init over it.
    console.warn(`  Warning: could not seed the ledger (${err.code}); the test-recommendation skill will create it on first run`);
    return false;
  }
  return true;
}

// Local workflow artifacts the distributed workflow creates but must never
// be committed (SDD workspace, plan documents, quality-check gate files).
const GITIGNORE_ENTRIES = [
  '.superpowers/',
  'docs/superpowers/plans/',
  '.worktrees/',
  '.quality-check-report.json',
  '.quality-check-passed',
  // Local mutation-testing artifacts (test-recommendation, quality-check
  // Step 5): the Stryker sandbox and the reports/incremental files.
  // Committing the incremental file would share stale mutant state between
  // developers. `**/` on the reports entry: a pattern with a middle slash is
  // anchored to the repository root, which misses workspace packages that
  // run Stryker from their own directory (apps/web/reports/mutation/) (#99).
  // A product that hand-edited to `**/` matches exactly (no duplicate). An
  // old root-only line is left in place; the `**/` line is appended after the
  // existing content together with any other missing entry (not next to it).
  '.stryker-tmp/',
  '**/reports/mutation/',
  // Upstream versions of edited files written by re-init; the AI merges and deletes them.
  '*.ai-dev-helm-new',
  // Runtime skill links (junction/symlink to skills/). Git for Windows walks
  // into junctions, so without these `git add -A` commits three copies of
  // skills/. No trailing slash: a POSIX symlink is not a directory to git.
  '/.claude/skills',
  '/.codex/skills',
  '/.cursor/skills',
];
const WIDE_MUTATION_ENTRY = '**/reports/mutation/';
const LEGACY_MUTATION_ENTRIES = ['reports/mutation/', '/reports/mutation/'];
const GITIGNORE_HEADER = '# ai-dev-helm: local workflow artifacts (do not commit)';

/**
 * Append workflow-artifact entries to the project's .gitignore.
 * Idempotent: only entries not already present (exact line match) are added.
 * Creates .gitignore if it does not exist.
 * @param {string} projectDir - Project root path
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function ensureGitignoreEntries(projectDir, fileOptions = {}) {
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fileOptions.dryRun) {
    console.log('  [dry-run] Would ensure .gitignore entries for workflow artifacts');
    return;
  }

  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  // Follow the file's own line endings so a CRLF .gitignore stays CRLF.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';

  // #133: the harness itself once shipped the root-only `reports/mutation/`;
  // `**/reports/mutation/` supersedes it, so drop the legacy spelling.
  const lines = existing.split(/\r?\n/);
  const kept = lines.filter((l) => !LEGACY_MUTATION_ENTRIES.includes(l.trim()));
  const removedLegacy = lines.length - kept.length;
  const content = removedLegacy > 0 ? kept.join(eol) : existing;

  // A root-anchored `/x` is the same pattern as `x` for these root artifacts (H-34).
  const existingLines = new Set();
  for (const l of content.split(/\r?\n/)) {
    const t = l.trim();
    existingLines.add(t);
    if (t.startsWith('/')) existingLines.add(t.slice(1));
  }
  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0 && removedLegacy === 0) {
    console.log('  .gitignore already covers workflow artifacts');
    return;
  }
  let block = missing.length > 0 ? missing.join(eol) + eol : '';
  if (missing.length > 0 && !existingLines.has(GITIGNORE_HEADER)) {
    block = `${GITIGNORE_HEADER}${eol}${block}`;
  }
  const separator = block === '' || content === '' || content.endsWith('\n') ? '' : eol;
  fs.writeFileSync(gitignorePath, `${content}${separator}${block}`, 'utf8');
  console.log(`  .gitignore updated (${missing.length} entries added, ${removedLegacy} legacy removed)`);
}

/**
 * Copy the portable Node quality-gate hook into a tool's hooks directory.
 * Always overwritten: the hook is package-managed, not user-edited, so
 * re-running init must pick up fixes.
 * @param {string} toolDir - Tool-specific directory (.claude / .codex)
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function copyQualityGateHook(toolDir, fileOptions = {}) {
  const hookDest = path.join(toolDir, 'hooks', 'quality-gate.cjs');
  if (fileOptions.dryRun) {
    console.log(`  [dry-run] Would copy quality-gate hook to ${path.join(path.basename(toolDir), 'hooks', 'quality-gate.cjs')}`);
    return;
  }
  fs.mkdirSync(path.dirname(hookDest), { recursive: true });
  fs.copyFileSync(
    path.join(PACKAGE_ROOT, 'templates', 'hooks', 'quality-gate.cjs'),
    hookDest
  );
  console.log('  quality-gate hook copied');
}

/**
 * Set up common tool directory structure (rules dir, skills link).
 * @param {Object} params
 * @param {string} params.projectDir - Project root path
 * @param {string} params.toolDir - Tool-specific directory (.claude / .cursor)
 * @param {string} params.toolName - Tool name for display
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function setupToolBase({ projectDir, toolDir, toolName }, fileOptions = {}) {
  console.log(`Setting up ${toolName}...`);

  if (!fileOptions.dryRun) {
    fs.mkdirSync(path.join(toolDir, 'rules'), { recursive: true });
  }

  const skillsDir = path.join(projectDir, 'skills');
  if (fs.existsSync(skillsDir) || fileOptions.dryRun) {
    // Create the link only when nothing usable is there: a copied skills
    // directory or a working link is left alone, a dangling link is repaired.
    const r = ensureSkillLink({ projectDir, toolDir, dryRun: fileOptions.dryRun });
    if (r.status === 'created') console.log(`  Skills link created: ${r.path}`);
    else if (r.status === 'would_create') console.log(`  [dry-run] Would link: ${r.path} -> ${skillsDir}`);
    else if (r.status === 'directory') console.log(`  Skills: ${r.path} is a real directory (copied install); left unchanged. Re-copy skills/ there after updates.`);
    else if (r.status === 'failed') {
      console.log(`  WARNING: could not link ${r.path} (${r.detail}); copying skills instead. Changes to skills/ will not reach it; run \`ai-dev-helm link-skills\` once links work.`);
      linkOrCopy(skillsDir, path.join(toolDir, 'skills'), fileOptions);
    }
  }
}

function setupClaudeCode(projectDir, selectedStacks, fileOptions = {}, editable = fileOptions) {
  const { dryRun } = fileOptions;
  const warnings = [];
  const claudeDir = path.join(projectDir, '.claude');
  setupToolBase({ projectDir, toolDir: claudeDir, toolName: 'Claude Code' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(claudeDir, 'rules'), editable);
    }
  }

  copyQualityGateHook(claudeDir, fileOptions);

  const settingsDest = path.join(claudeDir, 'settings.json');
  const settingsTemplate = path.join(PACKAGE_ROOT, 'templates', 'settings.json.template');
  if (dryRun) {
    console.log('  [dry-run] Would create/merge settings.json');
  } else if (!fs.existsSync(settingsDest)) {
    fs.copyFileSync(settingsTemplate, settingsDest);
    console.log('  settings.json created');
  } else {
    // The hook file above is always overwritten with the current release, so
    // the protections next to it must not go stale either: merge the
    // template into the existing settings (backup + permissions.deny union;
    // hooks and every other user key are preserved) instead of skipping.
    mergeSettings(settingsDest, settingsTemplate, { mergeEnv: true });
    console.log('  settings.json merged (existing values preserved)');
    // mergeSettings deliberately keeps the existing `hooks` key verbatim, so
    // the gate registration next to the freshly overwritten hook body would
    // stay as an older release wrote it (or stay missing entirely).
    const warning = ensureClaudeGateRegistration(settingsDest);
    if (warning) warnings.push(warning);
  }

  const claudeMdDest = path.join(projectDir, 'CLAUDE.md');
  if (dryRun) {
    console.log('  [dry-run] Would create CLAUDE.md');
  } else if (!fs.existsSync(claudeMdDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'CLAUDE.md.template'),
      claudeMdDest
    );
    console.log('  CLAUDE.md created');
  } else {
    console.log('  CLAUDE.md already exists, skipping');
  }

  warnings.push(...setupRuntimeHooks(projectDir, 'claude', fileOptions));
  warnings.push(...updateRuntimeInstructions(projectDir, 'CLAUDE.md', fileOptions));
  console.log('  Claude Code setup complete');
  return warnings;
}

function setupCursor(projectDir, selectedStacks, fileOptions = {}) {
  const { dryRun } = fileOptions;
  const cursorDir = path.join(projectDir, '.cursor');
  setupToolBase({ projectDir, toolDir: cursorDir, toolName: 'Cursor' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (!fs.existsSync(stackRules)) continue;

    const mdFiles = findMdFiles(stackRules);
    for (const mdFile of mdFiles) {
      const filename = path.basename(mdFile, '.md');
      const parentDir = path.basename(path.dirname(mdFile));
      const content = fs.readFileSync(mdFile, 'utf8');

      const headingMatch = content.match(/^# (.+)$/m);
      const description = headingMatch ? headingMatch[1] : `${filename} rules`;

      let globs = '';
      let alwaysApply = 'true';
      if (parentDir === 'frontend') {
        globs = '  - "frontend/**/*.ts"\n  - "frontend/**/*.tsx"';
        alwaysApply = 'false';
      } else if (parentDir === 'backend') {
        globs = '  - "backend/**/*.java"';
        alwaysApply = 'false';
      }

      let mdcContent = `---\ndescription: "${description}"\n`;
      if (globs) {
        mdcContent += `globs:\n${globs}\n`;
      }
      mdcContent += `alwaysApply: ${alwaysApply}\n---\n\n${content}`;

      const mdcFile = path.join(cursorDir, 'rules', `${parentDir}-${filename}.mdc`);
      if (dryRun) {
        console.log(`  [dry-run] Would create rule: ${path.basename(mdcFile)}`);
      } else {
        fs.writeFileSync(mdcFile, mdcContent, 'utf8');
        console.log(`  Rule created: ${path.basename(mdcFile)}`);
      }
    }
  }

  const cursorrulesDest = path.join(projectDir, '.cursorrules');
  if (dryRun) {
    console.log('  [dry-run] Would create .cursorrules');
  } else if (!fs.existsSync(cursorrulesDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'cursorrules.template'),
      cursorrulesDest
    );
    console.log('  .cursorrules created');
  } else {
    console.log('  .cursorrules already exists, skipping');
  }

  console.log('  Cursor setup complete');
}

function setupCodex(projectDir, selectedStacks, fileOptions = {}, editable = fileOptions) {
  const { dryRun } = fileOptions;
  const warnings = [];
  const codexDir = path.join(projectDir, '.codex');
  setupToolBase({ projectDir, toolDir: codexDir, toolName: 'Codex' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(codexDir, 'rules'), editable);
    }
  }

  copyQualityGateHook(codexDir, fileOptions);

  const configDest = path.join(codexDir, 'config.toml');
  if (dryRun) {
    console.log('  [dry-run] Would create .codex/config.toml');
  } else if (!fs.existsSync(configDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'codex-config.toml.template'),
      configDest
    );
    console.log('  .codex/config.toml created');
  } else {
    console.log('  .codex/config.toml already exists, skipping');
  }

  const hooksDest = path.join(codexDir, 'hooks.json');
  if (dryRun) {
    console.log('  [dry-run] Would create .codex/hooks.json');
  } else if (!fs.existsSync(hooksDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'codex-hooks.json.template'),
      hooksDest
    );
    console.log('  .codex/hooks.json created');
  } else {
    const warning = upgradeCodexHooksFile(hooksDest);
    if (warning) warnings.push(warning);
  }

  const agentsMdDest = path.join(projectDir, 'AGENTS.md');
  if (dryRun) {
    console.log('  [dry-run] Would create AGENTS.md');
  } else if (!fs.existsSync(agentsMdDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'AGENTS.md.template'),
      agentsMdDest
    );
    console.log('  AGENTS.md created');
  } else {
    console.log('  AGENTS.md already exists, skipping');
  }

  warnings.push(...setupCodexRuntime(projectDir, fileOptions));
  warnings.push(...setupRuntimeHooks(projectDir, 'codex', fileOptions));
  warnings.push(...updateRuntimeInstructions(projectDir, 'AGENTS.md', fileOptions));
  console.log('  Codex setup complete');
  return warnings;
}

// Re-init must deliver runtime policy even when the main guide is user-owned.
// Only this marked block is managed; all surrounding project instructions stay.
function updateRuntimeInstructions(projectDir, filename, { dryRun = false } = {}) {
  if (dryRun) return [];
  const file = path.join(projectDir, filename);
  const start = '<!-- ai-dev-helm:runtime:start -->';
  const end = '<!-- ai-dev-helm:runtime:end -->';
  const block = `${start}\n## Harness runtime policy\n\nBefore delegating work, read \`documents/development/harness-runtime.md\`. Its model routing, review-only admission protocol, and scope rules override older harness paragraphs and upstream skills. Preserve stricter user limits.\n${end}`;
  const old = fs.readFileSync(file, 'utf8');
  const begin = old.indexOf(start);
  const finish = old.indexOf(end);
  if ((begin < 0) !== (finish < 0) || (begin >= 0 && (finish < begin || old.indexOf(start, begin + start.length) >= 0))) {
    return [`ACTION REQUIRED: malformed managed runtime block in ${file}; preserved without changes`];
  }
  const next = begin < 0 ? `${old.trimEnd()}\n\n${block}\n` : old.slice(0, begin) + block + old.slice(finish + end.length);
  if (next !== old) {
    fs.copyFileSync(file, `${file}.backup.${Date.now()}`);
    fs.writeFileSync(file, next, 'utf8');
  }
  return [];
}

// Minimum hook timeout that lets the quality-gate hook finish: the hook's
// internal deadline is 20s, so a shorter registration (old templates shipped
// 10) kills it mid-decision — and a PreToolUse hook killed before it prints
// is read as "allowed" (fail-open). A missing `timeout` altogether is just
// as unsafe (the harness default may be shorter than the hook's deadline),
// so both "too low" and "absent" are raised to this floor.
const MIN_GATE_TIMEOUT_SECONDS = 30;

function timeoutNeedsRaise(hook) {
  return typeof hook.timeout !== 'number' || hook.timeout < MIN_GATE_TIMEOUT_SECONDS;
}

// Recognizes a hook entry that actually *invokes* quality-gate.cjs as a
// script, not merely a command that mentions the filename in passing (a log
// message, a similarly-named backup file, a comment). The previous pattern
// only required the token to appear somewhere after a slash/backslash/space
// boundary, so `echo skipping quality-gate.cjs`, `cat quality-gate.cjs` and
// `true # quality-gate.cjs` all read as "already registered" (M5,
// quality-check cycle 2). It is now anchored to the start of the command
// (optionally through a leading quote) so the script must actually be the
// word being invoked - an optional path prefix, then an optional
// `node`/`node.exe` interpreter, then an optional path prefix again, then
// the script name, with an optional closing quote before the required
// trailing whitespace/end-of-string. Both a bare invocation
// (`node .claude/hooks/quality-gate.cjs`, the shipped template's form) and a
// quoted absolute path (`"C:\...\quality-gate.cjs"`) match.
// The interpreter and the script path each also accept a *quoted* form whose
// contents may contain spaces (`["'][^"']*...["']`), because unquoted
// `\S*[\\/]` cannot cross a space and a quoted Windows path routinely has one
// (`"C:\Program Files\nodejs\node.exe"`, a repo checked out under
// `"C:\My Projects\repo\..."`) - without this branch such a registration read
// as "not yet registered" and init appended a redundant second entry on every
// re-run (L23, quality-check cycle 2 round 3).
// Inside a quote, the script name must still sit immediately after a path
// separator (`["'][^"']*[\\/]quality-gate\.cjs["']`) or stand alone
// (`["']quality-gate\.cjs["']`) - the earlier quoted branch accepted ANY
// characters before the filename, so `node "echo skipping quality-gate.cjs"`,
// `node ".claude/hooks/not-quality-gate.cjs"` (a similarly-named file) and
// `"my node" "a quality-gate.cjs"` all misread as an already-registered gate
// (L33, quality-check cycle 2 round 4).
const QUALITY_GATE_COMMAND_RE = /^\s*(\S*[\\/])?((?:node(\.exe)?|["'][^"']*node(\.exe)?["'])\s+)?(?:(?:\S*[\\/])?quality-gate\.cjs["']?|["'][^"']*[\\/]quality-gate\.cjs["']|["']quality-gate\.cjs["'])(\s|$)/;

function isQualityGateHook(hook) {
  return (
    hook &&
    typeof hook === 'object' &&
    hook.type === 'command' &&
    typeof hook.command === 'string' &&
    QUALITY_GATE_COMMAND_RE.test(hook.command)
  );
}

// A hook-event matcher that plausibly covers Bash tool calls: unspecified or
// empty (both tools treat a missing/empty matcher as "all tools"), or a
// matcher string that - read as a regular expression - matches the literal
// string "Bash" (covers the literal "Bash", "^Bash$", and an alternation
// like "^(Bash|Read)$"). The previous check merely tested whether the
// matcher *string* contained the substring "Bash", so "Bashful" or
// "NotBash" wrongly counted as covering Bash calls (L6, quality-check cycle
// 2); a real regex test rejects both while still accepting the intended
// forms. A matcher that isn't a valid regular expression falls back to an
// exact-match comparison against "Bash" rather than throwing or wrongly
// matching - except the literal string "*", Claude Code's own "all tools"
// wildcard matcher, which is not valid regex syntax itself (`new
// RegExp('*')` throws "nothing to repeat") and so used to fall through the
// same fallback and read as NOT Bash-scoped (L34, quality-check cycle 2
// round 4). A registration scoped to some other tool only (`matcher:
// "Read"`) does not actually gate Bash calls and must not be counted as a
// real registration.
function matcherTargetsBash(matcher) {
  if (matcher === undefined || matcher === null || matcher === '') return true;
  if (typeof matcher !== 'string') return false;
  try {
    return new RegExp(matcher).test('Bash');
  } catch {
    return matcher === 'Bash' || matcher === '*';
  }
}

function entryHooks(entry) {
  return entry && typeof entry === 'object' && Array.isArray(entry.hooks) ? entry.hooks : [];
}

function actionRequiredWarning(filePath, reason) {
  return `ACTION REQUIRED: quality-gate hook is NOT registered in ${filePath} (${reason}). Register it manually or fix the file and re-run init.`;
}

/**
 * Parse and shape-validate a hooks-bearing JSON config file (Claude's
 * settings.json or Codex's hooks.json). Both files share the same
 * registration shape (`hooks.PreToolUse` -> [{ matcher, hooks: [...] }]),
 * and both callers need the same four checks before they can safely inspect
 * or rewrite the file: unparsable JSON, a non-object root, a non-object
 * `hooks` key, and a non-array `hooks.PreToolUse`. Centralizing them keeps
 * the "file shape we don't understand" message (and its ACTION REQUIRED
 * escalation) identical on both sides.
 * @param {string} filePath
 * @returns {{ok: true, parsed: object} | {ok: false, reason: string}}
 */
function readHookConfig(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'could not parse the file' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'root is not a JSON object' };
  }
  // A `hooks` key that isn't a plain object (array, string, null, ...) is a
  // shape this function doesn't understand. Treating it as "no hooks key
  // yet" would silently overwrite whatever `hooks` actually held once a
  // caller starts writing into it. Bail out like an unparsable file instead.
  if (
    parsed.hooks !== undefined &&
    (parsed.hooks === null || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))
  ) {
    return { ok: false, reason: 'non-object "hooks" key' };
  }
  const preToolUse = parsed.hooks ? parsed.hooks.PreToolUse : undefined;
  if (preToolUse !== undefined && !Array.isArray(preToolUse)) {
    return { ok: false, reason: 'non-array "hooks.PreToolUse"' };
  }
  return { ok: true, parsed };
}

/**
 * Register the quality-gate hook into `parsed.hooks.PreToolUse` straight
 * from the shipped template, for a caller that has already determined the
 * file has no Bash-scoped gate registration. Shared between
 * ensureClaudeGateRegistration and upgradeCodexHooksFile (M3, quality-check
 * cycle 2) so the "template read → extract gate entry → push" sequence, and
 * its failure handling, can't drift between the two: before this, an
 * unreadable or gate-less template fell back to a bare console.warn on the
 * Codex side and a silent `return undefined` on the Claude side, so neither
 * one raised the ACTION REQUIRED warning init's closing summary recaps
 * (M4). Both failure modes now return the same warning shape the caller
 * already uses for an unreadable *user* file.
 * @param {object} parsed - parsed settings/hooks JSON, mutated in place on success
 * @param {string} templateFileName - e.g. 'settings.json.template'
 * @param {string} filePath - the settings/hooks file path, used in the warning message
 * @returns {{registered: boolean, warning?: string}}
 */
function registerGateFromTemplate(parsed, templateFileName, filePath) {
  const templatePath = path.join(PACKAGE_ROOT, 'templates', templateFileName);
  let template;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch {
    const warning = actionRequiredWarning(filePath, 'the shipped hook template could not be read');
    console.warn(warning);
    return { registered: false, warning };
  }
  const templateEntries = (template.hooks?.PreToolUse || []).filter((entry) =>
    entryHooks(entry).some(isQualityGateHook)
  );
  if (templateEntries.length === 0) {
    const warning = actionRequiredWarning(filePath, 'the shipped hook template registers no quality-gate hook');
    console.warn(warning);
    return { registered: false, warning };
  }
  if (!parsed.hooks) parsed.hooks = {};
  if (!Array.isArray(parsed.hooks.PreToolUse)) parsed.hooks.PreToolUse = [];
  parsed.hooks.PreToolUse.push(...templateEntries);
  return { registered: true };
}

function isHookEventArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.hooks)
    )
  );
}

/**
 * Targeted upgrade for an existing hooks.json: migrate legacy files whose
 * hook events sit at the top level (Codex's real schema nests them under a
 * top-level `hooks` key — a bare event key is silently ignored, #112), raise
 * any quality-gate hook entry whose timeout is below the minimum (or
 * missing), and — mirroring the Claude side — register the gate from
 * templates/codex-hooks.json.template when hooks.PreToolUse carries no
 * Bash-scoped quality-gate entry at all. User-added hooks and every other
 * key are untouched. A file whose shape this function does not understand
 * (see readHookConfig) is left alone with an ACTION REQUIRED warning — the
 * user owns the file, but init must not stay silent about an unregistered
 * gate.
 * @param {string} hooksPath - Path to an existing hooks.json
 * @returns {string|undefined} the ACTION REQUIRED warning, if one was raised
 */
function upgradeCodexHooksFile(hooksPath) {
  const result = readHookConfig(hooksPath);
  if (!result.ok) {
    const warning = actionRequiredWarning(hooksPath, result.reason);
    console.warn(warning);
    return warning;
  }
  const parsed = result.parsed;

  // Migrate legacy files that hold event arrays (PreToolUse, etc.) directly
  // at the top level instead of under `hooks` — Codex does not read those.
  // Known limitation: a file that already has a valid `hooks` object *and*
  // still carries leftover legacy top-level event keys is left as-is —
  // those stray keys are not folded in (not observed in practice; init only
  // ever wrote one shape or the other, never both).
  // Only arrays shaped like hook-event registrations (a non-empty list of
  // matcher entries, each carrying a `hooks` array) are treated as legacy
  // events. hooks.json is user-owned and may carry other top-level arrays
  // (`trustedRoots: ["/srv/repo"]`, ...) that must stay where they are.
  let migrated = false;
  const hasTopLevelHooksObject = parsed.hooks !== undefined;
  if (!hasTopLevelHooksObject) {
    const legacyEventKeys = Object.keys(parsed).filter(
      (key) => key !== 'hooks' && isHookEventArray(parsed[key])
    );
    if (legacyEventKeys.length > 0) {
      const hooksObject = {};
      for (const key of legacyEventKeys) {
        hooksObject[key] = parsed[key];
        delete parsed[key];
      }
      parsed.hooks = hooksObject;
      migrated = true;
    }
  }

  let timeoutRaised = false;
  const eventsContainer = parsed.hooks || {};
  for (const entries of Object.values(eventsContainer)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entryHooks(entry)) {
        if (isQualityGateHook(hook) && timeoutNeedsRaise(hook)) {
          hook.timeout = MIN_GATE_TIMEOUT_SECONDS;
          timeoutRaised = true;
        }
      }
    }
  }

  // Mirror the Claude side: if hooks.PreToolUse carries no Bash-scoped
  // quality-gate entry at all, take the registration from the template so
  // the shipped matcher/timeout stay the single source of truth.
  let registered = false;
  let templateWarning;
  const preToolUse = parsed.hooks?.PreToolUse || [];
  const gateHooks = preToolUse
    .filter((entry) => matcherTargetsBash(entry && entry.matcher))
    .flatMap(entryHooks)
    .filter(isQualityGateHook);
  if (gateHooks.length === 0) {
    const templateResult = registerGateFromTemplate(parsed, 'codex-hooks.json.template', hooksPath);
    registered = templateResult.registered;
    templateWarning = templateResult.warning;
  }

  if (migrated || timeoutRaised || registered) {
    fs.writeFileSync(hooksPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    if (migrated) {
      console.log(
        `  ${path.basename(path.dirname(hooksPath))}/hooks.json: migrated legacy hook events under top-level "hooks" key`
      );
    }
    if (timeoutRaised) {
      console.log(
        `  ${path.basename(path.dirname(hooksPath))}/hooks.json: quality-gate timeout raised to ${MIN_GATE_TIMEOUT_SECONDS}s`
      );
    }
    if (registered) {
      console.log(
        `  ${path.basename(path.dirname(hooksPath))}/hooks.json: quality-gate hook registered (timeout ${MIN_GATE_TIMEOUT_SECONDS}s)`
      );
    }
  } else if (!templateWarning) {
    console.log(
      `  ${path.basename(path.dirname(hooksPath))}/hooks.json already exists, skipping`
    );
  }
  return templateWarning;
}

/**
 * Targeted repair for an existing .claude/settings.json after the template has
 * been merged into it. mergeSettings keeps the user's `hooks` key untouched
 * (user hooks must never be clobbered), but the gate hook body itself is
 * always overwritten with the current release — whose internal deadline is
 * 20s. A registration left at the old `timeout: 10`, or missing altogether,
 * therefore lets the harness kill the gate before it prints, and a PreToolUse
 * hook that prints nothing is read as "allowed" (fail-open).
 *
 * So: raise any quality-gate entry under a Bash-targeting `hooks.PreToolUse`
 * matcher that sits below the minimum (or carries no timeout), and append
 * the template's gate entry when none is registered. A registration is only
 * recognized when it (a) sits under a matcher that plausibly covers Bash
 * calls (unspecified/empty, or a string that - read as a regular expression -
 * matches the literal "Bash", e.g. "Bash", "^Bash$", "^(Bash|Read)$"; an
 * invalid regex falls back to an exact-match comparison against "Bash" - not
 * e.g. "Read", "Bashful" or "NotBash"), and (b) actually invokes
 * quality-gate.cjs as a script, not merely a command that mentions the
 * filename. Every other key,
 * event and user hook is preserved; a file whose shape this function does
 * not understand (see readHookConfig) is left alone with an ACTION REQUIRED
 * warning — the user owns the file, but init must not stay silent about an
 * unregistered gate.
 * @param {string} settingsPath - Path to an existing settings.json
 * @returns {string|undefined} the ACTION REQUIRED warning, if one was raised
 */
function ensureClaudeGateRegistration(settingsPath) {
  const label = `${path.basename(path.dirname(settingsPath))}/${path.basename(settingsPath)}`;

  const result = readHookConfig(settingsPath);
  if (!result.ok) {
    const warning = actionRequiredWarning(settingsPath, result.reason);
    console.warn(warning);
    return warning;
  }
  const parsed = result.parsed;

  let registered = false;
  let timeoutRaised = false;

  const preToolUse = parsed.hooks?.PreToolUse || [];
  const gateHooks = preToolUse
    .filter((entry) => matcherTargetsBash(entry && entry.matcher))
    .flatMap(entryHooks)
    .filter(isQualityGateHook);
  for (const hook of gateHooks) {
    if (timeoutNeedsRaise(hook)) {
      hook.timeout = MIN_GATE_TIMEOUT_SECONDS;
      timeoutRaised = true;
    }
  }

  let templateWarning;
  if (gateHooks.length === 0) {
    // No Bash-scoped gate registered: take the registration straight from
    // the template so the shipped matcher/timeout stay the single source of
    // truth.
    const templateResult = registerGateFromTemplate(parsed, 'settings.json.template', settingsPath);
    registered = templateResult.registered;
    templateWarning = templateResult.warning;
  }

  if (!registered && !timeoutRaised) return templateWarning;

  fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  if (registered) {
    console.log(
      `  ${label}: quality-gate hook registered (timeout ${MIN_GATE_TIMEOUT_SECONDS}s)`
    );
  }
  if (timeoutRaised) {
    console.log(`  ${label}: quality-gate timeout raised to ${MIN_GATE_TIMEOUT_SECONDS}s`);
  }
  return templateWarning;
}

/**
 * Find all .md files recursively under a directory.
 * @param {string} dir - Directory to search
 * @returns {string[]} Array of absolute file paths
 */
function findMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

module.exports = {
  doInit,
  resolveInitChoices,
  writeVersionManifest,
  ensureGitignoreEntries,
  copyLintAssets,
  upgradeCodexHooksFile,
  ensureClaudeGateRegistration,
  seedTestRecommendationLedger,
};
