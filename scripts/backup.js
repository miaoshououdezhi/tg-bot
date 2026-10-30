import { DatabaseSync, backup } from 'node:sqlite';
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openValidatedDatabase } from './database-files.js';

export async function backupDatabase(source, destination) {
  source = resolve(source); destination = resolve(destination);
  if (source === destination || existsSync(destination)) throw new Error('备份目标已存在或与来源相同，请使用新文件名');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(destination), '.backup-'));
  const snapshot = join(temporary, 'snapshot.sqlite');
  const db = openValidatedDatabase(source);
  try {
    await backup(db, snapshot);
    const standalone = new DatabaseSync(snapshot);
    try { standalone.exec('PRAGMA journal_mode=DELETE;'); } finally { standalone.close(); }
    chmodSync(snapshot, 0o600);
    const checked = openValidatedDatabase(snapshot);
    checked.close();
    copyFileSync(snapshot, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
  } finally {
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error('用法：node scripts/backup.js <新备份文件> [来源数据库]'); process.exitCode = 1;
  } else {
    try {
      await backupDatabase(process.argv[3] || process.env.DB_PATH || './data/bot.sqlite', process.argv[2]);
      console.log('备份完成，完整性和版本检查通过。请妥善保护身份与权限数据。');
    } catch { console.error('备份失败：请检查来源数据库、版本、目录权限及目标是否已存在。'); process.exitCode = 1; }
  }
}
