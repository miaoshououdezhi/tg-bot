export class TelegramError extends Error {
  constructor(code, { retryAfter = 0, uncertain = false } = {}) {
    super(`Telegram 请求失败 (${code})`); this.name = 'TelegramError';
    this.code = code; this.retryAfter = retryAfter; this.uncertain = uncertain;
  }
}
export class Telegram {
  constructor(token, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r,ms)) } = {}) {
    this.token = token; this.fetch = fetchImpl; this.sleep = sleep;
  }
  async call(method, params = {}, retry = true) {
    if (!/^[a-zA-Z]+$/.test(method)) throw new TelegramError('method');
    let response, data;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000), redirect: 'error',
      });
      data = await response.json();
    } catch (error) {
      throw new TelegramError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network', {uncertain:true});
    }
    if (!response.ok || data?.ok !== true) {
      const code = Number(data?.error_code || response.status) || 'protocol';
      const retryAfter = Math.max(1, Number(data?.parameters?.retry_after) || 1);
      if (code === 429 && retry && retryAfter <= 30) {
        await this.sleep(retryAfter * 1000); return this.call(method,params,false);
      }
      throw new TelegramError(code,{retryAfter,uncertain: typeof code !== 'number' || code >= 500});
    }
    return data.result;
  }
}
