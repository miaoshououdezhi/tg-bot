(() => {
  const status = document.querySelector('#status'), retry = document.querySelector('#retry'), back = document.querySelector('#back');
  const telegram = window.Telegram?.WebApp;
  let widget, expiration, busy = false, generation = 0;
  const show = (state, text) => { document.body.dataset.state = state; status.textContent = text; retry.hidden = !['failure', 'expired'].includes(state); back.hidden = state !== 'success'; };
  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', signal: AbortSignal.timeout(15000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message || '验证失败，请重试。'); return result;
  }
  async function start() {
    if (busy) return;
    const run = ++generation; clearTimeout(expiration); busy = true; retry.disabled = true;
    if (widget !== undefined) { window.turnstile?.remove(widget); widget = undefined; }
    show('loading', '正在准备验证…');
    try {
      if (!telegram?.initData) throw new Error('请关闭此页面，从 Telegram 机器人消息中的“完成验证”按钮重新打开。');
      if (!window.turnstile) throw new Error('验证组件加载失败，请检查网络后重新打开页面。');
      const challenge = await post('/api/challenge', { initData: telegram.initData });
      if (run !== generation) return;
      show('ready', '请完成下方验证。');
      expiration = setTimeout(() => { if (run === generation) show('expired', '本次验证已过期，请点击重新验证。'); }, Math.max(0, challenge.expiresAt * 1000 - Date.now()));
      widget = window.turnstile.render('#widget', {
        sitekey: challenge.siteKey, action: 'contact', cData: challenge.challengeId, language: 'zh-cn', theme: 'auto',
        callback: async token => {
          if (run !== generation) return;
          busy = true; show('loading', '正在确认验证结果…');
          try {
            const result = await post('/api/verify', { initData: telegram.initData, challengeId: challenge.challengeId, token });
            if (run !== generation) return;
            clearTimeout(expiration);
            show('success', `验证成功，有效至 ${new Date(result.verifiedUntil * 1000).toLocaleString('zh-CN')}。请返回 Telegram，重新发送刚才的消息；未验证消息不会自动补发。`);
          } catch (error) { if (run === generation) { clearTimeout(expiration); show('failure', error.name === 'TimeoutError' ? '确认超时，结果尚不确定。请返回机器人尝试发送，或重新验证。' : error.message); } }
          finally { busy = false; retry.disabled = false; }
        },
        'expired-callback': () => { if (run === generation) show('expired', '验证凭证已过期，请重新验证。'); },
        'error-callback': () => { if (run === generation) show('failure', '验证组件暂时不可用，请检查网络并重试。'); },
        'timeout-callback': () => { if (run === generation) show('expired', '验证等待超时，请重新验证。'); },
      });
    } catch (error) { show('failure', error.name === 'TimeoutError' ? '连接超时，请检查网络后重试。' : error.message); }
    finally { busy = false; retry.disabled = false; }
  }
  retry.addEventListener('click', start);
  back.addEventListener('click', () => telegram?.close());
  telegram?.ready(); start();
})();
