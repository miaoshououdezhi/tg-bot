import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

export class Store {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) throw new Error('数据库版本高于程序支持版本，请恢复匹配的程序或备份。');
      if (version === 0) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE users (
            user_id INTEGER PRIMARY KEY, session_id INTEGER UNIQUE NOT NULL,
            display_name TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN(0,1)),
            verified_until INTEGER NOT NULL DEFAULT 0, verification_source TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done')),
            version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          CREATE TABLE challenges (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('pending','processing','used','failed')),
            user_version INTEGER NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE INDEX challenges_user ON challenges(user_id, expires_at);
          CREATE TABLE token_uses (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
          CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
          CREATE TABLE duplicates (user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            digest TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id,digest));
          CREATE TABLE message_mappings (
            admin_chat_id INTEGER NOT NULL, admin_message_id INTEGER NOT NULL,
            visitor_chat_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            visitor_message_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(admin_chat_id,admin_message_id)
          );
          CREATE INDEX mappings_visitor ON message_mappings(visitor_chat_id);
          CREATE TABLE updates (update_id INTEGER PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE TABLE deliveries (id TEXT PRIMARY KEY, update_id INTEGER NOT NULL,
            direction TEXT NOT NULL, target_id INTEGER NOT NULL, state TEXT NOT NULL,
            error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE INDEX deliveries_created ON deliveries(created_at);
          CREATE TABLE actions (token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            action TEXT NOT NULL, user_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO meta VALUES ('session_sequence','0');
          PRAGMA user_version=1;
        `);
      });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      // An interrupted external send cannot be proven successful or safe to repeat.
      this.db.prepare("UPDATE deliveries SET state='uncertain', error_code='restart' WHERE state='sending'").run();
      this.db.prepare("UPDATE updates SET state='uncertain' WHERE state='processing'").run();
      this.db.prepare("UPDATE challenges SET state='failed' WHERE state='processing'").run();
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('数据库事务不能包含异步操作');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureUser(user, now) {
    if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new TypeError('无效的用户 ID');
    const name = [user.first_name, user.last_name].filter(x => typeof x === 'string').join(' ').slice(0, 256) || '未命名访客';
    return this.transaction(() => {
      const previous = this.getUser(user.id);
      if (previous) {
        this.db.prepare('UPDATE users SET display_name=?, updated_at=? WHERE user_id=?').run(name, now, user.id);
      } else {
        const next = Number(this.db.prepare("SELECT value FROM meta WHERE key='session_sequence'").get().value) + 1;
        this.db.prepare("UPDATE meta SET value=? WHERE key='session_sequence'").run(String(next));
        this.db.prepare('INSERT INTO users(user_id,session_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?)').run(user.id, next, name, now, now);
      }
      return this.getUser(user.id);
    });
  }

  getUser(id) { return this.db.prepare('SELECT * FROM users WHERE user_id=?').get(id); }

  claimUpdate(id, now) {
    if (!Number.isSafeInteger(id) || id < 0) return false;
    return this.db.prepare("INSERT OR IGNORE INTO updates(update_id,state,created_at) VALUES(?,'processing',?)").run(id, now).changes === 1;
  }

  finishUpdate(id, state) { this.db.prepare('UPDATE updates SET state=? WHERE update_id=?').run(state, id); }

  resolveMapping(adminChat, messageId) {
    return this.db.prepare('SELECT * FROM message_mappings WHERE admin_chat_id=? AND admin_message_id=?').get(adminChat, messageId);
  }

  cleanup(now, config = {}) {
    const mapCutoff = now - (config.mappingRetentionDays ?? 30) * 86400;
    const identityCutoff = now - (config.identityRetentionDays ?? 90) * 86400;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM message_mappings WHERE created_at < ?').run(mapCutoff);
      this.db.prepare('DELETE FROM deliveries WHERE created_at < ?').run(mapCutoff);
      this.db.prepare('DELETE FROM updates WHERE created_at < ?').run(now - 7 * 86400);
      for (const table of ['challenges', 'token_uses', 'duplicates', 'actions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
      }
      this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now - Math.max(3600, config.offlineSeconds ?? 3600, config.promptSeconds ?? 10));
      this.db.prepare(`DELETE FROM users WHERE updated_at < ? AND blocked=0 AND verified_until <= ?
        AND NOT EXISTS (SELECT 1 FROM message_mappings WHERE visitor_chat_id=users.user_id)
        AND NOT EXISTS (SELECT 1 FROM challenges WHERE user_id=users.user_id AND expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM actions WHERE user_id=users.user_id AND expires_at>?)`).run(identityCutoff, now, now, now);
    });
  }

  async backup(destination) {
    if (existsSync(destination)) throw new Error('备份目标已存在，请使用新的文件名。');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await backup(this.db, destination);
    chmodSync(destination, 0o600);
  }

  close() { this.db.close(); }
}
