import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { columnHelp, termHelp, kpiHelp, TERMS } from '../public/js/glossary.js';

const views = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'views');
const sources = readdirSync(views).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(join(views, f), 'utf8')]);

test('every table column header has hover help', () => {
  const missing = [];
  for (const [file, src] of sources) {
    // Column definitions: { label: '…', key | nosort | num | cls | help … }
    for (const m of src.matchAll(/\{ label: '([^']+)', (key|nosort|num|cls|help)/g)) {
      if (m[2] === 'help') continue;
      if (!columnHelp(m[1])) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every table declares its glossary context', () => {
  for (const [file, src] of sources) {
    const tables = (src.match(/table\(\[/g) ?? []).length;
    const ctx = (src.match(/ctx: '/g) ?? []).length;
    assert.equal(ctx, tables, file);
  }
});

test('context-specific help overrides the generic entry', () => {
  assert.notEqual(columnHelp('Status', 'po'), columnHelp('Status', 'failure'));
  assert.match(columnHelp('Status', 'job'), /in repair/);
  assert.match(columnHelp('Status', 'unknown-table'), /Current status/);
});

test('percentile terms and MAPE are explained', () => {
  for (const t of ['P10', 'P50', 'P75', 'P90', 'P10–P90', 'MAPE']) {
    assert.ok(TERMS[t] && termHelp(t).includes(t), t);
  }
  assert.match(termHelp('P90'), /one time in ten/);
  assert.ok(kpiHelp('Inventory carrying cost'));
});
