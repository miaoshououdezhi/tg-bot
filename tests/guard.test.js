import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { Store } from '../src/store.js';
import { Guard, validateInitData } from '../src/guard.js';
import { createWebServer } from '../src/web.js';

const botToken = '123456:TEST_ONLY_NOT_A_REAL_BOT_TOKEN';
function sign(id, now = 1700000000, extra = {}) {
  const fields = { auth_date: String(now), query_id: 'test-query', user: JSON.stringify({ id, first_name: '测试' }), ...extra };
  const data = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(data).digest('hex') }).toString();
}
function setup(t, overrides = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let current = 1700000000, upstream = async () => { throw new Error('unexpected fetch'); };
  const config = { botToken, turnstileSiteKey: 'public-test-site', turnstileSecret: 'test-secret-only', turnstileHostname: 'verify.example.org', publicUrl: 'https://verify.example.org', ...overrides };
  store.ensureUser({ id: 11, first_name: '访客甲' }, current); store.ensureUser({ id: 22, first_name: '访客乙' }, current);
  const guard = new Guard(store, config, { now: () => current, fetchImpl: (...args) => upstream(...args) });
  return { store, guard, config, now: () => current, advance: seconds => { current += seconds; }, setFetch: fn => { upstream = fn; }, permit: (id = 11) => store.db.prepare("UPDATE users SET verified_until=?,verification_source='manual' WHERE user_id=?").run(current + 86400, id), success: challenge => { upstream = async () => ({ ok: true, json: async () => ({ success: true, hostname: config.turnstileHostname, action: 'contact', cdata: challenge.challengeId }) }); } };
}

test('HMAC accepts signed identity and rejects forgery, duplicate keys, future and expired dates', () => {
  assert.equal(validateInitData(sign(11), botToken, 1700000000).id, 11);
  assert.equal(validateInitData(sign(11, 1700000000, { signature: 'opaque-telegram-signature' }), botToken, 1700000000).id, 11);
  assert.throws(() => validateInitData(sign(11).replace('test-query', 'forged'), botToken, 1700000000), { code: 'identity' });
  assert.throws(() => validateInitData(`${sign(11)}&user=x`, botToken, 1700000000), { code: 'identity' });
  assert.throws(() => validateInitData(sign(11), botToken, 1700000300), { code: 'identity_expired' });
  assert.throws(() => validateInitData(sign(11, 1700000031), botToken, 1700000000), { code: 'identity_expired' });
  assert.throws(() => validateInitData(sign(-11), botToken, 1700000000), { code: 'identity' });
});

test('all supported content requires verification; exact 24 hour expiry and no sliding lifetime', t => {
  const f = setup(t);
  const messages = [{ text: '你好' }, { photo: [{ file_id: 'p', file_size: 10 }] }, { document: { file_id: 'd', file_size: 10 } }, { voice: { file_id: 'v', file_size: 10 } }];
  for (const message of messages) assert.equal(f.guard.checkMessage(11, message).reason, 'verification');
  f.permit(); const until = f.store.getUser(11).verified_until;
  for (const message of messages) assert.equal(f.guard.checkMessage(11, message).allowed, true);
  assert.equal(f.store.getUser(11).verified_until, until);
  f.advance(86400);
  assert.equal(f.guard.checkMessage(11, { text: '过期后的新消息' }).reason, 'verification');
});

test('blocked has priority over permission, content and rate limits', t => {
  const f = setup(t); f.permit();
  f.store.db.prepare('UPDATE users SET blocked=1 WHERE user_id=11').run();
  assert.equal(f.guard.checkMessage(11, { text: 'test' }).reason, 'blocked');
  assert.throws(() => f.guard.createChallenge(sign(11)), { code: 'blocked' });
});

test('duplicate, per-user/global rates, prompt/offline cooldown and configurable links/size', t => {
  const f = setup(t, { messageUserLimit: 3, messageGlobalLimit: 5, maxFileBytes: 10, linkPolicy: 'deny' }); f.permit(); f.permit(22);
  assert.equal(f.guard.checkMessage(11, { text: 'hello' }).allowed, true);
  assert.equal(f.guard.checkMessage(11, { text: 'hello' }).reason, 'duplicate');
  assert.equal(f.guard.checkMessage(11, { text: 'https://example.org' }).reason, 'links');
  assert.equal(f.guard.checkMessage(11, { text: 'next' }).reason, 'rate');
  assert.equal(f.guard.checkMessage(22, { document: { file_id: 'x', file_size: 11 } }).reason, 'size');
  assert.equal(f.guard.checkMessage(22, { text: 'global' }).allowed, true);
  f.advance(61);
  assert.equal(f.guard.checkMessage(22, { text: '隐藏链接', entities: [{ type: 'text_link', url: 'https://example.org' }] }).reason, 'links');
  assert.equal(f.guard.checkMessage(22, { document: { file_id: 'x' } }).reason, 'size');
  assert.equal(f.guard.checkMessage(22, { sticker: { file_id: 'x' } }).reason, 'unsupported');
  assert.equal(f.guard.allowPrompt(11), true); assert.equal(f.guard.allowPrompt(11), false);
  assert.equal(f.guard.allowPrompt(11, 'offline'), true); assert.equal(f.guard.allowPrompt(11, 'offline'), false);
  f.advance(11); assert.equal(f.guard.allowPrompt(11), true); assert.equal(f.guard.allowPrompt(11, 'offline'), false);
});

test('shared delivery limit still rejects excess eligible messages across users', t => {
  const f = setup(t, { messageGlobalLimit: 2 }); f.permit(); f.permit(22);
  assert.equal(f.guard.checkMessage(11, { text: 'first' }).allowed, true);
  assert.equal(f.guard.checkMessage(22, { text: 'second' }).allowed, true);
  assert.equal(f.guard.checkMessage(22, { text: 'third' }).reason, 'rate');
  f.advance(60);
  assert.equal(f.guard.checkMessage(22, { text: 'third' }).allowed, true);
});

test('one user flooding rejected messages cannot exhaust another visitor delivery budget', t => {
  for (const scenario of ['unverified', 'duplicate', 'unsupported', 'size', 'links']) {
    const f = setup(t, { linkPolicy: 'deny' }); f.permit(22);
    if (scenario !== 'unverified') f.permit();
    const messages = {
      unverified: { text: 'not allowed' }, duplicate: { text: 'same content' },
      unsupported: { sticker: { file_id: 's' } }, size: { document: { file_id: 'd', file_size: 50 * 1024 * 1024 } },
      links: { text: 'https://example.org' },
    };
    for (let i = 0; i < 241; i++) f.guard.checkMessage(11, messages[scenario]);
    assert.equal(f.guard.checkMessage(22, { text: `legitimate ${scenario}` }).allowed, true, scenario);
  }
});

test('personal prompt cooldown rejection cannot exhaust other users prompts', t => {
  const f = setup(t);
  for (let i = 0; i < 241; i++) {
    assert.equal(f.guard.allowPrompt(11), i === 0);
    assert.equal(f.guard.allowPrompt(11, 'offline'), i === 0);
  }
  assert.equal(f.guard.allowPrompt(22), true);
  assert.equal(f.guard.allowPrompt(22, 'offline'), true);
});

test('personal verification limits cannot starve another users challenge or submission', async t => {
  const f = setup(t);
  for (let i = 0; i < 241; i++) {
    try { f.guard.createChallenge(sign(11)); }
    catch (error) { assert.ok(['rate', 'challenge_limit'].includes(error.code)); }
  }
  const valid = f.guard.createChallenge(sign(22));
  for (let i = 0; i < 241; i++) {
    await assert.rejects(f.guard.complete(sign(11), 'invalid-challenge', ''), error => ['rate', 'request'].includes(error.code));
  }
  f.success(valid);
  assert.equal((await f.guard.complete(sign(22), valid.challengeId, 'other-user-token')).verifiedUntil, f.now() + 86400);
});

test('default policy allows normal links; media descriptions participate in duplicate checks', t => {
  const f = setup(t); f.permit();
  assert.equal(f.guard.checkMessage(11, { text: 'https://example.org' }).allowed, true);
  const photo = { photo: [{ file_id: 'one', file_unique_id: 'stable', file_size: 2 }], caption: '说明' };
  assert.equal(f.guard.checkMessage(11, photo).allowed, true);
  assert.equal(f.guard.checkMessage(11, { ...photo, photo: [{ file_id: 'changed', file_unique_id: 'stable', file_size: 2 }] }).reason, 'duplicate');
  f.advance(31); assert.equal(f.guard.checkMessage(11, photo).allowed, true);
});

test('valid challenge grants fixed 24 hours and token/challenge cannot replay', async t => {
  const f = setup(t), challenge = f.guard.createChallenge(sign(11)); f.success(challenge);
  const result = await f.guard.complete(sign(11), challenge.challengeId, 'token-one');
  assert.equal(result.verifiedUntil, f.now() + 86400);
  assert.equal(f.store.getUser(11).verification_source, 'turnstile');
  await assert.rejects(f.guard.complete(sign(11), challenge.challengeId, 'token-one'), { code: 'challenge' });
  const another = f.guard.createChallenge(sign(11));
  await assert.rejects(f.guard.complete(sign(11), another.challengeId, 'token-one'), { code: 'replay' });
  assert.equal(f.store.db.prepare('SELECT digest FROM token_uses').get().digest.includes('token-one'), false);
});

test('cross-user challenge use is denied without consuming owner challenge', async t => {
  const f = setup(t), challenge = f.guard.createChallenge(sign(11)); f.success(challenge);
  await assert.rejects(f.guard.complete(sign(22), challenge.challengeId, 'cross-user'), { code: 'challenge' });
  assert.equal(f.store.getUser(22).verified_until, 0);
  await f.guard.complete(sign(11), challenge.challengeId, 'owner-token');
  assert.equal(f.store.getUser(11).verified_until, f.now() + 86400);
});

test('successful verification invalidates existing admin confirmations and concurrent old challenges', async t => {
  const f = setup(t), a = f.guard.createChallenge(sign(11)), b = f.guard.createChallenge(sign(11));
  const originalVersion = f.store.getUser(11).version;
  f.store.db.prepare('INSERT INTO actions(token,user_id,action,user_version,expires_at,used) VALUES(?,?,?,?,?,0)').run('old-confirmation', 11, 'reverify', originalVersion, f.now() + 300);
  const releases = new Map();
  f.setFetch(async (_url, options) => {
    const token = JSON.parse(options.body).response;
    await new Promise(resolve => releases.set(token, resolve));
    return { ok: true, json: async () => ({ success: true, hostname: f.config.turnstileHostname, action: 'contact', cdata: token === 'token-a' ? a.challengeId : b.challengeId }) };
  });
  const first = f.guard.complete(sign(11), a.challengeId, 'token-a');
  const second = f.guard.complete(sign(11), b.challengeId, 'token-b');
  releases.get('token-a')(); await first;
  const user = f.store.getUser(11);
  assert.equal(user.version, originalVersion + 1);
  assert.notEqual(f.store.db.prepare('SELECT user_version FROM actions WHERE token=?').get('old-confirmation').user_version, user.version);
  const rejected = assert.rejects(second, { code: 'changed' });
  releases.get('token-b')(); await rejected;
  assert.equal(f.store.getUser(11).version, originalVersion + 1);
  assert.equal(f.store.getUser(11).verified_until, f.now() + 86400);
});

test('parallel submissions call Siteverify once and cannot replay across challenges', async t => {
  const f = setup(t), a = f.guard.createChallenge(sign(11)), b = f.guard.createChallenge(sign(11));
  let release, calls = 0;
  f.setFetch(async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => ({ success: true, hostname: f.config.turnstileHostname, action: 'contact', cdata: a.challengeId }) }; });
  const pending = f.guard.complete(sign(11), a.challengeId, 'same-token');
  await assert.rejects(f.guard.complete(sign(11), a.challengeId, 'different-token'), { code: 'challenge' });
  await assert.rejects(f.guard.complete(sign(11), b.challengeId, 'same-token'), { code: 'replay' });
  release(); await pending; assert.equal(calls, 1);
});

test('wrong hostname/action/cdata or failed result never grant verification', async t => {
  for (const mismatch of [{ hostname: 'wrong.example' }, { action: 'wrong' }, { cdata: 'wrong' }, { success: false }]) {
    const f = setup(t), challenge = f.guard.createChallenge(sign(11));
    f.setFetch(async () => ({ ok: true, json: async () => ({ success: true, hostname: f.config.turnstileHostname, action: 'contact', cdata: challenge.challengeId, ...mismatch }) }));
    await assert.rejects(f.guard.complete(sign(11), challenge.challengeId, 'test-token'), { code: 'turnstile' });
    assert.equal(f.store.getUser(11).verified_until, 0);
  }
});

test('upstream failure does not grant or revoke existing permission', async t => {
  for (const error of ['timeout', 'non-json', 'http']) {
    const f = setup(t); f.permit(22); const retained = f.store.getUser(22).verified_until;
    const a = f.guard.createChallenge(sign(11)), b = f.guard.createChallenge(sign(22));
    f.setFetch(async () => { if (error === 'timeout') throw new Error('timeout'); return { ok: error !== 'http', json: async () => { throw new Error('invalid json'); } }; });
    await assert.rejects(f.guard.complete(sign(11), a.challengeId, 'first'), { code: 'upstream' });
    await assert.rejects(f.guard.complete(sign(22), b.challengeId, 'second'), { code: 'upstream' });
    assert.equal(f.store.getUser(11).verified_until, 0); assert.equal(f.store.getUser(22).verified_until, retained);
    assert.equal(f.store.db.prepare('SELECT state FROM challenges WHERE id=?').get(a.challengeId).state, 'failed');
  }
});

test('ban and permission version changes during Siteverify prevent grant', async t => {
  for (const sql of ['UPDATE users SET blocked=1,version=version+1 WHERE user_id=11', 'UPDATE users SET version=version+1 WHERE user_id=11']) {
    const f = setup(t), challenge = f.guard.createChallenge(sign(11));
    f.setFetch(async () => { f.store.db.prepare(sql).run(); return { ok: true, json: async () => ({ success: true, hostname: f.config.turnstileHostname, action: 'contact', cdata: challenge.challengeId }) }; });
    await assert.rejects(f.guard.complete(sign(11), challenge.challengeId, 'test-token'));
    assert.equal(f.store.getUser(11).verified_until, 0);
  }
});

test('challenge expiry, user/global cap and creation/submission limits', async t => {
  const f = setup(t, { maxUserChallenges: 1, maxChallenges: 1, challengeLimit: 3, submitLimit: 1 });
  const challenge = f.guard.createChallenge(sign(11));
  assert.throws(() => f.guard.createChallenge(sign(11)), { code: 'challenge_limit' });
  assert.throws(() => f.guard.createChallenge(sign(22)), { code: 'challenge_limit' });
  await assert.rejects(f.guard.complete(sign(11), challenge.challengeId, ''), { code: 'request' });
  await assert.rejects(f.guard.complete(sign(11), challenge.challengeId, 'next'), { code: 'rate' });
  f.advance(300);
  await assert.rejects(f.guard.complete(sign(11, f.now()), challenge.challengeId, 'expired'), { code: 'challenge' });
  const next = f.guard.createChallenge(sign(11, f.now())); assert.ok(next.challengeId);
});

test('HTTP page and APIs enforce origin, exact shape, body cap and readiness', async t => {
  const f = setup(t, { maxBodyBytes: 1024 }); let healthy = true;
  const server = createWebServer(f.guard, f.config, { health: () => healthy });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = f.config.publicUrl) => fetch(`${base}/api/challenge`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res = await fetch(base); assert.equal(res.status, 200); assert.match(await res.text(), /先完成一次验证/); assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200); healthy = false; assert.equal((await fetch(`${base}/healthz`)).status, 503);
  assert.equal((await post({ initData: sign(11) }, 'https://attacker.example')).status, 403);
  assert.equal((await post({ initData: sign(11), user_id: 22 })).status, 400);
  assert.equal((await post({ initData: 'x'.repeat(1025) })).status, 413);
  const chunkedStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/challenge`, { method: 'POST', headers: { origin: f.config.publicUrl, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('x'.repeat(1025)); req.end();
  });
  assert.equal(chunkedStatus, 413);
  res = await post({ initData: sign(11) }); assert.equal(res.status, 200); assert.ok((await res.json()).challengeId);
  assert.equal((await fetch(`${base}/api/challenge`, { method: 'POST', headers: { origin: f.config.publicUrl, 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' }, body: '{invalid' })).status, 400);
});

test('HTTP expires incomplete requests and drops connections over configured socket cap', { timeout: 5000 }, async t => {
  const f = setup(t), server = createWebServer(f.guard, f.config);
  // Shorten production time limits for the same native HTTP timeout path.
  server.requestTimeout = 100; server.headersTimeout = 100; server.connectionsCheckingInterval = 20; server.maxConnections = 1;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = [];
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(resolve); }));
  const first = net.connect(server.address().port, '127.0.0.1'); sockets.push(first); await once(first, 'connect');
  const response = new Promise((resolve, reject) => {
    let data = ''; first.on('data', chunk => { data += chunk; }); first.on('error', reject); first.on('close', () => resolve(data));
  });
  first.write(`POST /api/challenge HTTP/1.1\r\nHost: local\r\nOrigin: ${f.config.publicUrl}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  const dropped = once(server, 'drop');
  const second = net.connect(server.address().port, '127.0.0.1'); sockets.push(second); second.on('error', () => {});
  await dropped;
  assert.match(await response, /408 Request Timeout/);
});
