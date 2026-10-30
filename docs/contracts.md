# 公共接口 v1（实现前冻结）

Node.js ESM，无第三方依赖。时间统一 Unix 秒整数，注入 now() 返回秒。配置对象 camelCase。

## Store（core）
`new Store(path)` 导出，公开 `.db`（DatabaseSync），`.transaction(fn)` 同步 BEGIN IMMEDIATE/COMMIT/ROLLBACK；不在事务中 await。`.close()`、`.cleanup(now, config)`、`.backup(destination)`（可 async）。初始化迁移，拒绝新于已知的 schema。各模块可用 db 的参数化 SQL，schema 仅 core 修改。

表（字段名固定，额外字段需协调）：
- users: user_id INTEGER PRIMARY KEY, session_id INTEGER UNIQUE NOT NULL（自增稳定、不复用）, display_name TEXT NOT NULL, blocked INTEGER DEFAULT 0, verified_until INTEGER DEFAULT 0, verification_source TEXT DEFAULT '', status TEXT DEFAULT 'pending', version INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER。
- challenges: id TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER, state TEXT（pending/processing/used/failed）, user_version INTEGER, created_at INTEGER。
- token_uses: digest TEXT PRIMARY KEY, expires_at INTEGER。
- rate_limits: key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER。
- duplicates: user_id INTEGER, digest TEXT, expires_at INTEGER, PRIMARY KEY(user_id,digest)。
- message_mappings: admin_chat_id INTEGER, admin_message_id INTEGER, visitor_chat_id INTEGER, visitor_message_id INTEGER, created_at INTEGER, PRIMARY KEY(admin_chat_id,admin_message_id)。部署 DB 专属于一个 bot，meta 绑定 bot_id，禁止换 token 后沿用不同 bot。
- updates: update_id INTEGER PRIMARY KEY, state TEXT, created_at INTEGER。
- deliveries: id TEXT PRIMARY KEY, update_id INTEGER, direction TEXT, target_id INTEGER, state TEXT, error_code TEXT, created_at INTEGER, updated_at INTEGER。
- actions: token TEXT PRIMARY KEY, user_id INTEGER, action TEXT, user_version INTEGER, expires_at INTEGER, used INTEGER DEFAULT 0。
- meta: key TEXT PRIMARY KEY, value TEXT。
`store.ensureUser(telegramUser, now)` 返回用户行（昵称更新不增 version）；`store.getUser(id)`；`store.claimUpdate(id, now)` 原子 false/true；`store.finishUpdate(id,state)`；`store.resolveMapping(adminChat,messageId)` 返回行或 undefined。

## Guard（guard）
`new Guard(store,config,{now,fetchImpl}={})`；`.checkMessage(userId,message)` 同步返回 `{allowed,reason,retryAfter?}`，包括封禁、权限、每用户/全局限流、大小、链接策略及重复内容。reason 为 blocked/verification/rate/duplicate/unsupported/size/links。所有内容入口包括媒体均调用。
`.allowPrompt(userId, kind='prompt')` 同步布尔；`.createChallenge(initData)` 同步返回 `{challengeId,siteKey,expiresAt}` 或抛 `GuardError`（status、code、中文 message）；`.complete(initData,challengeId,token)` async 返回 `{verifiedUntil}`。HTTP 不接受 user_id。
身份必须与已存在 users 行匹配（用户先启动 bot）；user.version 与 challenge.user_version 匹配才可提交，事务中复查封禁、版本及过期。成功增加 version，使旧管理确认及其他在途挑战失效；权限与封禁管理操作也增加 version。token 哈希防并发重放，原文不存储。失败 challenge 不再使用，允许新建重试。
`createWebServer(guard,config,{health}={})` 从 src/web.js 导出，返回未监听的 node:http Server。GET /healthz（health() 布尔），GET /、/app.js、/style.css；POST /api/challenge `{initData}`，POST /api/verify `{initData,challengeId,token}`。JSON 大小限制、严格 origin、禁止缓存，不信任转发头。

## Relay（core）
`new Relay(store,guard,telegram,config,{now,onAdminMessage,onCallback}={})`；`.handleUpdate(update)` async。先 claimUpdate；仅 private 且 from.id=chat.id，拒绝机器人来源。管理员 from.id=adminId 且 chat.id=adminId。callback 必须交给 onCallback；管理员 /start、/panel、非 reply 消息交 onAdminMessage(message)；管理员 reply 消息通过持久化映射复制给访客。访客 /start 返回欢迎与验证按钮；其他消息经 guard，通过 copyMessage 给管理员并记录映射，附身份信息和面板入口。
管理员复制须不泄露个人转发身份（copyMessage）。对访客转管理员的每个映射消息附 inline keyboard `{text:'会话 #N',callback_data:'view:USER_ID'}`，可单发身份说明但不因该说明失败破坏已成功映射。每条可回复内容必须有映射。
telegram 接口：`.call(method,params)` async -> Bot API result，错误对象 `.code`（429/403/400/'timeout'/'network'）、`.retryAfter`，`.uncertain`。429 transport 最多依 retry_after 重试一次（上限 30 秒）；超时/网络/5xx 不重试发送。Relay 在发送前存 sending，成功 sent/失败 failed/不确定 uncertain；只有明确成功展示已转交。不得持久化正文。未知映射提示重新回复有效消息。

## 总控文件
src/config.js 导出 loadConfig(env=process.env)：botToken, adminId, publicUrl, turnstileSiteKey, turnstileSecret, turnstileHostname, dbPath, host, port, messageUserLimit, messageGlobalLimit, duplicateSeconds, promptSeconds, challengeLimit, submitLimit, maxFileBytes, maxBodyBytes, maxChallenges, maxUserChallenges, mappingRetentionDays, identityRetentionDays, welcomeText, offlineText, offlineSeconds, linkPolicy, quickReplies（中文字符串数组）。另 initDataMaxAge=300, challengeTtl=300, verificationTtl=86400。
src/telegram.js transport；src/admin.js 管管理按钮；src/main.js 校验配置/单实例锁/启动 getMe 与 getWebhookInfo（非空 webhook 报错，不擅自删除）/轮询及 HTTP/健康/清理/停止。getUpdates offset 持久化，高水位防旧更新；处理依次 await，guard HTTP 并发事务防重放。

## platform
`npm ci && npm test`；`node src/main.js`；Node 24 LTS 镜像。scripts/backup.js 与 restore.js 复用 Store，备份不含秘密，恢复必须离线并拒绝覆盖现有 DB，备份检查 integrity_check 和 schema。默认 DB_PATH=/app/data/bot.sqlite。HTTP 8080，Caddy 80/443。不得真实调用 Telegram 做测试。

集成补充：Store 导出 SCHEMA_VERSION=1；成功转交新访客消息增加 users.version。管理员快捷回复的 deliveries.update_id=-1、id=quick:随机token。src/lock.js 的 acquireLock(dbPath) 用独立 SQLite 文件持有排他锁，文件保留而锁随进程退出释放。

C2 修订：快捷回复 action 持久化索引与文案 SHA256 摘要，配置变化或旧格式按钮拒绝执行；明确 Telegram 4xx 才为 failed，成功后本地记录失败及异常响应为 uncertain。用户级拒绝不消耗全局有效投递/提示/验证预算，HTTP 独立入口保护仍保留。
