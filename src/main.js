import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Guard } from './guard.js';
import { Relay } from './relay.js';
import { Admin } from './admin.js';
import { Telegram } from './telegram.js';
import { createWebServer } from './web.js';
import { acquireLock } from './lock.js';

export async function start(config = loadConfig(), {telegram = new Telegram(config.botToken), now = () => Math.floor(Date.now()/1000)} = {}) {
  process.umask(0o077);
  const unlock=acquireLock(config.dbPath);
  let store,server,timer,stopping=false,stopped=false,lastPoll=0,loop;
  const stop=async()=>{
    if(stopped) return; stopping=true; stopped=true;
    clearInterval(timer);
    // Wait for in-flight Telegram work before closing DB; polling times out in 40 s.
    if(server) await new Promise(resolve=>server.close(resolve));
    if(loop) await loop;
    store?.close(); unlock();
  };
  try {
    store=new Store(config.dbPath);
    const me=await telegram.call('getMe');
    if(!Number.isSafeInteger(me?.id) || !me.is_bot) throw new Error('无法确认机器人身份');
    const previous=store.db.prepare("SELECT value FROM meta WHERE key='bot_id'").get();
    if(previous && previous.value!==String(me.id)) throw new Error('数据库属于另一个机器人，请使用单独数据卷。');
    store.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('bot_id',?)").run(String(me.id));
    const hook=await telegram.call('getWebhookInfo');
    if(typeof hook?.url!=='string') throw new Error('无法确认 Telegram Webhook 状态');
    if(hook.url) throw new Error('此机器人已设置 Webhook；请确认旧服务停用后自行移除 Webhook，再启动长轮询。');
    const guard=new Guard(store,config,{now});
    const admin=new Admin(store,telegram,config,{now});
    const relay=new Relay(store,guard,telegram,config,{now,onAdminMessage:m=>admin.onMessage(m),onCallback:q=>admin.onCallback(q)});
    lastPoll=now();
    server=createWebServer(guard,config,{health:()=>!stopping && now()-lastPoll<120});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
    store.cleanup(now(),config);
    timer=setInterval(()=>{try{store.cleanup(now(),config);}catch{console.error('数据清理失败，请检查存储。');}},60000);
    let offset=Number(store.db.prepare("SELECT value FROM meta WHERE key='poll_offset'").get()?.value || 0);
    loop=(async()=>{
      while(!stopping) {
        try {
          const updates=await telegram.call('getUpdates',{offset,timeout:25,limit:50,allowed_updates:['message','callback_query','edited_message']});
          if(!Array.isArray(updates)) throw new Error('invalid_updates');
          lastPoll=now();
          for(const update of updates) {
            if(stopping) break;
            if(!Number.isSafeInteger(update.update_id)||update.update_id<offset) continue;
            const result=await relay.handleUpdate(update);
            if(result.error) console.error('更新处理失败，已记录状态，不自动重复发送。');
            offset=update.update_id+1;
            store.db.prepare("INSERT INTO meta(key,value) VALUES('poll_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(offset));
          }
        } catch(error) {
          // Never log provider exception text or URLs containing credentials.
          console.error(`Telegram 轮询失败，错误类别：${['401','409','429','403','timeout','network'].includes(String(error?.code))?error.code:'service'}。`);
          if(error?.code===401 || error?.code===409) {
            stopping=true; process.exitCode=1;
            setImmediate(()=>void stop());
            break;
          }
          if(!stopping) await new Promise(r=>setTimeout(r,Math.min(30000,Math.max(3000,(error?.retryAfter||0)*1000))));
        }
      }
    })();
    console.log('机器人已就绪；健康检查反映本地服务与轮询状态，不代表真实聊天验证完成。');
    return {stop,store,server,guard,relay,admin};
  } catch(error) { await stop(); throw error; }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const app=await start();
    for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{void app.stop();});
  } catch(error) {
    // Configuration errors are authored locally; Telegram errors expose only code.
    console.error(error?.name==='TelegramError' ? `启动失败：Telegram 错误 ${error.code}` : `启动失败：${error.message}`);
    process.exitCode=1;
  }
}
