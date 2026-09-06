'use strict';

// A read-only migration view, not a quality gate or evidence adjudicator.
// Unknown fields survive; missing evidence never becomes a successful review.
function normalizeQualityReport(input) {
  const warnings = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function findings(rows, location) {
    if (!Array.isArray(rows)) throw new Error(`${location} must be a findings array`);
    return rows.flatMap((row, index) => {
      const at = `${location}[${index}]`;
      if (!object(row) || typeof row.description !== 'string') throw new Error(`${at}: description must be a string`);
      // Exact historic sentinel only: do not discard prose containing these words.
      if (/^(?:✅\s*)?(?:指摘なし|No findings)[。.!]?$/iu.test(row.description.trim())) {
        warnings.push(`${at}: removed legacy no-findings placeholder`);
        return [];
      }
      if (row.source !== undefined && (typeof row.source !== 'string' || !row.source.trim())) {
        throw new Error(`${at}: source must be a nonempty string`);
      }
      if (row.sources !== undefined && (!Array.isArray(row.sources) || row.sources.some(s => typeof s !== 'string' || !s.trim()))) {
        throw new Error(`${at}: sources must be an array of nonempty strings`);
      }
      const sources = [...new Set([...(row.source ? [row.source] : []), ...(row.sources || [])])];
      const adjudication = row.adjudication ?? 'unknown';
      const recurrence = row.recurrence ?? 'unknown';
      if (!['confirmed', 'false_positive', 'unknown'].includes(adjudication)) throw new Error(`${at}: invalid adjudication`);
      if (!['new', 'repeated', 'unknown'].includes(recurrence)) throw new Error(`${at}: invalid recurrence`);
      if (!sources.length) warnings.push(`${at}: detection source is unknown`);
      return [{ ...row, sources, adjudication, recurrence }];
    });
  }
  let report;
  if (object(input) && Object.hasOwn(input, 'cycles') && !Array.isArray(input.cycles)) {
    throw new Error('cycles must be an array');
  }
  if (Array.isArray(input)) report = findings(input, 'findings');
  else if (object(input) && Array.isArray(input.cycles)) {
    report = { ...input, cycles: input.cycles.map((cycle, index) => {
      if (!object(cycle)) throw new Error(`cycles[${index}] must be an object`);
      return { ...cycle, findings: findings(cycle.findings, `cycles[${index}].findings`) };
    }) };
    if (Object.hasOwn(input, 'findings')) report.findings = findings(input.findings, 'findings');
  } else if (object(input) && Object.hasOwn(input, 'findings')) {
    report = { ...input, findings: findings(input.findings, 'findings') };
  } else throw new Error('Expected a findings array or a report with findings/cycles');
  return { report, warnings };
}

module.exports = { normalizeQualityReport };
