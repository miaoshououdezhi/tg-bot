import http from 'node:http';
import { readFileSync } from 'node:fs';
import { GuardError } from './guard.js';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/style.css', ['text/css; charset=utf-8', 'style.css']],
].map(([path, [type, file]]) => [path, { type, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

export function createWebServer(guard, config, { health = () => true } = {}) {
  const origin = new URL(config.publicUrl).origin;
  // Global bound protects unauthenticated HMAC/body work without trusting proxy headers.
  let requestWindow = 0, requestCount = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' https://telegram.org https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org");
    const json = (status, body) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); } };
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/healthz') { const ok = Boolean(health()); json(ok ? 200 : 503, { ok }); return; }
      if (req.method === 'GET' && assets.has(path)) { const asset = assets.get(path); res.writeHead(200, { 'content-type': asset.type }); res.end(asset.body); return; }
      if (req.method !== 'POST' || !['/api/challenge', '/api/verify'].includes(path)) { json(404, { error: 'not_found', message: '页面不存在。' }); return; }
      const now = Math.floor(Date.now() / 1000);
      if (now >= requestWindow + 60) { requestWindow = now; requestCount = 0; }
      if (++requestCount > Math.max(120, (config.messageGlobalLimit ?? 120) * 5)) throw new GuardError(429, 'rate', '请求过于频繁，请稍后重试。');
      if (req.headers.origin !== origin) throw new GuardError(403, 'origin', '请从验证页面发起请求。');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) throw new GuardError(415, 'content_type', '请求格式不支持。');
      const max = config.maxBodyBytes ?? 16384;
      if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > max)) throw new GuardError(413, 'body_size', '请求内容过大。');
      const chunks = []; let size = 0;
      // Preserve the stream on early exit so a chunked oversized request receives 413.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > max) throw new GuardError(413, 'body_size', '请求内容过大。'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GuardError(400, 'json', '请求格式无效。'); }
      const keys = path === '/api/challenge' ? ['initData'] : ['initData', 'challengeId', 'token'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => typeof body[key] !== 'string')) throw new GuardError(400, 'request', '请求参数无效。');
      const result = path === '/api/challenge' ? guard.createChallenge(body.initData) : await guard.complete(body.initData, body.challengeId, body.token);
      json(200, result);
    } catch (error) {
      if (error instanceof GuardError) {
        if (!req.complete) { res.setHeader('Connection', 'close'); req.resume(); }
        if (error.status === 429) res.setHeader('Retry-After', '60');
        json(error.status, { error: error.code, message: error.message });
      }
      else json(500, { error: 'internal', message: '服务暂时不可用，请稍后重试。' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50; server.maxConnections = 256;
  return server;
}
