'use strict';

/**
 * Registry of lint checks.
 *
 * Entries not yet implemented are stubs carrying only
 * { name, defaultEnabled }. Later tasks replace them with real check
 * modules of the shape:
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
  require('./secrets'),
  require('./commented-code'),
  require('./todo-deadline'),
  require('./import-exists'),
  { name: 'file-naming', defaultEnabled: false },
  { name: 'branch-naming', defaultEnabled: true },
  { name: 'commit-message', defaultEnabled: true },
];

module.exports = { checks };
