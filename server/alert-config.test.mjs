import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAlertConfig } from './alert-config.mjs';

// A rules file on disk, cleaned up by the caller.
function rulesFile(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'po11y-alerts-'));
  const path = join(dir, 'rules.json');
  writeFileSync(path, JSON.stringify(obj));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('env only: ALERTS_ENABLED=true switches alerting on', () => {
  const cfg = loadAlertConfig({ ALERTS_ENABLED: 'true' });
  assert.equal(cfg.enabled, true);
});

test('env only: alerting is ON by default', () => {
  // Default-on: the watchdog costs no extra n8n calls and pushes nowhere
  // without ALERT_WEBHOOK_URL, so the safe default is the observable one —
  // notifications.json exists instead of 404ing on a fresh read-only stack.
  assert.equal(loadAlertConfig({}).enabled, true);
});

test('a rules file can switch alerting off when env is silent', () => {
  const { path, cleanup } = rulesFile({ enabled: false });
  try {
    assert.equal(loadAlertConfig({ ALERT_RULES_FILE: path }).enabled, false);
  } finally { cleanup(); }
});

test('ALERTS_ENABLED=false switches OFF alerting the rules file switched on', () => {
  // The kill switch has to work in both directions: the documented contract is
  // "env always wins over the file", and an operator silencing a paging
  // collector reaches for ALERTS_ENABLED=false first.
  const { path, cleanup } = rulesFile({ enabled: true });
  try {
    const cfg = loadAlertConfig({ ALERT_RULES_FILE: path, ALERTS_ENABLED: 'false' });
    assert.equal(cfg.enabled, false);
  } finally { cleanup(); }
});

test('the rules file still decides when ALERTS_ENABLED is unset', () => {
  const { path, cleanup } = rulesFile({ enabled: true });
  try {
    assert.equal(loadAlertConfig({ ALERT_RULES_FILE: path }).enabled, true);
  } finally { cleanup(); }
});

test('numeric env vars win over their file counterparts', () => {
  const { path, cleanup } = rulesFile({ staleAfterMin: 60, minErrors: 9 });
  try {
    const cfg = loadAlertConfig({ ALERT_RULES_FILE: path, ALERT_STALE_AFTER_MIN: '15' });
    assert.equal(cfg.staleAfterMin, 15, 'env wins');
    assert.equal(cfg.minErrors, 9, 'file fills the gap env leaves');
  } finally { cleanup(); }
});

test('ALERT_IGNORE splits, trims and drops empties', () => {
  const cfg = loadAlertConfig({ ALERT_IGNORE: ' a , b ,, c ' });
  assert.deepEqual(cfg.ignore, ['a', 'b', 'c']);
});

test('an unreadable rules file degrades to env-only instead of throwing', () => {
  const said = [];
  const cfg = loadAlertConfig(
    { ALERT_RULES_FILE: '/nope/missing.json', ALERTS_ENABLED: 'true' }, (m) => said.push(m));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.minErrors, 3, 'defaults still apply');
  assert.match(said.join('\n'), /ALERT_RULES_FILE unreadable/);
});

test('a malformed numeric env var falls back to the default and says so', () => {
  const said = [];
  const cfg = loadAlertConfig({ ALERT_MIN_ERRORS: 'lots' }, (m) => said.push(m));
  assert.equal(cfg.minErrors, 3);
  assert.match(said.join('\n'), /ALERT_MIN_ERRORS="lots" is not a valid number/);
});
