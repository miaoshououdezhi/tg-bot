import { constants, copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock } from '../src/lock.js';
import { openValidatedDatabase } from './database-files.js';

export function restoreDatabase(source, destination) {
  source = resolve(source); destination = resolve(destination);
  if (source === destination || [destination, `${destination}-wal`, `${destination}-shm`].some(existsSync)) {
    throw new Error('恢复目标或 WAL 文件已存在：先停止服务并完整保留旧数据，恢复不覆盖已有数据库');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  // SQLite 持锁与主进程一致：崩溃后自动释放，锁文件本身会保留。
  const release = acquireLock(destination);
  try {
    if (existsSync(`${source}-wal`)) throw new Error('请从 backup.js 生成的独立快照恢复，不能直接复制运行中的数据库');
    const db = openValidatedDatabase(source);
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
    } finally { db.close(); }
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error('用法：停止服务后 node scripts/restore.js <备份文件> [新目标数据库]'); process.exitCode = 1;
  } else {
    try {
      restoreDatabase(process.argv[2], process.argv[3] || process.env.DB_PATH || './data/bot.sqlite');
      console.log('恢复完成。请核对权限状态；备份之后的新消息映射和操作无法恢复。');
    } catch { console.error('恢复失败：需停止服务，使用匹配版本的完整备份，并确保目标数据库与 WAL 不存在、应用未持有运行锁。'); process.exitCode = 1; }
  }
}
