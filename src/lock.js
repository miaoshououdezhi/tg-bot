import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// A separate SQLite file holds an OS-backed lock. Process death releases it.
export function acquireLock(dbPath) {
  mkdirSync(dirname(dbPath), {recursive:true,mode:0o700});
  const db=new DatabaseSync(`${dbPath}.lock`);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new Error('数据库已被另一实例或恢复进程锁定，请先停止其他实例。'); }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
