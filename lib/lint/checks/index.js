'use strict';

/**
 * Registry of lint checks.
 *
 * Each entry is a check module of the shape:
 *
 *   module.exports = {
 *     name: 'secrets',            // config key
 *     defaultEnabled: true,
 *     scope: 'file' | 'repo',
 *     run(ctx) { ... },           // returns Violation[]
 *   };
 *
 * Consumers that only need identity (e.g. the config loader) must rely
 * only on the { name, defaultEnabled } fields.
 */
const checks = [
  require('./secrets'),
  require('./commented-code'),
  require('./todo-deadline'),
  require('./import-exists'),
  require('./file-naming'),
  require('./branch-naming'),
  require('./commit-message'),
];

module.exports = { checks };
