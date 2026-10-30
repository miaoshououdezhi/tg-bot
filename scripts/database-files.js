import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../src/store.js';

export function openValidatedDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份完整性检查未通过');
    if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw new Error('备份数据库版本不匹配，请使用对应版本程序恢复');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份外键检查未通过');
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['users', 'message_mappings', 'deliveries', 'updates', 'challenges', 'meta', 'actions']) {
      if (!names.has(name)) throw new Error('备份缺少必要数据表');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
