import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { DatabaseSync } from 'node:sqlite';

const config = { adminId: 900, publicUrl: 'https://verify.example.test/', mappingRetentionDays: 30 };
const visitor = (user, messageId, body = { text: '测试内容' }) => ({ message_id: messageId, chat: { id: user, type: 'private' }, from: { id: user, first_name: `访客 ${user}` }, ...body });
function fixture(t, options = {}) {
  const store = new Store(options.path ?? ':memory:');
  t.after(() => store.close());
  let time = 1_800_000_000;
  const calls = [];
  let sentId = 1000;
  const telegram = { async call(method, params) { calls.push({ method, params }); return { message_id: ++sentId }; } };
  const guard = {
    checkMessage(id) {
      const user = store.getUser(id);
      return user.blocked ? { allowed: false, reason: 'blocked' }
        : user.verified_until <= time ? { allowed: false, reason: 'verification' } : { allowed: true };
    },
    allowPrompt() { return true; },
  };
  const relay = new Relay(store, guard, telegram, config, { now: () => time, ...options });
  const verified = id => { store.ensureUser({ id, first_name: `访客 ${id}` }, time); store.db.prepare("UPDATE users SET verified_until=?, verification_source='turnstile' WHERE user_id=?").run(time + 86400, id); };
  return { store, calls, telegram, guard, relay, verified, now: () => time, advance: seconds => { time += seconds; } };
}

test('schema migrations, stable session numbers, and no ID reuse after cleanup', t => {
  const { store, now } = fixture(t);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const first = store.ensureUser({ id: 1, first_name: '旧名' }, 0);
  store.ensureUser({ id: 1, first_name: '新名' }, 0);
  assert.equal(store.getUser(1).session_id, first.session_id);
  assert.equal(store.getUser(1).display_name, '新名');
  store.cleanup(now());
  assert.equal(store.getUser(1), undefined);
  const next = store.ensureUser({ id: 2, first_name: '二' }, now());
  assert.ok(next.session_id > first.session_id);
});

test('all unverified message types are blocked and never queued or mapped', async t => {
  const f = fixture(t);
  const types = [{ text: '文字' }, { photo: [{ file_id: 'p', file_size: 100 }], caption: '图片' }, { document: { file_id: 'd', file_size: 100 }, caption: '文件' }, { voice: { file_id: 'v', file_size: 100 } }];
  for (let i = 0; i < types.length; i++) await f.relay.handleUpdate({ update_id: i, message: visitor(1, i + 1, types[i]) });
  assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM message_mappings').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 0);
  assert.ok(f.calls.every(c => c.params.chat_id === 1));
});

test('verified visitors interleave, media group parts stay independently replyable, and replies never cross', async t => {
  const f = fixture(t); f.verified(1); f.verified(2);
  await Promise.all([
    f.relay.handleUpdate({ update_id: 1, message: visitor(1, 11, { photo: [{ file_id: 'a' }], media_group_id: 'album1', caption: 'a' }) }),
    f.relay.handleUpdate({ update_id: 2, message: visitor(2, 21, { text: 'b' }) }),
    f.relay.handleUpdate({ update_id: 3, message: visitor(1, 12, { photo: [{ file_id: 'c' }], media_group_id: 'album1' }) }),
  ]);
  const mappings = f.store.db.prepare('SELECT * FROM message_mappings ORDER BY visitor_chat_id,visitor_message_id').all();
  assert.equal(mappings.length, 3);
  assert.deepEqual(mappings.map(m => [m.visitor_chat_id, m.visitor_message_id]), [[1, 11], [1, 12], [2, 21]]);
  for (let i = mappings.length - 1; i >= 0; i--) {
    await f.relay.handleUpdate({ update_id: 100 + i, message: visitor(900, 300 + i, { text: '管理员回复', reply_to_message: { message_id: mappings[i].admin_message_id } }) });
  }
  assert.deepEqual(f.calls.filter(c => c.method === 'copyMessage' && c.params.from_chat_id === 900).map(c => c.params.chat_id), [2, 1, 1]);
  assert.ok(f.calls.filter(c => c.method === 'copyMessage').every(c => !('forward' in c.params)));
});

test('24 hour expiry blocks new visitor messages but preserves historical admin reply', async t => {
  const f = fixture(t); f.verified(1);
  await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 10) });
  const map = f.store.db.prepare('SELECT * FROM message_mappings').get();
  f.advance(86400);
  await f.relay.handleUpdate({ update_id: 2, message: visitor(1, 11) });
  await f.relay.handleUpdate({ update_id: 3, message: visitor(900, 12, { text: '回复历史消息', reply_to_message: { message_id: map.admin_message_id } }) });
  assert.deepEqual(f.calls.filter(c => c.method === 'copyMessage').map(c => c.params.chat_id), [900, 1]);
  assert.equal(f.store.getUser(1).verified_until, f.now());
});

test('admin authority is checked for callbacks and private chat context', async t => {
  let callbacks = 0; let panels = 0;
  const f = fixture(t, { onCallback: async () => { callbacks++; }, onAdminMessage: async () => { panels++; } });
  await f.relay.handleUpdate({ update_id: 1, callback_query: { id: 'a', from: { id: 1 }, message: { chat: { id: 900, type: 'private' } } } });
  await f.relay.handleUpdate({ update_id: 2, callback_query: { id: 'b', from: { id: 900 }, message: { chat: { id: -10, type: 'group' } } } });
  await f.relay.handleUpdate({ update_id: 3, callback_query: { id: 'c', from: { id: 900 }, message: { chat: { id: 900, type: 'private' } } } });
  await f.relay.handleUpdate({ update_id: 4, message: { ...visitor(900, 1), chat: { id: -10, type: 'group' } } });
  await f.relay.handleUpdate({ update_id: 5, message: visitor(900, 2, { text: '/panel' }) });
  assert.equal(callbacks, 1); assert.equal(panels, 1);
  assert.equal(f.calls.filter(c => c.method === 'answerCallbackQuery').length, 2);
});

test('unknown, expired and blocked mappings never guess a recipient', async t => {
  const f = fixture(t); f.verified(1);
  await f.relay.handleUpdate({ update_id: 1, message: visitor(900, 20, { text: '回复', reply_to_message: { message_id: 123 } }) });
  f.store.db.prepare('INSERT INTO message_mappings VALUES(?,?,?,?,?)').run(900, 123, 1, 10, f.now() - 31 * 86400);
  await f.relay.handleUpdate({ update_id: 2, message: visitor(900, 21, { text: '回复', reply_to_message: { message_id: 123 } }) });
  f.store.db.prepare('UPDATE message_mappings SET created_at=?').run(f.now());
  f.store.db.prepare('UPDATE users SET blocked=1 WHERE user_id=1').run();
  await f.relay.handleUpdate({ update_id: 3, message: visitor(900, 22, { text: '回复', reply_to_message: { message_id: 123 } }) });
  assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 0);
});

test('duplicate concurrent updates are claimed exactly once', async t => {
  const f = fixture(t); f.verified(1);
  const update = { update_id: 8, message: visitor(1, 20) };
  await Promise.all(Array.from({ length: 15 }, () => f.relay.handleUpdate(update)));
  assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 1);
});

test('Telegram failures distinguish known rejection from timeout and never blindly retry', async t => {
  for (const failure of [{ code: 403 }, { code: 429, retryAfter: 2 }, { code: 'timeout', uncertain: true }]) {
    const f = fixture(t); f.verified(1);
    f.telegram.call = async (method, params) => { f.calls.push({ method, params }); if (method === 'copyMessage') throw failure; return {}; };
    await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 1) });
    await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 1) });
    const delivery = f.store.db.prepare('SELECT * FROM deliveries').get();
    assert.equal(delivery.state, failure.code === 'timeout' ? 'uncertain' : 'failed');
    assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM message_mappings').get().n, 0);
    assert.ok(!f.calls.some(c => c.method === 'sendMessage' && c.params.text.startsWith('已转交')));
  }
});

test('failed local persistence after successful send becomes uncertain and is not retried', async t => {
  const f = fixture(t); f.verified(1);
  f.store.db.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON message_mappings BEGIN SELECT RAISE(ABORT,'simulated'); END;");
  await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 1) });
  assert.equal(f.store.db.prepare('SELECT state FROM deliveries').get().state, 'uncertain');
  await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 1) });
  assert.equal(f.calls.filter(c => c.method === 'copyMessage').length, 1);
});

test('restart and backup preserve permissions, mappings and delivery uncertainty', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tg-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  store.ensureUser({ id: 1, first_name: '访客' }, 100);
  store.db.exec("UPDATE users SET blocked=1, verified_until=900, verification_source='manual', status='done'; INSERT INTO message_mappings VALUES(900,1000,1,2,100); INSERT INTO deliveries VALUES('1:to_admin',1,'to_admin',900,'sending',NULL,100,100); INSERT INTO updates VALUES(1,'processing',100);");
  await store.backup(join(directory, 'backup.sqlite'));
  store.close(); store = new Store(path);
  assert.equal(store.getUser(1).blocked, 1);
  assert.equal(store.getUser(1).verification_source, 'manual');
  assert.equal(store.resolveMapping(900, 1000).visitor_chat_id, 1);
  assert.equal(store.db.prepare('SELECT state FROM deliveries').get().state, 'uncertain');
  assert.equal(store.claimUpdate(1, 110), false);
  store.close();
  const restored = new Store(join(directory, 'backup.sqlite'));
  assert.equal(restored.getUser(1).status, 'done');
  assert.equal(restored.resolveMapping(900, 1000).visitor_chat_id, 1);
  restored.close();
});

test('future database schema refuses downgrade and transaction rollback is atomic', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tg-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'newer.sqlite'); const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Store(path), /数据库版本/);
  const f = fixture(t);
  assert.throws(() => f.store.transaction(() => { f.store.db.exec("INSERT INTO meta VALUES('rollback','value')"); throw new Error('fail'); }));
  assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='rollback'").get(), undefined);
});

test('new valid visitor content reopens handled session and stored data excludes message body', async t => {
  const f = fixture(t); f.verified(1);
  f.store.db.prepare("UPDATE users SET status='done' WHERE user_id=1").run();
  const previousVersion = f.store.getUser(1).version;
  await f.relay.handleUpdate({ update_id: 1, message: visitor(1, 1, { text: '正文不可持久化-unique-sentinel' }) });
  assert.equal(f.store.getUser(1).status, 'pending');
  assert.equal(f.store.getUser(1).version, previousVersion + 1);
  for (const table of ['users', 'deliveries', 'updates', 'message_mappings', 'meta']) {
    assert.ok(!JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()).includes('unique-sentinel'));
  }
});
