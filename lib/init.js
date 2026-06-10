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
    if (!dryRun) {
      console.log('  Documents and review guides copied');
    }

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

    // 8. AI tool specific setup
    console.log('');
    console.log('--- Setting up AI tool configuration ---');

    if (selectedTools.includes(TOOL_IDS.CLAUDE_CODE)) {
      setupClaudeCode(projectDir, selectedStacks, { dryRun });
    }

    if (selectedTools.includes(TOOL_IDS.CURSOR)) {
      setupCursor(projectDir, selectedStacks, { dryRun });
    }

    if (selectedTools.includes(TOOL_IDS.CODEX)) {
      setupCodex(projectDir, selectedStacks, { dryRun });
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

    console.log('');
    console.log(dryRun ? '[dry-run] No files were modified.' : 'Setup complete!');
    if (!dryRun) {
      console.log('');
      console.log('Next steps:');
      console.log('  1. Review and customize CLAUDE.md / .cursorrules');
      console.log('  2. Update tech stack and port information');
      console.log('  3. Add project-specific coding rules');
      console.log('  4. Commit the generated files');
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
  const claudeDir = path.join(projectDir, '.claude');
  setupToolBase({ projectDir, toolDir: claudeDir, toolName: 'Claude Code' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(claudeDir, 'rules'), fileOptions);
    }
  }

  const settingsDest = path.join(claudeDir, 'settings.json');
  if (dryRun) {
    console.log('  [dry-run] Would create settings.json');
  } else if (!fs.existsSync(settingsDest)) {
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, 'templates', 'settings.json.template'),
      settingsDest
    );
    console.log('  settings.json created');
  } else {
    console.log('  settings.json already exists, skipping');
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
  const codexDir = path.join(projectDir, '.codex');
  setupToolBase({ projectDir, toolDir: codexDir, toolName: 'Codex' }, fileOptions);

  for (const stack of selectedStacks) {
    const stackRules = path.join(PACKAGE_ROOT, 'stacks', stack, 'rules');
    if (fs.existsSync(stackRules)) {
      copyDirSync(stackRules, path.join(codexDir, 'rules'), fileOptions);
    }
  }

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
    console.log('  .codex/hooks.json already exists, skipping');
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

module.exports = { doInit, writeVersionManifest };
