import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class GuardError extends Error {
  constructor(status, code, message) { super(message); this.name = 'GuardError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GuardError(status, code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const defaults = {
  initDataMaxAge: 300, challengeTtl: 300, verificationTtl: 86400, messageUserLimit: 20,
  messageGlobalLimit: 120, duplicateSeconds: 30, promptSeconds: 10, offlineSeconds: 3600,
  challengeLimit: 5, submitLimit: 10, maxFileBytes: 20 * 1024 * 1024,
  maxChallenges: 1000, maxUserChallenges: 3, linkPolicy: 'allow',
};

// HMAC validation uses every received field except hash, including signature if supplied.
export function validateInitData(raw, botToken, now, maxAge = 300) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > 12288) fail(401, 'identity', '请从 Telegram 机器人重新打开验证页面。');
  const entries = [...new URLSearchParams(raw)];
  if (entries.length > 30 || new Set(entries.map(([key]) => key)).size !== entries.length) fail(401, 'identity', '身份信息无效，请重新打开页面。');
  const values = Object.fromEntries(entries);
  if (!/^[a-fA-F0-9]{64}$/.test(values.hash ?? '')) fail(401, 'identity', '身份信息无效，请重新打开页面。');
  const data = entries.filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(values.hash, 'hex'))) fail(401, 'identity', '身份校验失败，请重新打开页面。');
  if (!/^\d+$/.test(values.auth_date ?? '')) fail(401, 'identity', '身份时间无效，请重新打开页面。');
  const authDate = Number(values.auth_date);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate >= maxAge) fail(401, 'identity_expired', '页面身份已过期，请关闭并从机器人重新打开。');
  let user;
  try { user = JSON.parse(values.user); } catch { fail(401, 'identity', '缺少 Telegram 身份，请从机器人重新打开。'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true) fail(401, 'identity', 'Telegram 用户身份无效。');
  return user;
}

export class Guard {
  constructor(store, config, { now = () => Math.floor(Date.now() / 1000), fetchImpl = fetch } = {}) {
    this.store = store; this.config = { ...defaults, ...config }; this.now = now; this.fetch = fetchImpl;
  }
  // Call only inside a synchronous store transaction. Failed attempts are counted too.
  rate(key, limit, seconds, now) {
    const row = this.store.db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key);
    if (!row || now >= row.window_start + seconds || now < row.window_start) {
      this.store.db.prepare('INSERT INTO rate_limits(key, window_start, count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1').run(key, now);
      return true;
    }
    this.store.db.prepare('UPDATE rate_limits SET count = min(count + 1, 2147483647) WHERE key = ?').run(key);
    return row.count < limit;
  }
  allowPrompt(userId, kind = 'prompt') {
    const interval = kind === 'offline' ? this.config.offlineSeconds : this.config.promptSeconds;
    return this.store.transaction(() => {
      const now = this.now();
      const local = this.rate(`prompt:${kind === 'offline' ? 'offline' : 'normal'}:${userId}`, 1, interval, now);
      if (!local) return false;
      return this.rate('prompt:global', this.config.messageGlobalLimit, 60, now);
    });
  }
  checkMessage(userId, message) {
    return this.store.transaction(() => {
      const now = this.now(), user = this.store.getUser(userId), c = this.config;
      if (user?.blocked) return { allowed: false, reason: 'blocked' };
      const local = this.rate(`message:${userId}`, c.messageUserLimit, 60, now);
      if (!local) return { allowed: false, reason: 'rate', retryAfter: 60 };
      if (!user || user.verified_until <= now) return { allowed: false, reason: 'verification' };
      let type, file;
      if (typeof message.text === 'string') type = 'text';
      else if (Array.isArray(message.photo) && message.photo.length) { type = 'photo'; file = message.photo.at(-1); }
      else if (message.document) { type = 'document'; file = message.document; }
      else if (message.voice) { type = 'voice'; file = message.voice; }
      else return { allowed: false, reason: 'unsupported' };
      if (file && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > c.maxFileBytes)) return { allowed: false, reason: 'size' };
      const text = `${message.text ?? ''}\n${message.caption ?? ''}`;
      const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
      if (c.linkPolicy === 'deny' && (entities.some(e => ['url', 'text_link'].includes(e.type)) || /(?:https?:\/\/|www\.|(?:t|telegram)\.me\/)/i.test(text))) return { allowed: false, reason: 'links' };
      const digest = hash(JSON.stringify([type, text, file?.file_unique_id ?? file?.file_id ?? '']));
      const duplicate = this.store.db.prepare('SELECT expires_at FROM duplicates WHERE user_id=? AND digest=?').get(userId, digest);
      if (duplicate && duplicate.expires_at > now) return { allowed: false, reason: 'duplicate' };
      // The shared delivery budget counts only content otherwise eligible to forward.
      if (!this.rate('message:global', c.messageGlobalLimit, 60, now)) return { allowed: false, reason: 'rate', retryAfter: 60 };
      this.store.db.prepare('INSERT INTO duplicates(user_id,digest,expires_at) VALUES(?,?,?) ON CONFLICT(user_id,digest) DO UPDATE SET expires_at=excluded.expires_at').run(userId, digest, now + c.duplicateSeconds);
      return { allowed: true, reason: 'allowed' };
    });
  }
  identity(raw) { return validateInitData(raw, this.config.botToken, this.now(), this.config.initDataMaxAge); }
  requireUser(id) {
    const user = this.store.getUser(id);
    if (!user) fail(403, 'start_required', '请先在机器人中发送 /start，再打开验证页面。');
    if (user.blocked) fail(403, 'blocked', '当前会话已封禁，请联系管理员处理。');
    return user;
  }
  verificationRate(id, kind, limit) {
    const allowed = this.store.transaction(() => {
      const now = this.now();
      const user = this.rate(`verify:${kind}:${id}`, limit, 60, now);
      if (!user) return false;
      return this.rate(`verify:${kind}:global`, this.config.messageGlobalLimit, 60, now);
    });
    if (!allowed) fail(429, 'rate', '操作过于频繁，请稍后重试。');
  }
  createChallenge(initData) {
    const identity = this.identity(initData); this.requireUser(identity.id);
    this.verificationRate(identity.id, 'create', this.config.challengeLimit);
    return this.store.transaction(() => {
      const now = this.now(), user = this.requireUser(identity.id), db = this.store.db;
      db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
      const global = db.prepare("SELECT count(*) AS count FROM challenges WHERE state IN ('pending','processing')").get().count;
      const local = db.prepare("SELECT count(*) AS count FROM challenges WHERE user_id=? AND state IN ('pending','processing')").get(user.user_id).count;
      if (global >= this.config.maxChallenges || local >= this.config.maxUserChallenges) fail(429, 'challenge_limit', '验证会话数量已达上限，请稍后重试或等待旧页面过期。');
      const challengeId = randomBytes(24).toString('hex'), expiresAt = now + this.config.challengeTtl;
      db.prepare('INSERT INTO challenges(id,user_id,expires_at,state,user_version,created_at) VALUES(?,?,?,?,?,?)').run(challengeId, user.user_id, expiresAt, 'pending', user.version, now);
      return { challengeId, siteKey: this.config.turnstileSiteKey, expiresAt };
    });
  }
  async complete(initData, challengeId, token) {
    const identity = this.identity(initData); this.requireUser(identity.id);
    this.verificationRate(identity.id, 'submit', this.config.submitLimit);
    if (typeof challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(challengeId) || typeof token !== 'string' || !token || token.length > 2048) fail(400, 'request', '验证参数无效，请重试。');
    this.store.transaction(() => {
      const now = this.now(), db = this.store.db, user = this.requireUser(identity.id);
      const challenge = db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId);
      if (!challenge || challenge.user_id !== identity.id || challenge.expires_at <= now || challenge.state !== 'pending' || challenge.user_version !== user.version) fail(409, 'challenge', '验证已过期、已使用或身份不匹配，请重新验证。');
      db.prepare('DELETE FROM token_uses WHERE expires_at <= ?').run(now);
      const inserted = db.prepare('INSERT OR IGNORE INTO token_uses(digest,expires_at) VALUES(?,?)').run(hash(token), now + 600);
      if (!inserted.changes) fail(409, 'replay', '验证凭证已提交，请重新验证。');
      db.prepare("UPDATE challenges SET state='processing' WHERE id=?").run(challengeId);
    });
    let result;
    try {
      const response = await this.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: this.config.turnstileSecret, response: token }),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error('upstream');
      result = await response.json();
    } catch {
      this.store.db.prepare("UPDATE challenges SET state='failed' WHERE id=? AND state='processing'").run(challengeId);
      fail(503, 'upstream', '验证服务暂时不可用，请点击重试；已有有效权限不受影响。');
    }
    if (result?.success !== true || result.hostname !== this.config.turnstileHostname || result.action !== 'contact' || result.cdata !== challengeId) {
      this.store.db.prepare("UPDATE challenges SET state='failed' WHERE id=? AND state='processing'").run(challengeId);
      fail(403, 'turnstile', '验证失败或凭证过期，请点击重试。');
    }
    return this.store.transaction(() => {
      const now = this.now(), db = this.store.db, user = this.requireUser(identity.id);
      const challenge = db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId);
      if (!challenge || challenge.state !== 'processing' || challenge.expires_at <= now || challenge.user_id !== user.user_id || challenge.user_version !== user.version) fail(409, 'changed', '会话权限已变化或验证已过期，请重新验证。');
      // Expiring initData during an upstream request does not invalidate its already authenticated request.
      const verifiedUntil = now + this.config.verificationTtl;
      db.prepare("UPDATE challenges SET state='used' WHERE id=?").run(challengeId);
      db.prepare("UPDATE users SET verified_until=?,verification_source='turnstile',updated_at=?,version=version+1 WHERE user_id=?").run(verifiedUntil, now, user.user_id);
      return { verifiedUntil };
    });
  }
}
