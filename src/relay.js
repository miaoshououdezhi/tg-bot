const supported = message => typeof message.text === 'string' || Array.isArray(message.photo) || !!message.document || !!message.voice;
const privateMessage = message => message?.chat?.type === 'private' && Number.isSafeInteger(message.from?.id)
  && message.from.id > 0 && message.chat.id === message.from.id && !message.from.is_bot;

const messages = {
  blocked: '当前联系权限已被封禁。', verification: '请先完成验证，再返回这里重新发送。未验证的消息不会保存或补发。',
  rate: '发送过于频繁，请稍后再试。', duplicate: '这条内容刚刚发送过，请稍后再试。',
  unsupported: '暂不支持此消息类型，请发送文字、图片、文件或语音。', size: '文件太大，请缩小文件后重试。',
  links: '当前不允许发送链接，请移除链接后重试。',
};

export class Relay {
  constructor(store, guard, telegram, config, { now = () => Math.floor(Date.now() / 1000), onAdminMessage, onCallback } = {}) {
    Object.assign(this, { store, guard, telegram, config, now, onAdminMessage, onCallback });
  }

  verificationKeyboard() {
    return { inline_keyboard: [[{ text: '开始安全验证', web_app: { url: this.config.publicUrl } }]] };
  }

  async prompt(chatId, text, { kind = 'prompt', keyboard } = {}) {
    if (!this.guard.allowPrompt(chatId, kind)) return;
    try {
      await this.telegram.call('sendMessage', { chat_id: chatId, text, ...(keyboard ? { reply_markup: keyboard } : {}) });
    } catch { /* Feedback delivery is best effort, never retry uncertain sends. */ }
  }

  async handleUpdate(update) {
    if (!this.store.claimUpdate(update?.update_id, this.now())) return { duplicate: true };
    try {
      if (update.callback_query) {
        const query = update.callback_query;
        if (query.from?.id === this.config.adminId && query.message?.chat?.id === this.config.adminId
          && query.message.chat.type === 'private' && !query.from.is_bot) {
          if (this.onCallback) await this.onCallback(query);
        } else {
          try { await this.telegram.call('answerCallbackQuery', { callback_query_id: query.id, text: '只有管理员可以执行此操作。', show_alert: true }); } catch {}
        }
      } else if (privateMessage(update.message)) {
        const message = update.message;
        if (message.from.id === this.config.adminId) await this.adminMessage(message, update.update_id);
        else await this.visitorMessage(message, update.update_id);
      } else if (privateMessage(update.edited_message)) {
        await this.prompt(update.edited_message.chat.id, '编辑不会同步到对方，请重新发送需要更正的内容。');
      }
      this.store.finishUpdate(update.update_id, 'done');
      return { handled: true };
    } catch {
      // No request payload or provider error text is persisted or logged.
      this.store.finishUpdate(update.update_id, 'failed');
      return { handled: false, error: 'internal' };
    }
  }

  async visitorMessage(message, updateId) {
    const user = this.store.ensureUser(message.from, this.now());
    if (/^\/start(?:\s|$)/u.test(message.text ?? '')) {
      if (user.blocked) return this.prompt(user.user_id, messages.blocked);
      const welcome = this.config.welcomeText || '这是联系管理员的机器人。请先完成验证，然后重新发送消息。支持文字、图片、文件和语音。请勿发送密码、验证码等敏感信息。';
      return this.prompt(user.user_id, welcome, { keyboard: this.verificationKeyboard() });
    }
    const decision = this.guard.checkMessage(user.user_id, message);
    if (!decision.allowed) {
      return this.prompt(user.user_id, messages[decision.reason] ?? '暂时无法发送，请稍后重试。', {
        keyboard: decision.reason === 'verification' ? this.verificationKeyboard() : undefined,
      });
    }
    if (!supported(message)) return this.prompt(user.user_id, messages.unsupported);
    // Defense in depth: permission may have changed after the initial check.
    const current = this.store.getUser(user.user_id);
    if (current.blocked || current.verified_until <= this.now()) return this.prompt(user.user_id, current.blocked ? messages.blocked : messages.verification);
    const result = await this.copy(updateId, 'to_admin', this.config.adminId, message, {
      reply_markup: { inline_keyboard: [[{ text: `会话 #${user.session_id} · 查看访客资料`, callback_data: `view:${user.user_id}` }]] },
    }, sent => {
      this.store.db.prepare('INSERT INTO message_mappings(admin_chat_id,admin_message_id,visitor_chat_id,visitor_message_id,created_at) VALUES(?,?,?,?,?)')
        .run(this.config.adminId, sent.message_id, user.user_id, message.message_id, this.now());
      this.store.db.prepare("UPDATE users SET status='pending', version=version+1, updated_at=? WHERE user_id=?").run(this.now(), user.user_id);
    });
    if (result === 'sent') await this.prompt(user.user_id, '已转交管理员，等待回复；这不表示管理员已读。');
    else if (result === 'uncertain') await this.prompt(user.user_id, '投递结果暂时无法确认，系统不会自动重发。请稍后确认，避免重复发送。', { kind: 'offline' });
    else await this.prompt(user.user_id, this.config.offlineText || '暂时无法转交管理员，请稍后重新发送。', { kind: 'offline' });
  }

  async adminMessage(message, updateId) {
    if (/^\/(?:start|panel)(?:\s|$)/u.test(message.text ?? '') || !message.reply_to_message) {
      if (this.onAdminMessage) return this.onAdminMessage(message);
      return this.prompt(this.config.adminId, '请回复一条有效的访客消息，或使用 /panel 打开管理面板。');
    }
    if (!supported(message)) return this.prompt(this.config.adminId, messages.unsupported);
    const mapping = this.store.resolveMapping(this.config.adminId, message.reply_to_message.message_id);
    if (!mapping || mapping.created_at < this.now() - (this.config.mappingRetentionDays ?? 30) * 86400) {
      return this.prompt(this.config.adminId, '此消息没有有效的访客映射，或映射已过期。请回复一条近期有效的访客消息。');
    }
    const visitor = this.store.getUser(mapping.visitor_chat_id);
    if (!visitor || visitor.blocked) return this.prompt(this.config.adminId, '该访客已封禁或不存在；请先明确解除封禁后再回复。');
    const result = await this.copy(updateId, 'to_visitor', mapping.visitor_chat_id, message);
    if (result === 'sent') await this.prompt(this.config.adminId, `已发送给会话 #${visitor.session_id}；这不表示访客已读。`);
    else if (result === 'uncertain') await this.prompt(this.config.adminId, '回复结果不确定，系统不会自动重发，请先确认是否收到。');
    else await this.prompt(this.config.adminId, '回复发送失败；访客可能已屏蔽机器人，或 Telegram 暂时不可用。');
  }

  async copy(updateId, direction, targetId, message, extra = {}, onSent) {
    const id = `${updateId}:${direction}`;
    const now = this.now();
    const inserted = this.store.db.prepare("INSERT OR IGNORE INTO deliveries(id,update_id,direction,target_id,state,created_at,updated_at) VALUES(?,?,?,?,'sending',?,?)")
      .run(id, updateId, direction, targetId, now, now).changes;
    if (!inserted) return this.store.db.prepare('SELECT state FROM deliveries WHERE id=?').get(id).state;
    try {
      const sent = await this.telegram.call('copyMessage', { chat_id: targetId, from_chat_id: message.chat.id, message_id: message.message_id, ...extra });
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) throw Object.assign(new Error('invalid_result'), { uncertain: true });
      this.store.transaction(() => {
        if (onSent) onSent(sent);
        this.store.db.prepare("UPDATE deliveries SET state='sent', updated_at=? WHERE id=?").run(this.now(), id);
      });
      return 'sent';
    } catch (error) {
      // A database failure after Telegram accepted is also an uncertain delivery.
      const knownFailure = Number.isInteger(error?.code) && error.code >= 400 && error.code < 500 && !error.uncertain;
      const state = knownFailure ? 'failed' : 'uncertain';
      const code = knownFailure ? String(error.code) : 'unconfirmed';
      this.store.db.prepare('UPDATE deliveries SET state=?, error_code=?, updated_at=? WHERE id=?').run(state, code, this.now(), id);
      return state;
    }
  }
}
