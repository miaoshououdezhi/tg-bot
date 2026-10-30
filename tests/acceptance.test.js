import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Store} from '../src/store.js';
import {Guard} from '../src/guard.js';
import {Admin} from '../src/admin.js';
import {Relay} from '../src/relay.js';
import {loadConfig} from '../src/config.js';
const config={...loadConfig({BOT_TOKEN:'123456:'+ 'a'.repeat(32),ADMIN_ID:'1',PUBLIC_URL:'https://verify.example.com',TURNSTILE_SITE_KEY:'synthetic-public',TURNSTILE_SECRET:'synthetic-private'}),messageUserLimit:100,messageGlobalLimit:1000,promptSeconds:1};
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());let now=1700000000,sequence=0,message=100,calls=[];let challenge;
const telegram={call:async(method,params)=>{calls.push({method,...params});return {message_id:++message};}};
const guard=new Guard(store,config,{now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({success:true,hostname:'verify.example.com',action:'contact',cdata:challenge})})});
const admin=new Admin(store,telegram,config,{now:()=>now});const relay=new Relay(store,guard,telegram,config,{now:()=>now,onAdminMessage:m=>admin.onMessage(m),onCallback:q=>admin.onCallback(q)});
const msg=(id,body)=>({update_id:++sequence,message:{message_id:sequence,chat:{id,type:'private'},from:{id,first_name:'same name'},...body}});
const callback=data=>({update_id:++sequence,callback_query:{id:'query'+sequence,from:{id:1},message:{chat:{id:1,type:'private'}},data}});
const sign=id=>{const data=new URLSearchParams({auth_date:String(now),user:JSON.stringify({id,first_name:'same name'})});const d=[...data].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=createHmac('sha256','WebAppData').update(config.botToken).digest();data.set('hash',createHmac('sha256',secret).update(d).digest('hex'));return data.toString();};
const verify=async id=>{const init=sign(id);challenge=guard.createChallenge(init).challengeId;return guard.complete(init,challenge,'synthetic-'+id+'-'+now);};
return {store,guard,admin,relay,msg,callback,verify,calls,telegram,advance:s=>now+=s};}
test('independent full chain: no unverified relay, two same-name users, all media, reverse-order replies, expiry and management',async t=>{
 const f=fixture(t);
 for(const id of [2,3])for(const body of [{text:'before'},{photo:[{file_id:'p',file_unique_id:'p',file_size:100}]},{document:{file_id:'d',file_unique_id:'d',file_size:100}},{voice:{file_id:'v',file_unique_id:'v',file_size:100}}])await f.relay.handleUpdate(f.msg(id,body));
 assert.equal(f.calls.filter(c=>c.method==='copyMessage').length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM message_mappings').get().n,0);
 for(const id of [2,3])await f.verify(id);
 for(const [id,body] of [[2,{text:'user2'}],[3,{photo:[{file_id:'p3',file_unique_id:'p3',file_size:200}],caption:'caption'}],[2,{document:{file_id:'d2',file_unique_id:'d2',file_size:100}}],[3,{voice:{file_id:'v3',file_unique_id:'v3',file_size:100}}]])await f.relay.handleUpdate(f.msg(id,body));
 const maps=f.store.db.prepare('SELECT * FROM message_mappings ORDER BY admin_message_id DESC').all();assert.equal(maps.length,4);
 for(const m of maps)await f.relay.handleUpdate(f.msg(1,{text:'reply',reply_to_message:{message_id:m.admin_message_id}}));
 const replies=f.calls.filter(c=>c.method==='copyMessage'&&c.from_chat_id===1);assert.deepEqual(replies.map(c=>c.chat_id),maps.map(m=>m.visitor_chat_id));
 f.advance(86400);let before=f.calls.filter(c=>c.method==='copyMessage').length;await f.relay.handleUpdate(f.msg(2,{text:'expired'}));assert.equal(f.calls.filter(c=>c.method==='copyMessage').length,before);
 await f.relay.handleUpdate(f.msg(1,{text:'historical reply',reply_to_message:{message_id:maps[0].admin_message_id}}));assert.equal(f.calls.filter(c=>c.method==='copyMessage').length,before+1);
 const act=async action=>f.relay.handleUpdate(f.callback('do:'+f.admin.token(f.store.getUser(2),action)));
 await act('grant');assert.equal(f.store.getUser(2).verification_source,'manual');
 const stale=f.admin.token(f.store.getUser(2),'block');await f.verify(2);await f.relay.handleUpdate(f.callback('do:'+stale));assert.equal(f.store.getUser(2).blocked,0);
 const cancel=f.admin.token(f.store.getUser(2),'block');await f.relay.handleUpdate(f.callback('cancel:'+cancel));await f.relay.handleUpdate(f.callback('do:'+cancel));assert.equal(f.store.getUser(2).blocked,0);
 await act('block');await act('grant');assert.equal(f.store.getUser(2).blocked,1);before=f.calls.filter(c=>c.method==='copyMessage').length;await f.relay.handleUpdate(f.msg(2,{text:'blocked'}));assert.equal(f.calls.filter(c=>c.method==='copyMessage').length,before);
 await act('unblock');await act('grant');await act('revoke');assert.equal(f.store.getUser(2).verified_until,0);
});
test('quick reply persistence failure after accepted send is uncertain',async t=>{
 const f=fixture(t);f.store.ensureUser({id:2,first_name:'test'},1700000000);const token=f.admin.token(f.store.getUser(2),'quick:0');
 const original=f.store.db.prepare.bind(f.store.db);let injected=false;
 f.store.db.prepare=sql=>{if(!injected&&sql.startsWith("UPDATE deliveries SET state='sent'")){injected=true;return {run(){throw new Error('synthetic transient database failure');}};}return original(sql);};
 await f.admin.execute(token);assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&c.chat_id===2).length,1);
 const row=original('SELECT state FROM deliveries').get();assert.equal(row.state,'uncertain');
});
test('persisted quick-reply button never silently changes selected content across configuration reload',async t=>{
 const f=fixture(t);f.store.ensureUser({id:2,first_name:'test'},1700000000);const token=f.admin.token(f.store.getUser(2),'quick:0');
 const changed=new Admin(f.store,f.telegram,{...config,quickReplies:['different reply after restart']},{now:()=>1700000001});
 await changed.execute(token);
 assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&c.chat_id===2).length,0,'old button must be rejected instead of sending changed text');
});
