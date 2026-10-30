import { readFileSync } from 'node:fs';

export function loadConfig(env = process.env) {
  const value = (name, fallback = '') => {
    if (env[name] && env[`${name}_FILE`]) throw new Error(`${name} 与 ${name}_FILE 不能同时配置`);
    if (env[`${name}_FILE`]) {
      try { return readFileSync(env[`${name}_FILE`], 'utf8').trim(); }
      catch { throw new Error(`无法读取 ${name}_FILE`); }
    }
    return env[name]?.trim() || fallback;
  };
  const integer = (name, fallback, min = 1, max = 1_000_000_000) => {
    const raw = value(name, String(fallback));
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}–${max} 之间的整数`);
    return n;
  };
  const required = name => {
    const v = value(name);
    if (!v || /^(replace|your|example|填写|changeme)/i.test(v) || /[<>]/.test(v)) throw new Error(`请配置 ${name}`);
    return v;
  };
  const botToken = required('BOT_TOKEN');
  if (!/^\d{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken)) throw new Error('BOT_TOKEN 格式不正确');
  let url;
  try { url = new URL(required('PUBLIC_URL')); } catch { throw new Error('PUBLIC_URL 必须是公网 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || ['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('PUBLIC_URL 必须是无路径、无凭证的公网 HTTPS 根地址');
  const turnstileHostname = value('TURNSTILE_HOSTNAME', url.hostname).toLowerCase();
  if (turnstileHostname !== url.hostname) throw new Error('TURNSTILE_HOSTNAME 必须与 PUBLIC_URL 主机名一致');
  const linkPolicy = value('LINK_POLICY', 'allow');
  if (!['allow','deny'].includes(linkPolicy)) throw new Error('LINK_POLICY 仅支持 allow 或 deny');
  let quickReplies;
  try { quickReplies = JSON.parse(value('QUICK_REPLIES', '["您好，已收到您的消息，我会尽快处理。","请补充相关截图或具体问题，谢谢。"]')); } catch { throw new Error('QUICK_REPLIES 必须为 JSON 字符串数组'); }
  if (!Array.isArray(quickReplies) || quickReplies.length < 1 || quickReplies.length > 8 || quickReplies.some(x => typeof x !== 'string' || !x.trim() || x.length > 1000)) throw new Error('QUICK_REPLIES 需为 1–8 条非空短文本');
  const config = {
    botToken, adminId: integer('ADMIN_ID', 0, 1, Number.MAX_SAFE_INTEGER), publicUrl: url.origin,
    turnstileSiteKey: required('TURNSTILE_SITE_KEY'), turnstileSecret: required('TURNSTILE_SECRET'), turnstileHostname,
    dbPath: value('DB_PATH','./data/bot.sqlite'), host: value('HOST','0.0.0.0'), port: integer('PORT',8080,1,65535),
    messageUserLimit: integer('MESSAGE_USER_LIMIT',20), messageGlobalLimit: integer('MESSAGE_GLOBAL_LIMIT',120),
    duplicateSeconds: integer('DUPLICATE_SECONDS',30), promptSeconds: integer('PROMPT_SECONDS',10),
    challengeLimit: integer('CHALLENGE_LIMIT',5), submitLimit: integer('SUBMIT_LIMIT',10),
    maxFileBytes: integer('MAX_FILE_BYTES',20*1024*1024), maxBodyBytes: integer('MAX_BODY_BYTES',16384,1024,1048576),
    maxChallenges: integer('MAX_CHALLENGES',1000), maxUserChallenges: integer('MAX_USER_CHALLENGES',3),
    mappingRetentionDays: integer('MAPPING_RETENTION_DAYS',30,1,3650), identityRetentionDays: integer('IDENTITY_RETENTION_DAYS',90,1,3650),
    welcomeText: value('WELCOME_TEXT','这是联系管理员的机器人。请先完成验证，再重新发送消息。支持文字、图片、文件和语音。请勿发送密码、验证码等敏感信息。'),
    offlineText: value('OFFLINE_TEXT','管理员暂时无法接收消息，请稍后再试。'), offlineSeconds: integer('OFFLINE_SECONDS',300),
    linkPolicy, quickReplies, initDataMaxAge: 300, challengeTtl: 300, verificationTtl: 86400,
  };
  if (config.welcomeText.length > 2000 || config.offlineText.length > 1000) throw new Error('欢迎或离线提示过长');
  return Object.freeze(config);
}
