import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Admin } from '../src/admin.js';

function fixture(t) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  let time=1000; const calls=[];
  const telegram={call:async(method,params)=>{calls.push({method,params});return {message_id:calls.length};}};
  const config={adminId:1,quickReplies:['您好','请补充信息']};
  const admin=new Admin(store,telegram,config,{now:()=>time});
  store.ensureUser({id:2,first_name:'访客'},time);
  return {store,admin,calls,telegram,setTime:x=>time=x,query:data=>({id:'q',from:{id:1},message:{chat:{id:1,type:'private'}},data})};
}
test('unauthorized admin callbacks cannot change state or expose panel',async t=>{
  const f=fixture(t);
  await f.admin.onCallback({...f.query('view:2'),from:{id:2}});
  await f.admin.onCallback({...f.query('ask:grant:2'),message:{chat:{id:-1,type:'group'}}});
  assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
  assert.equal(f.store.getUser(2).verified_until,0);
});
test('confirm cancel, single-use, stale state and expiry have precise effects',async t=>{
  const f=fixture(t); await f.admin.ask(2,'block');
  let token=f.store.db.prepare('SELECT token FROM actions').get().token;
  await f.admin.execute(token,true); await f.admin.execute(token);
  assert.equal(f.store.getUser(2).blocked,0);
  token=f.admin.token(f.store.getUser(2),'block');
  await Promise.all([f.admin.execute(token),f.admin.execute(token)]);
  assert.equal(f.store.getUser(2).blocked,1);assert.equal(f.store.getUser(2).version,1);
  token=f.admin.token(f.store.getUser(2),'unblock');f.setTime(1300); await f.admin.execute(token);
  assert.equal(f.store.getUser(2).blocked,1);
  token=f.admin.token(f.store.getUser(2),'unblock');f.store.db.prepare('UPDATE users SET version=version+1').run();await f.admin.execute(token);
  assert.equal(f.store.getUser(2).blocked,1);
});
test('manual grant, revoke, reverify, ban and session transitions',async t=>{
  const f=fixture(t);const act=async a=>f.admin.execute(f.admin.token(f.store.getUser(2),a));
  await act('grant');assert.equal(f.store.getUser(2).verified_until,87400);assert.equal(f.store.getUser(2).verification_source,'manual');
  await act('revoke');assert.equal(f.store.getUser(2).verified_until,0);
  await act('block');await act('grant');assert.equal(f.store.getUser(2).verified_until,0);
  await act('unblock');await act('grant');await act('reverify');assert.equal(f.store.getUser(2).verified_until,0);
  await act('done');assert.equal(f.store.getUser(2).status,'done');await act('pending');assert.equal(f.store.getUser(2).status,'pending');
});
test('quick reply is explicit, durable, single-use and respects blocking',async t=>{
  const f=fixture(t); let token=f.admin.token(f.store.getUser(2),'quick:0');
  await Promise.all([f.admin.execute(token),f.admin.execute(token)]);
  assert.equal(f.calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===2).length,1);
  assert.equal(f.store.db.prepare('SELECT state FROM deliveries').get().state,'sent');
  token=f.admin.token(f.store.getUser(2),'quick:1');f.store.db.prepare('UPDATE users SET blocked=1').run();await f.admin.execute(token);
  assert.equal(f.calls.filter(x=>x.params.chat_id===2).length,1);
});
test('quick reply timeout records uncertainty without retry',async t=>{
  const f=fixture(t);f.telegram.call=async(method,params)=>{if(params.chat_id===2)throw Object.assign(new Error('secret error body'),{code:'timeout',uncertain:true});return {};};
  await f.admin.execute(f.admin.token(f.store.getUser(2),'quick:0'));
  const d=f.store.db.prepare('SELECT * FROM deliveries').get();assert.equal(d.state,'uncertain');assert.equal(d.error_code,'unconfirmed');
});
test('pending list is paginated and identity is rendered as plain text',async t=>{
  const f=fixture(t);for(let id=3;id<25;id++)f.store.ensureUser({id,first_name:'<script> & **'},1000);
  await f.admin.list(1);const panel=f.calls.at(-1).params;assert.equal(panel.reply_markup.inline_keyboard.length,10);assert.match(panel.text,/第 2\/3 页/);
  await f.admin.view(3);assert.equal(f.calls.at(-1).params.parse_mode,undefined);
});


test('accepted quick reply with failed sent record remains uncertain and is not resent',async t=>{
  const f=fixture(t);const token=f.admin.token(f.store.getUser(2),'quick:0');
  const original=f.store.db.prepare.bind(f.store.db);let injected=false;
  f.store.db.prepare=sql=>{if(!injected&&sql.startsWith("UPDATE deliveries SET state='sent'")){injected=true;return {run(){throw new Error('synthetic write failure');}};}return original(sql);};
  await f.admin.execute(token);await f.admin.execute(token);
  assert.equal(f.calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===2).length,1);
  assert.equal(original('SELECT state FROM deliveries').get().state,'uncertain');
});
test('quick reply button binds template digest and rejects changed or legacy templates',async t=>{
  const f=fixture(t);const token=f.admin.token(f.store.getUser(2),'quick:0');
  assert.ok(!f.store.db.prepare('SELECT action FROM actions').get().action.includes('您好'));
  const changed=new Admin(f.store,f.telegram,{adminId:1,quickReplies:['变更后的文案']},{now:()=>1001});
  await changed.execute(token);assert.equal(f.calls.filter(x=>x.params.chat_id===2).length,0);
  const old=f.admin.token(f.store.getUser(2),'quick:0');f.store.db.prepare("UPDATE actions SET action='quick:0' WHERE token=?").run(old);
  await f.admin.execute(old);assert.equal(f.calls.filter(x=>x.params.chat_id===2).length,0);
});
test('quick reply malformed acceptance is uncertain, explicit 403 is failed',async t=>{
  const f=fixture(t);
  f.telegram.call=async()=>({});await f.admin.execute(f.admin.token(f.store.getUser(2),'quick:0'));
  assert.equal(f.store.db.prepare('SELECT state FROM deliveries').get().state,'uncertain');
  f.telegram.call=async(_method,params)=>{if(params.chat_id===2)throw Object.assign(new Error('denied'),{code:403});return {};};
  await f.admin.execute(f.admin.token(f.store.getUser(2),'quick:1'));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM deliveries WHERE state='failed'").get().n,1);
});
