import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAlertConfig, createAlertConfig } from './alert-config.mjs';

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

test('ALERTS_ENABLED="" reads as unset: the rules file can still disable', () => {
  // Compose passes ${ALERTS_ENABLED:-}, so an operator who left the variable
  // alone reaches the server as '' — the same empty-as-unset convention
  // envNumber applies to the numeric vars.
  const { path, cleanup } = rulesFile({ enabled: false });
  try {
    assert.equal(loadAlertConfig({ ALERT_RULES_FILE: path, ALERTS_ENABLED: '' }).enabled, false);
  } finally { cleanup(); }
});

test('ALERTS_ENABLED="" without a rules file keeps the default on', () => {
  assert.equal(loadAlertConfig({ ALERTS_ENABLED: '' }).enabled, true);
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

test('the stale grace defaults to 15 minutes with no cadence factor', () => {
  const cfg = loadAlertConfig({});
  assert.equal(cfg.staleGraceMin, 15);
  assert.equal(cfg.staleGraceFactor, 0);
});

test('ALERT_STALE_GRACE_MIN and ALERT_STALE_GRACE_FACTOR are read from env', () => {
  const cfg = loadAlertConfig({ ALERT_STALE_GRACE_MIN: '45', ALERT_STALE_GRACE_FACTOR: '0.5' });
  assert.equal(cfg.staleGraceMin, 45);
  assert.equal(cfg.staleGraceFactor, 0.5);
});

test('a rules file supplies the grace when env is silent', () => {
  const { path, cleanup } = rulesFile({ staleGraceMin: 90, staleGraceFactor: 2 });
  try {
    const cfg = loadAlertConfig({ ALERT_RULES_FILE: path });
    assert.equal(cfg.staleGraceMin, 90);
    assert.equal(cfg.staleGraceFactor, 2);
  } finally { cleanup(); }
});

test('a malformed grace falls back to the default and says so', () => {
  const said = [];
  const cfg = loadAlertConfig({ ALERT_STALE_GRACE_MIN: 'soon' }, (m) => said.push(m));
  assert.equal(cfg.staleGraceMin, 15);
  assert.match(said.join('\n'), /ALERT_STALE_GRACE_MIN="soon" is not a valid number/);
});

// ---- createAlertConfig: reload without a restart (#18) ----------------------
// An in-memory "disk": the test edits `files` and bumps the stamp, the source
// reads through the injected readFile/stat. No timing, no real fs.
function fakeDisk(initial) {
  const files = { '/data/rules.json': { text: JSON.stringify(initial), mtimeMs: 1 } };
  const reads = [];
  return {
    files, reads,
    write(obj, mtimeMs) { files['/data/rules.json'] = { text: typeof obj === 'string' ? obj : JSON.stringify(obj), mtimeMs }; },
    readFile: (p) => { reads.push(p); if (!files[p]) throw new Error(`ENOENT: ${p}`); return files[p].text; },
    stat: (p) => { if (!files[p]) throw new Error(`ENOENT: ${p}`); return { mtimeMs: files[p].mtimeMs, size: files[p].text.length }; },
  };
}
const ENV = { ALERT_RULES_FILE: '/data/rules.json' };
const source = (disk, env = ENV, logs = []) => createAlertConfig(env, { readFile: disk.readFile, stat: disk.stat, log: (m) => logs.push(m) });

test('reload: an unchanged file is not re-read', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const cfg = source(disk);
  const before = disk.reads.length;
  assert.equal(cfg.reloadIfChanged(), false);
  assert.equal(disk.reads.length, before, 'stat only, no read');
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 60);
});

test('reload: a changed mtime re-reads the file and logs the counts', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const logs = [];
  const cfg = source(disk, ENV, logs);
  disk.write({ perWorkflow: { A: { staleAfterMin: 90 }, B: { stuckAfterMin: 5 } }, ignore: ['C'] }, 2);
  assert.equal(cfg.reloadIfChanged(), true);
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 90);
  assert.deepEqual(cfg.current().ignore, ['C']);
  assert.match(logs.at(-1), /reloaded — 2 perWorkflow, 1 ignore/);
});

test('reload: a changed size with the same mtime is still picked up', () => {
  // `docker compose cp` can preserve the source file's timestamp.
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const cfg = source(disk);
  disk.write({ perWorkflow: { A: { staleAfterMin: 6000 } } }, 1);
  assert.equal(cfg.reloadIfChanged(), true);
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 6000);
});

test('reload: a parse failure keeps the last good config and logs once', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const logs = [];
  const cfg = source(disk, ENV, logs);
  disk.write('{ "perWorkflow": ', 2);
  assert.equal(cfg.reloadIfChanged(), false);
  assert.equal(cfg.reloadIfChanged(), false);
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 60, 'never falls back to env only at runtime');
  assert.equal(logs.filter((m) => /not reloaded/.test(m)).length, 1);
  disk.write({ perWorkflow: { A: { staleAfterMin: 75 } } }, 3);
  assert.equal(cfg.reloadIfChanged(), true, 'the next good edit is picked up');
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 75);
});

test('reload: a file that fails validation keeps the last good config', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const logs = [];
  const cfg = source(disk, ENV, logs);
  for (const [bad, i] of [[{ perWorkflow: { A: { staleAfterMin: 'soon' } } }, 2], [{ ignore: 'C' }, 3], [[], 4], [{ minErrors: -1 }, 5]]) {
    disk.write(bad, i);
    assert.equal(cfg.reloadIfChanged(), false, JSON.stringify(bad));
  }
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 60);
  assert.equal(logs.filter((m) => /not reloaded/.test(m)).length, 4);
});

test('reload: a deleted file keeps the last good config and logs once', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const logs = [];
  const cfg = source(disk, ENV, logs);
  delete disk.files['/data/rules.json'];
  cfg.reloadIfChanged();
  cfg.reloadIfChanged();
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 60);
  assert.equal(logs.filter((m) => /not reloaded/.test(m)).length, 1);
});

test('reload: env still wins over the file after a reload', () => {
  const disk = fakeDisk({ staleAfterMin: 60, ignore: ['A'] });
  const cfg = source(disk, { ...ENV, ALERT_STALE_AFTER_MIN: '30', ALERT_IGNORE: 'B', ALERTS_ENABLED: 'false' });
  disk.write({ staleAfterMin: 90, ignore: ['C'], enabled: true }, 2);
  assert.equal(cfg.reloadIfChanged(), true);
  assert.equal(cfg.current().staleAfterMin, 30);
  assert.deepEqual(cfg.current().ignore, ['B']);
  assert.equal(cfg.current().enabled, false);
});

test('reload: SIGHUP re-reads even when the stamp did not change', () => {
  const disk = fakeDisk({ perWorkflow: { A: { staleAfterMin: 60 } } });
  const cfg = source(disk);
  const before = disk.reads.length;
  assert.equal(cfg.reload(), true);
  assert.equal(disk.reads.length, before + 1);
});

test('reload: a file unreadable at boot is picked up once it appears', () => {
  const disk = fakeDisk({});
  delete disk.files['/data/rules.json'];
  const logs = [];
  const cfg = source(disk, ENV, logs);
  assert.match(logs[0], /using env only/);
  disk.write({ perWorkflow: { A: { staleAfterMin: 60 } } }, 2);
  assert.equal(cfg.reloadIfChanged(), true);
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, 60);
});

test('reload: without ALERT_RULES_FILE there is nothing to reload', () => {
  const disk = fakeDisk({});
  const cfg = source(disk, {});
  assert.equal(cfg.reloadIfChanged(), false);
  assert.equal(cfg.reload(), false);
  assert.equal(disk.reads.length, 0);
});

test('numeric strings in the file still load, as they did before validation', () => {
  const disk = fakeDisk({ staleAfterMin: '360', perWorkflow: { A: { staleAfterMin: '0' } } });
  const cfg = source(disk);
  assert.equal(cfg.current().staleAfterMin, 360);
  assert.equal(cfg.current().perWorkflow.A.staleAfterMin, '0');
});
