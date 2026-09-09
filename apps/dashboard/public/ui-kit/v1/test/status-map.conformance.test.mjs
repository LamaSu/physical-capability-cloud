// Conformance test for the money-status render map in pcc-ui.js.
// It extracts the <status-map v1> region VERBATIM from the shipped kit and evaluates it,
// so it tests the real bytes the browser runs -- not a parallel copy.
// Spec: genui-read-route-contract sec-A (the 10-state table) + rule 1 (no refund-as-payment).
// Run: node --test  (from this dir, or `node --test apps/dashboard/public/ui-kit/v1/test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'pcc-ui.js'), 'utf8');

const region = src.match(/\/\/ <status-map v1>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v1>/);
assert.ok(region, 'status-map v1 markers not found in pcc-ui.js');
const ctx = {};
vm.runInNewContext(
  region[1] + '\nthis.statusClass = statusClass; this.settlementLabel = settlementLabel;',
  ctx,
);
const statusClass = ctx.statusClass;
const settlementLabel = ctx.settlementLabel;

// The sec-A conformance table: [status, expectedClass, labelSubstr|null]
const SECTION_A = [
  ['SETTLED_RELEASED', 'st-settled', 'operator distribution discharged'],
  ['SETTLED_REFUNDED', 'st-refunded', 'operator NOT paid'],
  ['RELEASE_ALLOCATED', 'st-waiting', 'payment incomplete'],
  ['REFUND_ALLOCATED', 'st-waiting', 'refund incomplete'],
  ['AWAITING_FUNDING', 'st-waiting', null],
  ['FUNDED_ACTIVE', 'st-running', null],
  ['PRIMARY_ASSERTED', 'st-waiting', null],
  ['CHALLENGED', 'st-waiting', null],
  ['BACKUP_PENDING', 'st-waiting', null],
  ['BACKUP_ASSERTED', 'st-waiting', null],
];

test('sec-A settlement states -> honest class + direction label', () => {
  for (const [s, cls, label] of SECTION_A) {
    assert.equal(statusClass(s), cls, s + ' -> ' + cls);
    if (label) assert.ok(String(settlementLabel(s)).includes(label), s + ' label should contain "' + label + '"');
  }
});

// THE load-bearing invariant: nothing that is not a discharged RELEASE may render green.
const NEVER_GREEN = [
  'refunded', 'REFUNDED', 'SETTLED_REFUNDED', 'REFUND_ALLOCATED', 'RELEASE_ALLOCATED',
  'UNRELEASED', 'INCOMPLETE', 'UNSUCCESSFUL', 'NOT_APPROVED', 'INACTIVE', 'UNDERFUNDED',
  'PARTIALLY_PAID', 'PARTIALLY_RELEASED', 'PARTIALLY_REFUNDED',
  'FUNDED', 'ACTIVE', 'CREATED', 'DISPUTED', 'PENDING',
  'settled', 'paid', 'released', // bare, direction-less money words: not confirmable -> not green
  'wat', '', null, undefined, 'zzz_unknown_state',
];
test('nothing but a discharged release renders as settled/green', () => {
  for (const s of NEVER_GREEN) {
    assert.notEqual(statusClass(s), 'st-settled', JSON.stringify(s) + ' must NOT be st-settled');
  }
});

test('a refund is st-refunded (never green, never a generic failure)', () => {
  assert.equal(statusClass('refunded'), 'st-refunded');
  assert.equal(statusClass('SETTLED_REFUNDED'), 'st-refunded');
  assert.ok(String(settlementLabel('SETTLED_REFUNDED')).includes('NOT paid'));
});

test('unmapped/unknown fails closed to st-unknown (neutral, never green)', () => {
  for (const s of ['zzz', 'wat', 'partially_paid', 'unreleased', 'settled', 'paid', '', null, undefined]) {
    assert.equal(statusClass(s), 'st-unknown', JSON.stringify(s) + ' -> st-unknown');
  }
});

test('normalization: casing / whitespace / separators', () => {
  assert.equal(statusClass('settled_released'), 'st-settled');
  assert.equal(statusClass('  SETTLED_RELEASED  '), 'st-settled');
  assert.equal(statusClass('settled-released'), 'st-settled');
  assert.equal(statusClass('Settled Released'), 'st-settled');
  assert.equal(statusClass('refund_allocated'), 'st-waiting');
});

test('generic run/action states still tone correctly', () => {
  assert.equal(statusClass('running'), 'st-running');
  assert.equal(statusClass('pending'), 'st-waiting');
  assert.equal(statusClass('error'), 'st-failed');
  assert.equal(statusClass('done'), 'st-settled');
});

// Belt-and-suspenders: the old greedy substring-greening regex must be GONE from the shipped file.
test('the greedy substring regex is gone from pcc-ui.js', () => {
  assert.doesNotMatch(
    src,
    /settl\|releas\|complet\|done\|paid\|funded\|success\|approved\|active/,
    'the old substring-greening regex is still present in pcc-ui.js',
  );
});
