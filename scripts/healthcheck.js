// 仅检查本地应用就绪状态；不证明真实 Telegram/Turnstile 联调成功。
const port = Number(process.env.PORT || 8080);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
