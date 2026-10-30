import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { backupDatabase } from './backup.js';
import { acquireLock } from '../src/lock.js';
import { restoreDatabase } from './restore.js';

test('在线备份不改变在途发送；离线恢复身份、权限、映射与高水位，启动保守恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-platform-'));
  const source = join(dir, 'source.sqlite'), snapshot = join(dir, 'backup.sqlite'), target = join(dir, 'restored.sqlite');
  let store, restored;
  try {
    store = new Store(source);
    store.ensureUser({ id: 10001, first_name: '测试访客' }, 100);
    store.db.prepare("UPDATE users SET blocked=1,verified_until=86500,verification_source='manual',status='done' WHERE user_id=10001").run();
    store.db.prepare('INSERT INTO message_mappings VALUES(?,?,?,?,?)').run(90001, 50, 10001, 20, 100);
    store.db.prepare("INSERT INTO deliveries VALUES('d1',1,'visitor',90001,'sending',NULL,100,100)").run();
    store.db.prepare("INSERT INTO meta VALUES('offset','42')").run();
    await backupDatabase(source, snapshot);
    assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE id='d1'").get().state, 'sending');
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    await assert.rejects(backupDatabase(source, snapshot));
    store.close(); store = null;
    restoreDatabase(snapshot, target);
    assert.throws(() => restoreDatabase(snapshot, target));
    restored = new Store(target);
    assert.equal(restored.getUser(10001).blocked, 1);
    assert.equal(restored.getUser(10001).verification_source, 'manual');
    assert.equal(restored.getUser(10001).verified_until, 86500);
    assert.equal(restored.getUser(10001).status, 'done');
    assert.equal(restored.resolveMapping(90001, 50).visitor_chat_id, 10001);
    assert.equal(restored.db.prepare("SELECT value FROM meta WHERE key='offset'").get().value, '42');
    assert.equal(restored.db.prepare("SELECT state FROM deliveries WHERE id='d1'").get().state, 'uncertain');
  } finally { store?.close(); restored?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('恢复拒绝运行锁、坏数据库及未来版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-platform-'));
  try {
    const source = join(dir, 'source.sqlite'), snapshot = join(dir, 'backup.sqlite'), target = join(dir, 'target.sqlite');
    const store = new Store(source); store.close();
    await backupDatabase(source, snapshot);
    const release = acquireLock(target);
    try { assert.throws(() => restoreDatabase(snapshot, target)); } finally { release(); }
    writeFileSync(join(dir, 'broken.sqlite'), 'not a database');
    assert.throws(() => restoreDatabase(join(dir, 'broken.sqlite'), target));
    const future = new Store(source); future.db.exec('PRAGMA user_version=999'); future.close();
    await assert.rejects(backupDatabase(source, join(dir, 'future.sqlite')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
