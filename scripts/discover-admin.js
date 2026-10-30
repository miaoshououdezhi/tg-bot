// 首次配置用：仅显示待处理私聊的数字 ID，不显示昵称或聊天正文，不确认/删除更新。
import { readFileSync } from 'node:fs';
let token;
try {
  if (process.env.BOT_TOKEN && process.env.BOT_TOKEN_FILE) throw new Error();
  token = process.env.BOT_TOKEN_FILE ? readFileSync(process.env.BOT_TOKEN_FILE, 'utf8').trim() : process.env.BOT_TOKEN;
  if (!/^\d{5,20}:[A-Za-z0-9_-]{25,}$/.test(token || '')) throw new Error();
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error();
    return data.result;
  };
  const webhook = await call('getWebhookInfo', {});
  if (webhook.url) throw new Error();
  const updates = await call('getUpdates', { timeout: 0, limit: 100 });
  const ids = new Set(updates.filter(u => u.message?.chat?.type === 'private' && u.message.from?.id === u.message.chat.id && !u.message.from?.is_bot).map(u => u.message.from.id));
  if (!ids.size) console.log('没有待处理私聊。请先用管理员账号向机器人发送 /start；确保应用已停止。');
  for (const id of ids) console.log(`待处理私聊数字 ID：${id}（仅选择属于您本人管理员账号的 ID）`);
} catch { console.error('读取失败：检查 BOT_TOKEN、网络、webhook 配置，并确保没有其他轮询实例；详细请求地址不会输出。'); process.exitCode = 1; }
