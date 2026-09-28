import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_FIELDS, RAW_ONLY_OPTIONS } from '../src/settings/fields.js';
import { checkCoverage } from '../src/settings/coverage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = JSON.parse(fs.readFileSync(path.join(root, 'reference/asa-options.json'), 'utf8'));
const report = checkCoverage({ reference, fields: SETTINGS_FIELDS, rawOnly: RAW_ONLY_OPTIONS });
const verbose = process.argv.includes('--verbose');
if (verbose) {
  for (const line of report.placements.sort()) console.log('  ' + line);
  console.log('');
}
for (const [label, count] of [
  ['reference options', report.counts.reference],
  ['curated fields', report.counts.curated],
  ['locked fields', report.counts.locked],
  ['raw INI only', report.counts.rawOnly],
  ['launch-flag fields', report.counts.launchFlag],
])
  console.log(`${label.padEnd(20)} ${count}`);
console.log('');
if (report.uncovered.length) {
  console.error(
    `UNCOVERED: ${report.uncovered.length} documented option(s) are neither a field nor declared raw-INI-only:`,
  );
  for (const option of report.uncovered)
    console.error(`  ${option.key}  (${option.file} ${option.section}, ${option.valueType || 'type undocumented'})`);
  console.error('');
}
if (report.unknownFields.length) {
  console.error(
    `NOT IN REFERENCE: ${report.unknownFields.length} key(s) exist here but not in the reference - check for a typo:`,
  );
  for (const key of report.unknownFields)
    console.error(`  ${SETTINGS_FIELDS.find((field) => field.key.toLowerCase() === key).key}`);
  console.error('');
}
if (report.problems.length) {
  console.error(`CATALOG PROBLEMS: ${report.problems.length}`);
  for (const problem of report.problems) console.error(`  [${problem.kind}] ${problem.message}`);
  console.error('');
}
const failed = report.uncovered.length + report.unknownFields.length + report.problems.length;
if (failed) {
  console.error(`FAIL - ${failed} issue(s). Coverage is incomplete.`);
  process.exit(1);
}
console.log(`OK - all ${report.counts.reference} documented options are accounted for.`);
