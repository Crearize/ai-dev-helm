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
  linkOrCopy,
  detectStacks,
  detectProjectSkills,
  copySelectedSkills,
  parseNumberSelection,
} = require('./utils');
const { mergeSettings } = require('./merge-settings');

async function doInit(options = {}) {
  const { dryRun = false } = options;
  const prompter = createPrompter();
  const projectDir = process.cwd();

  try {
    // 1. Project name (with validation)
    let projectName;
    while (true) {
      projectName = await prompter.promptInput('Project name: ');
      if (projectName.length > 0 && /^[^\x00-\x1f]+$/.test(projectName)) {
        break;
      }
      console.log('Invalid project name. Please enter a non-empty name without control characters.');
    }

    // 2. AI tool selection (multi-select)
    console.log('');
    console.log('Select AI tool(s) (enter numbers separated by spaces, e.g. "1 3"):');
    ALL_TOOL_IDS.forEach((id, i) => console.log(`  ${i + 1}) ${TOOL_LABELS[id]}`));
    let selectedTools = [];
    while (selectedTools.length === 0) {
      const toolInput = await prompter.promptMultiple('> ');
      const { selected, warnings } = parseNumberSelection(toolInput, ALL_TOOL_IDS);
      warnings.forEach((w) => console.log(`  Warning: ${w}`));
      selectedTools = selected;
      if (selectedTools.length === 0) {
        console.log('Please select at least one AI tool.');
      }
    }

    // 3. Skill scope
    console.log('');
    const skillChoice = await prompter.promptSelect('Select skill scope:', [
      'All skills (superpowers + project)',
      'superpowers skills only',
      'project skills only',
      'Custom selection',
    ]);

    let selectedProjectSkills = null;
    if (skillChoice === SKILL_SCOPE.CUSTOM) {
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

    if (stacks.length === 1) {
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
        { dryRun }
      );
    }
    // Copy project skills
    if (skillChoice === SKILL_SCOPE.ALL || skillChoice === SKILL_SCOPE.PROJECT_ONLY) {
      copyDirSync(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        path.join(skillsDest, 'project'),
        { dryRun }
      );
    } else if (skillChoice === SKILL_SCOPE.CUSTOM && selectedProjectSkills && selectedProjectSkills.length > 0) {
      copySelectedSkills(
        path.join(PACKAGE_ROOT, 'skills', 'project'),
        path.join(skillsDest, 'project'),
        selectedProjectSkills,
        { dryRun }
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
        copyFilesSync(reviewDir, path.join(projectDir, '.github'), { dryRun });
      }

      const docsDir = path.join(stackDir, 'documents');
      if (fs.existsSync(docsDir)) {
        copyDirSync(docsDir, path.join(projectDir, 'documents', 'development'), { dryRun });
      }
    }

    const sharedReview = path.join(PACKAGE_ROOT, 'shared', 'review-guides');
    if (fs.existsSync(sharedReview)) {
      copyFilesSync(sharedReview, path.join(projectDir, '.github'), { dryRun });
    }
    const sharedDocs = path.join(PACKAGE_ROOT, 'shared', 'documents');
    if (fs.existsSync(sharedDocs)) {
      copyDirSync(sharedDocs, path.join(projectDir, 'documents', 'development'), { dryRun });
    }
    seedTestRecommendationLedger(projectDir, { dryRun });
    if (!dryRun) {
      console.log('  Documents and review guides copied');
    }

    // 6.5. Copy pre-built lint assets
    copyLintAssets(projectDir, selectedStacks, { dryRun });

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
    ensureGitignoreEntries(projectDir, { dryRun });

    // 8. AI tool specific setup
    console.log('');
    console.log('--- Setting up AI tool configuration ---');

    // Collects the ACTION REQUIRED warnings from ensureClaudeGateRegistration
    // / upgradeCodexHooksFile (a settings.json/hooks.json shape they don't
    // understand leaves the gate unregistered). Printed once more, right
    // before "Setup complete!", so they aren't missed mid-run.
    const actionRequiredWarnings = [];

    if (selectedTools.includes(TOOL_IDS.CLAUDE_CODE)) {
      actionRequiredWarnings.push(...setupClaudeCode(projectDir, selectedStacks, { dryRun }));
    }

    if (selectedTools.includes(TOOL_IDS.CURSOR)) {
      setupCursor(projectDir, selectedStacks, { dryRun });
    }

    if (selectedTools.includes(TOOL_IDS.CODEX)) {
      actionRequiredWarnings.push(...setupCodex(projectDir, selectedStacks, { dryRun }));
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
      { tools: selectedTools, stacks: selectedStacks, skillScope: skillChoice },
      { dryRun }
    );

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
    }
  } finally {
    prompter.close();
  }
}

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
 * @param {string} projectDir - Project root path
 * @param {Object} applied
 * @param {string[]} applied.tools - Selected tool ids
 * @param {string[]} applied.stacks - Selected stack names
 * @param {number} applied.skillScope - SKILL_SCOPE value
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function writeVersionManifest(projectDir, { tools, stacks, skillScope }, fileOptions = {}) {
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
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`  .ai-dev-helm.json written (applied version: ${version})`);
}

/**
 * Copy pre-built lint assets into the product's lint/ directory.
 * Generic ast-grep categories (shared/lint/ast-grep/<category>/) are always
 * copied - they are stack-independent. Stack-specific assets are copied only
 * for selected stacks:
 *   stacks/<stack>/lint/ast-grep/  -> lint/ast-grep/<stack>/
 *   stacks/<stack>/lint/<tool>/    -> lint/<tool>/        (eslint, checkstyle, archunit)
 *   stacks/<stack>/lint/README.md  -> lint/README-<stack>.md (wiring guide)
 * shared/lint/README.md becomes lint/README.md. Existing files are
 * overwritten (same policy as the other copyDirSync-based copies: re-running
 * init refreshes package-managed assets). None of this wires the tools up -
 * that is the lint-scaffolding skill's job.
 * @param {string} projectDir - Project root path
 * @param {string[]} selectedStacks - Selected stack names
 * @param {Object} [fileOptions] - Options passed to file operations
 */
function copyLintAssets(projectDir, selectedStacks, fileOptions = {}) {
  const { dryRun } = fileOptions;
  const lintDest = path.join(projectDir, 'lint');
  const sharedLint = path.join(PACKAGE_ROOT, 'shared', 'lint');

  // Generic ast-grep categories (always copied, stack-independent)
  const sharedAstGrep = path.join(sharedLint, 'ast-grep');
  if (fs.existsSync(sharedAstGrep)) {
    copyDirSync(sharedAstGrep, path.join(lintDest, 'ast-grep'), fileOptions);
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
        } else {
          fs.mkdirSync(lintDest, { recursive: true });
          fs.copyFileSync(src, destFile);
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
  // developers.
  '.stryker-tmp/',
  'reports/mutation/',
];
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
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
  if (missing.length === 0) {
    console.log('  .gitignore already covers workflow artifacts');
    return;
  }

  let block = missing.join('\n') + '\n';
  if (!existingLines.has(GITIGNORE_HEADER)) {
    block = `${GITIGNORE_HEADER}\n${block}`;
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${existing}${separator}${block}`, 'utf8');
  console.log(`  .gitignore updated (${missing.length} entries added)`);
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
    linkOrCopy(skillsDir, path.join(toolDir, 'skills'), fileOptions);
  }
}

function setupClaudeCode(projectDir, selectedStacks, fileOptions = {}) {
  const { dryRun } = fileOptions;
  const warnings = [];
  const claudeDir = path.join(projectDir, '.claude');
  setupToolBase({ projectDir, toolDir: claudeDir, toolName: 'Claude Code' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(claudeDir, 'rules'), fileOptions);
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
    mergeSettings(settingsDest, settingsTemplate);
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

function setupCodex(projectDir, selectedStacks, fileOptions = {}) {
  const { dryRun } = fileOptions;
  const warnings = [];
  const codexDir = path.join(projectDir, '.codex');
  setupToolBase({ projectDir, toolDir: codexDir, toolName: 'Codex' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(codexDir, 'rules'), fileOptions);
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

  console.log('  Codex setup complete');
  return warnings;
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
const QUALITY_GATE_COMMAND_RE = /^\s*(\S*[\\/])?((?:node(\.exe)?|["'][^"']*node(\.exe)?["'])\s+)?(?:(?:\S*[\\/])?quality-gate\.cjs["']?|["'][^"']*quality-gate\.cjs["'])(\s|$)/;

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
// matching. A registration scoped to some other tool only
// (`matcher: "Read"`) does not actually gate Bash calls and must not be
// counted as a real registration.
function matcherTargetsBash(matcher) {
  if (matcher === undefined || matcher === null || matcher === '') return true;
  if (typeof matcher !== 'string') return false;
  try {
    return new RegExp(matcher).test('Bash');
  } catch {
    return matcher === 'Bash';
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
  writeVersionManifest,
  ensureGitignoreEntries,
  copyLintAssets,
  upgradeCodexHooksFile,
  ensureClaudeGateRegistration,
  seedTestRecommendationLedger,
};
