import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve(process.argv[2] ?? '');
const entry = path.join(source, 'web/libs/editor/src/index.js');
const adapter = path.join(
  source,
  'web/libs/editor/src/integrations/froglabel-reactcode-ce/index.jsx',
);
const importLine = 'import "./integrations/froglabel-reactcode-ce";';
const anchor = 'import { LabelStudio } from "./LabelStudio";';

const fail = (message) => {
  process.stderr.write(`[FROGLABEL_CE_CANARY] ${message}\n`);
  process.exit(1);
};

if (!fs.existsSync(entry) || !fs.existsSync(adapter)) fail('installed source files are missing');
const entryText = fs.readFileSync(entry, 'utf8');
const adapterText = fs.readFileSync(adapter, 'utf8');
if (entryText.split(importLine).length !== 2)
  fail('expected exactly one FrogLabel side-effect import');
if (entryText.indexOf(importLine) > entryText.indexOf(anchor))
  fail('registration import is too late');
for (const [name, pattern] of [
  ['ReactCode registration', /Registry\.addCustomTag\(["']ReactCode["']/],
  ['reactcode result', /resultName:\s*["']reactcode["']/],
  ['frozen result value', /types\.frozen\(\)/],
]) {
  if (!pattern.test(adapterText)) fail(`adapter is missing ${name}`);
}
process.stdout.write('FrogLabel CE structural canary passed\n');
