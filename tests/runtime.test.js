import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Telegram } from '../src/telegram.js';
import { acquireLock } from '../src/lock.js';
import { Store } from '../src/store.js';
import { start } from '../src/main.js';

const env={BOT_TOKEN:'123456:'+ 'x'.repeat(32),ADMIN_ID:'1',PUBLIC_URL:'https://verify.example.com',TURNSTILE_SITE_KEY:'test_public_key',TURNSTILE_SECRET:'test_private_key'};
function temp(t){const dir=mkdtempSync(join(tmpdir(),'tg-runtime-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('configuration rejects placeholders, malformed URLs, IDs, limits and ambiguous secrets',t=>{
  assert.equal(loadConfig(env).verificationTtl,86400);
  for(const patch of [{ADMIN_ID:'0'},{PUBLIC_URL:'http://example.com'},{PUBLIC_URL:'https://a:b@example.com'},{PUBLIC_URL:'https://example.com/path'},{TURNSTILE_HOSTNAME:'wrong.example'},{BOT_TOKEN:'REPLACE_ME'},{LINK_POLICY:'anything'},{QUICK_REPLIES:'{}'},{PORT:'0'},{PROMPT_SECONDS:'-1'},{BOT_TOKEN_FILE:'/none'}])assert.throws(()=>loadConfig({...env,...patch}));
  const dir=temp(t);writeFileSync(join(dir,'token'),env.BOT_TOKEN);assert.equal(loadConfig({...env,BOT_TOKEN:'',BOT_TOKEN_FILE:join(dir,'token')}).botToken,env.BOT_TOKEN);
});
test('transport retries only explicit 429 once, respects retry_after and sanitizes errors',async()=>{
  const replies=[{ok:false,error_code:429,parameters:{retry_after:2}},{ok:true,result:{message_id:3}}];const waits=[];let calls=0;
  const tg=new Telegram('FAKE',{fetchImpl:async()=>{calls++;const body=replies.shift();return {ok:body.ok,status:body.ok?200:429,json:async()=>body};},sleep:async ms=>waits.push(ms)});
  assert.equal((await tg.call('copyMessage',{})).message_id,3);assert.equal(calls,2);assert.deepEqual(waits,[2000]);
  for(const code of [403,500]){let n=0;const transport=new Telegram('FAKE',{fetchImpl:async()=>{n++;return {ok:false,status:code,json:async()=>({ok:false,error_code:code,description:'secret'})};}});await assert.rejects(transport.call('copyMessage'),e=>e.code===code&&e.uncertain===(code===500)&&!e.message.includes('secret'));assert.equal(n,1);}
  const broken=new Telegram('FAKE',{fetchImpl:async()=>{throw new Error('https://token-secret');}});await assert.rejects(broken.call('copyMessage'),e=>e.uncertain&&!e.message.includes('token-secret'));
});
test('database runtime lock excludes concurrent instances and releases cleanly',t=>{
  const path=join(temp(t),'db');const release=acquireLock(path);assert.throws(()=>acquireLock(path),/锁定/);release();acquireLock(path)();
});
test('startup rejects foreign bot DB and configured webhook without modifying webhook',async t=>{
  const dir=temp(t);let calls=[];
  const telegram={call:async(method)=>{calls.push(method);if(method==='getMe')return {id:123456,is_bot:true};if(method==='getWebhookInfo')return {url:'https://old.example'};throw new Error('unexpected');}};
  const c={...loadConfig(env),dbPath:join(dir,'bot.db'),host:'127.0.0.1',port:0};
  await assert.rejects(start(c,{telegram}),/Webhook/);assert.deepEqual(calls,['getMe','getWebhookInfo']);
  const store=new Store(c.dbPath);store.db.prepare("UPDATE meta SET value='777' WHERE key='bot_id'").run();store.close();
  await assert.rejects(start(c,{telegram}),/另一个机器人/);
});
test('full application starts, polls, persists high water, serves health and stops with mock Telegram',async t=>{
  const dir=temp(t),calls=[];let polls=0,releasePoll;
  const telegram={call:async(method,params)=>{
    calls.push({method,params});if(method==='getMe')return {id:123456,is_bot:true};if(method==='getWebhookInfo')return {url:''};
    if(method==='getUpdates'){polls++;if(polls===1)return [{update_id:42,message:{message_id:1,from:{id:2,first_name:'test'},chat:{id:2,type:'private'},text:'/start'}}];return new Promise(r=>releasePoll=()=>r([]));}
    if(method==='sendMessage')return {message_id:10};throw new Error('unexpected method');
  }};
  const app=await start({...loadConfig(env),dbPath:join(dir,'bot.db'),host:'127.0.0.1',port:0},{telegram});
  for(let i=0;i<20&&!releasePoll;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(app.store.db.prepare("SELECT value FROM meta WHERE key='poll_offset'").get().value,'43');
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`);assert.equal(response.status,200);
  assert.equal(calls.filter(x=>x.method==='copyMessage').length,0);
  const stopping=app.stop();releasePoll();await stopping;
  const db=new Store(join(dir,'bot.db'));assert.ok(db.getUser(2));db.close();
});
