import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb } from './helpers.mjs';
import { setCatalog, tractorSvg, layoutFor, partPreviewHtml } from '../public/js/tractorDiagram.js';

const db = seededDb();
const catalog = {
  parts: db.prepare('SELECT * FROM part_types').all(),
  bom: db.prepare('SELECT * FROM bom_items').all(),
};
setCatalog(catalog);
const regionsIn = (svg) => new Set([...svg.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1]));

test('every part in every model is drawn on that model, and nothing else is', () => {
  for (const model of [...new Set(catalog.bom.map((b) => b.model_number))]) {
    const expected = new Set(catalog.bom.filter((b) => b.model_number === model).map((b) => b.part_number));
    assert.deepEqual(regionsIn(tractorSvg({ model })), expected, model);
  }
});

test('layouts follow the bill of materials', () => {
  assert.equal(layoutFor('TX-100').cab, false);
  assert.equal(layoutFor('TX-400').cab, true);
  assert.equal(layoutFor('TX-500').dual, true);
  assert.equal(layoutFor('TX-300').partFor('engine'), 'ENG-75');
  assert.equal(layoutFor('TX-200').partFor('transmission'), 'TRN-HST');
});

test('every part has a description and a hover preview highlighting it', () => {
  for (const p of catalog.parts) {
    assert.ok(p.description?.length > 20, p.part_number);
    const preview = partPreviewHtml(p.part_number);
    assert.ok(preview.includes(`data-part="${p.part_number}" class="td-part td-focus`), p.part_number);
  }
  assert.equal(partPreviewHtml('NOPE-1'), null);
});

test('colouring applies per part', () => {
  const svg = tractorSvg({ model: 'TX-400', color: (pn) => (pn === 'ECU-01' ? 'bad' : null) });
  const ecu = svg.slice(svg.indexOf('data-part="ECU-01"'), svg.indexOf('</g>', svg.indexOf('data-part="ECU-01"')));
  assert.match(ecu, /var\(--critical\)/);
});
