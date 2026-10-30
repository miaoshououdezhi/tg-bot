import { randomBytes, createHash } from 'node:crypto';

const templateDigest = text => createHash('sha256').update(text).digest('hex');
const labels = { block:'封禁', unblock:'解除封禁', reverify:'要求重新验证', grant:'手动允许联系 24 小时', revoke:'撤销手动授权', done:'标记已处理', pending:'重新打开' };
export class Admin {
  constructor(store, telegram, config, { now = () => Math.floor(Date.now()/1000) } = {}) {
    Object.assign(this,{store,telegram,config,now});
  }
  async send(text, buttons = []) {
    return this.telegram.call('sendMessage',{chat_id:this.config.adminId,text, ...(buttons.length ? {reply_markup:{inline_keyboard:buttons}} : {})});
  }
  async onMessage(message) {
    if (message.from?.id !== this.config.adminId || message.chat?.id !== this.config.adminId || message.chat?.type !== 'private') return;
    if (/^\/(start|panel)(?:@\w+)?(?:\s|$)/.test(message.text || '')) return this.list(0);
    return this.send('请回复一条有效的访客消息；或发送 /panel 打开会话面板。');
  }
  async list(page = 0) {
    const count = this.store.db.prepare("SELECT count(*) n FROM users WHERE status='pending'").get().n;
    const max = Math.max(0,Math.ceil(count/8)-1); page = Math.min(Math.max(0,page),max);
    const users = this.store.db.prepare("SELECT * FROM users WHERE status='pending' ORDER BY updated_at DESC, session_id DESC LIMIT 8 OFFSET ?").all(page*8);
    const buttons = users.map(u=>[{text:`#${u.session_id} ${u.display_name.slice(0,28)}${u.blocked?' · 已封禁':''}`,callback_data:`view:${u.user_id}`}]);
    const nav=[];
    if (page>0) nav.push({text:'上一页',callback_data:`list:${page-1}`});
    if (page<max) nav.push({text:'下一页',callback_data:`list:${page+1}`});
    if(nav.length) buttons.push(nav);
    buttons.push([{text:'刷新',callback_data:`list:${page}`}]);
    return this.send(`待处理会话：${count} · 第 ${page+1}/${max+1} 页\n已处理会话可通过历史消息上的会话按钮重新打开。`,buttons);
  }
  token(user, action) {
    if (/^quick:\d+$/.test(action)) {
      const text = this.config.quickReplies[Number(action.slice(6))];
      if (typeof text !== 'string') throw new Error('快捷回复不存在');
      action += `:${templateDigest(text)}`;
    }
    const token = randomBytes(16).toString('hex');
    this.store.db.prepare('INSERT INTO actions(token,user_id,action,user_version,expires_at,used) VALUES(?,?,?,?,?,0)').run(token,user.user_id,action,user.version,this.now()+300);
    return token;
  }
  async view(id) {
    const u=this.store.getUser(id);
    if (!u) return this.send('会话已清理或不存在，请使用最新消息。');
    const valid=u.verified_until>this.now();
    const until=valid ? new Date(u.verified_until*1000).toISOString().replace('T',' ').replace('.000Z',' UTC') : '已过期/未验证';
    const text=`会话 #${u.session_id}\nTelegram ID：${u.user_id}\n当前昵称：${u.display_name}\n验证：${valid?'有效':'无效'} · 来源：${{manual:'管理员手动授权',turnstile:'Turnstile'}[u.verification_source] || '无'}\n到期：${until}\n封禁：${u.blocked?'已封禁':'未封禁'}\n处理：${u.status==='done'?'已处理':'待处理'}`;
    const actions=[u.blocked?'unblock':'block','reverify',u.verification_source==='manual'&&valid?'revoke':'grant',u.status==='done'?'pending':'done'];
    const buttons=actions.map(a=>[{text:labels[a],callback_data:`ask:${a}:${u.user_id}`}]);
    if (!u.blocked) buttons.push([{text:'选择快捷回复',callback_data:`quick:${u.user_id}`}]);
    buttons.push([{text:'待处理列表',callback_data:'list:0'}]);
    return this.send(text,buttons);
  }
  async ask(id,action) {
    const u=this.store.getUser(id);
    if(!u || !(action in labels)) return this.send('操作目标无效或已清理。');
    if(action==='grant'&&u.blocked) return this.send('访客已封禁，请先明确解除封禁再授权。');
    if (['done','pending'].includes(action)) return this.execute(this.token(u,action));
    const token=this.token(u,action);
    const note={block:'封禁后可手动解除；不会自动恢复已失效权限。',unblock:'解封后仍按原权限到期时间判断。',reverify:'立即撤销现有联系权限并使在途验证失效。旧权限不能撤销恢复，可重新验证或手动授权。',grant:'从执行成功时授予 24 小时联系权限，可撤销；撤销不会恢复被替换的旧权限。',revoke:'立即终止手动权限，无法恢复原到期时间，可重新授权。'}[action];
    return this.send(`确认对会话 #${u.session_id}（ID ${id}）${labels[action]}？\n${note}\n确认按钮 5 分钟内有效。`,[[{text:'确认执行',callback_data:`do:${token}`},{text:'取消本次操作',callback_data:`cancel:${token}`}]]);
  }
  async execute(token, cancel=false) {
    const result=this.store.transaction(()=>{
      const a=this.store.db.prepare('SELECT * FROM actions WHERE token=?').get(token);
      if(!a || a.used || a.expires_at<=this.now()) return {error:'按钮已使用或过期，请重新打开会话。'};
      this.store.db.prepare('UPDATE actions SET used=1 WHERE token=?').run(token);
      const u=this.store.getUser(a.user_id);
      if(cancel) return {text:'已取消，未执行操作。'};
      if(!u || u.version!==a.user_version) return {error:'会话状态已变化，请刷新后重新操作。'};
      if (a.action.startsWith('quick:')) {
        if(u.blocked) return {error:'访客已封禁，不能发送快捷回复。'};
        const match=/^quick:(\d+):([a-f0-9]{64})$/.exec(a.action);
        const index=match ? Number(match[1]) : -1;
        const text=this.config.quickReplies[index];
        if(!match || typeof text !== 'string' || templateDigest(text)!==match[2]) return {error:'快捷回复已变化，请重新选择。'};
        const deliveryId=`quick:${token}`;
        this.store.db.prepare("INSERT INTO deliveries(id,update_id,direction,target_id,state,error_code,created_at,updated_at) VALUES(?, -1,'admin',?,'sending','',?,?)").run(deliveryId,u.user_id,this.now(),this.now());
        return {quick:index,user:u,deliveryId};
      }
      const changes={
        block:['blocked=1',[]], unblock:['blocked=0',[]],
        reverify:["verified_until=0, verification_source=''",[]],
        grant:["verified_until=?, verification_source='manual'",[this.now()+86400]],
        revoke:["verified_until=0, verification_source=''",[]],
        done:["status='done'",[]], pending:["status='pending'",[]],
      }[a.action];
      if(!changes) return {error:'操作无效。'};
      if(a.action==='grant'&&u.blocked) return {error:'请先解除封禁。'};
      if(a.action==='revoke'&&u.verification_source!=='manual') return {error:'当前没有可撤销的手动授权。'};
      this.store.db.prepare(`UPDATE users SET ${changes[0]}, version=version+1, updated_at=? WHERE user_id=?`).run(...changes[1],this.now(),u.user_id);
      return {text:`会话 #${u.session_id}：已${labels[a.action]}。`,userId:u.user_id};
    });
    if(result.quick!==undefined) {
      try {
        const sent=await this.telegram.call('sendMessage',{chat_id:result.user.user_id,text:this.config.quickReplies[result.quick]});
        if (!Number.isSafeInteger(sent?.message_id) || sent.message_id<=0) throw new Error('invalid_result');
        this.store.db.prepare("UPDATE deliveries SET state='sent',updated_at=? WHERE id=?").run(this.now(),result.deliveryId);
        return this.send(`快捷回复已发送至会话 #${result.user.session_id}，不表示访客已读。`);
      } catch(e) {
        const knownFailure=Number.isInteger(e?.code) && e.code>=400 && e.code<500 && !e.uncertain;
        this.store.db.prepare('UPDATE deliveries SET state=?,error_code=?,updated_at=? WHERE id=?').run(knownFailure?'failed':'uncertain',knownFailure?String(e.code):'unconfirmed',this.now(),result.deliveryId);
        return this.send(knownFailure?'快捷回复发送失败，访客可能已拉黑机器人或 Telegram 暂时限流。请稍后重试。':'发送结果不确定，已记录且不会自动重发。请确认后再决定是否重新发送。');
      }
    }
    await this.send(result.error || result.text);
    if(result.userId) await this.view(result.userId);
  }
  async onCallback(query) {
    if(query.from?.id!==this.config.adminId || query.message?.chat?.id!==this.config.adminId || query.message?.chat?.type!=='private') {
      await this.telegram.call('answerCallbackQuery',{callback_query_id:query.id,text:'无权执行此操作。',show_alert:true}); return;
    }
    await this.telegram.call('answerCallbackQuery',{callback_query_id:query.id});
    const data=query.data || ''; let m;
    if((m=/^list:(\d{1,8})$/.exec(data))) return this.list(Number(m[1]));
    if((m=/^view:(\d{1,16})$/.exec(data))) return this.view(Number(m[1]));
    if((m=/^ask:([a-z]+):(\d{1,16})$/.exec(data))) return this.ask(Number(m[2]),m[1]);
    if((m=/^(do|cancel):([a-f0-9]{32})$/.exec(data))) return this.execute(m[2],m[1]==='cancel');
    if((m=/^quick:(\d{1,16})$/.exec(data))) {
      const u=this.store.getUser(Number(m[1]));
      if(!u || u.blocked) return this.send('会话不存在或访客已封禁。');
      return this.send(`选择要发送给会话 #${u.session_id} 的快捷回复（点击即发送）：`,this.config.quickReplies.map((text,i)=>[{text:text.slice(0,45),callback_data:`do:${this.token(u,`quick:${i}`)}`} ]));
    }
    return this.send('按钮已失效，请发送 /panel 重新打开面板。');
  }
}
