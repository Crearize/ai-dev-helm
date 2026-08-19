'use strict';

/**
 * Registry of lint checks.
 *
 * For now this is a stub: each entry only carries { name, defaultEnabled }.
 * Later tasks replace entries with real check modules of the shape:
 *
 *   module.exports = {
 *     name: 'secrets',            // config key
 *     defaultEnabled: true,
 *     scope: 'file' | 'repo',
 *     run(ctx) { ... },           // returns Violation[]
 *   };
 *
 * Real modules keep the same { name, defaultEnabled } shape, so consumers
 * (e.g. the config loader) must rely only on those two fields.
 */
const checks = [
  { name: 'secrets', defaultEnabled: true },
  { name: 'commented-code', defaultEnabled: true },
  { name: 'todo-deadline', defaultEnabled: true },
  { name: 'import-exists', defaultEnabled: true },
  { name: 'file-naming', defaultEnabled: false },
  { name: 'branch-naming', defaultEnabled: true },
  { name: 'commit-message', defaultEnabled: true },
];

module.exports = { checks };
