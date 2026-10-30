# 部署与运维

## 运行边界

默认只有一个 bot 应用进程和一个 Caddy 入口。SQLite 存储在命名卷 `tg-bot_bot-data`，应用数据路径为 `/app/data/bot.sqlite`；Caddy 证书与配置也分别持久化。不要同时运行两个相同 token 的轮询实例。应用用独立 SQLite 锁数据库阻止同一数据路径的并发进程，锁文件保留是正常行为，不能按“文件存在”判断进程运行，也不要在应用运行中删除锁。

SQLite 数据库绑定机器人 ID。更换不同机器人的 Bot Token 必须使用新的数据卷/数据库，不可把旧消息映射用于新机器人。更换同一机器人的 token 时保留数据，重启前备份。

应用根文件系统只读，UID 1000 的 node 用户只写数据卷和有限 `/tmp`。首建命名卷由镜像目录继承权限。若改成宿主 bind mount，需由部署者预先建立并授予 UID/GID 1000 写权限；不要改成 root 运行规避权限问题。

## 推荐 HTTPS

`.env` 的 `VERIFY_DOMAIN` 为裸域名，不带协议和路径；`PUBLIC_URL=https://同一域名`；`TURNSTILE_HOSTNAME=同一域名`。A/AAAA 记录必须实际可达主机，80/443 应允许公网访问。Caddy 自动获取证书，不需手动拼接 TLS 文件。Caddy 默认不启用请求访问日志，避免 URL 参数写入日志；应用的验证材料只通过 POST 请求体发送，页面不包含秘密。

若修改 `MAX_BODY_BYTES`，同时检查 Caddyfile 的 `request_body max_size`，入口限制默认 16KB。不要为了排错把完整请求体、Bot API 地址或 `.env` 输出到日志。机器人用长轮询，无需对公网开放 Telegram webhook，检测到既有 webhook 会拒绝启动；由机器人拥有者检查后手动处理，程序不会擅自删除。

## 已有反向代理

独立使用以下 compose 文件，不与默认文件叠加：

```sh
docker compose -f compose.proxy.yaml config --quiet
docker compose -f compose.proxy.yaml up -d --build
```

此方案只将应用发布在宿主 `127.0.0.1:8080`，不启动项目 Caddy，不抢占 80/443。已有 Nginx 可使用以下 server 配置，证书路径替换为已有实际证书；HTTP 到 HTTPS 跳转由已有站点策略处理：

```nginx
server {
    listen 443 ssl;
    server_name verify.your-domain.com;
    ssl_certificate /actual/cert/fullchain.pem;
    ssl_certificate_key /actual/cert/privkey.pem;
    client_max_body_size 16k;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
    }
}
```

应用不把任意 `X-Forwarded-For` 当成用户身份，不依赖该请求头放行。若已有代理本身运行于容器，`127.0.0.1` 是代理容器自身，需将两服务接入同一私有 Docker 网络并转发到 `bot:8080`；不要为了连通把应用无保护公开到公网。`PUBLIC_URL` 必须保留用户实际访问的 HTTPS origin。

本文件后续命令以默认 compose 为例，采用已有代理时需统一添加 `-f compose.proxy.yaml`。

## 备份

数据库备份包含身份、权限、封禁和路由映射，不含 Bot Token/Turnstile Secret。`.env`、秘密文件、部署配置与代码版本应另行加密保存。建议每天备份，并在升级前额外备份；保留期限由部署者的数据政策决定，不自动删除旧备份。

在线备份使用 SQLite backup API 创建一致性快照，不直接复制运行中的 `.sqlite` 文件，不触发应用重启恢复逻辑。脚本执行 integrity、外键和 schema 检查，目标存在时拒绝覆盖：

```sh
mkdir -p backups
chmod 700 backups
# 将下面的 20261030-2200 改为当前唯一时间/标签，每次使用新文件名。
docker compose exec bot node scripts/backup.js /tmp/bot-20261030-2200.sqlite
docker compose cp bot:/tmp/bot-20261030-2200.sqlite backups/bot-20261030-2200.sqlite
chmod 600 backups/bot-20261030-2200.sqlite
```

`/tmp` 是临时空间，仅用于传出快照，容器重建会丢失它。不要把唯一备份留在容器内。大数据库可能超过默认 16MiB tmpfs，此时挂载独立备份目录并设置只对 node 用户可写，或使用下述停止后直接从宿主可访问路径备份。数据库备份工具也可直接运行：

```sh
node scripts/backup.js backups/new-snapshot.sqlite /absolute/path/bot.sqlite
```

## 离线恢复

先停止应用，保留旧数据库、WAL/SHM 和完整原始备份。脚本拒绝覆盖已有目标，也拒绝恢复时有应用持锁；请使用与备份 schema 匹配的代码版本。下面使用新的数据库名，完整保留旧库：

```sh
docker compose stop bot
# backups 目录应可被容器 UID 1000 读取；仅临时授予读取，保护其中身份数据。
docker compose run --rm --no-deps \
  -v "$PWD/backups:/backup:ro" \
  bot node scripts/restore.js /backup/bot-20261030-2200.sqlite /app/data/restored-20261030.sqlite
```

Linux 上宿主目录若为其他用户且模式 700/600，UID 1000 无法读取时，使用专门的只读暂存目录并设置对应所有权或精确 ACL，不要把备份设为全员可读。Docker Desktop 的文件共享权限行为需按实际验证。

恢复后在所选 compose 文件的 `environment.DB_PATH` 中改为 `/app/data/restored-20261030.sqlite`，然后：

```sh
docker compose up -d --force-recreate bot
docker compose ps
docker compose logs --tail=100 bot
```

新库里的 bot ID 必须与当前 token 匹配。先核对管理员、封禁、手动权限和会话，再执行受控访客的收发测试。备份后发生的新消息映射、封禁和授权无法凭空恢复；需人工核对这些变化。备份中遗留的 `sending` 在启动时变为 `uncertain`，不会自动重发。Telegram 上已确认的更新可能已不可取回，因此数据库恢复不等于历史聊天全量回放。

## 升级与回退

1. 记录当前源码提交/快照、镜像 ID/digest、配置与 schema 版本，先执行并保留可恢复备份。
2. 将新的经测试代码放入本地目录；本项目不会自动拉取或推送代码。
3. 执行 `npm ci --ignore-scripts && npm test`，再执行 `docker compose build bot`。
4. 停止旧 bot 后用新镜像重建：`docker compose up -d --no-deps bot`，检查日志与健康状态，并验证双向消息。
5. 不可逆迁移发生后，**不能只切回旧镜像**。停止新程序，用匹配版本的备份恢复至新数据库文件，并使用对应旧代码/镜像与配置。恢复点之后的数据变更需要人工核对。

当前 schema 是 v1，首次启动自动创建。遇到高于程序支持版本的数据库会拒绝启动。`docker compose down` 删除服务容器和网络但保留命名数据卷；带 `-v` 的删除命令会删除数据，正常维护不要使用。重建容器和删除数据卷含义不同。

## 验证容器重建与健康

在只用于验收的机器人和数据卷上完成一次验证、封禁/解封及映射后：

```sh
docker compose restart bot
docker compose up -d --force-recreate bot
docker compose exec bot id
docker compose exec bot node scripts/healthcheck.js
```

核对进程不是 root、历史会话编号一致、封禁状态一致、管理员回复仍到同一访客，备份和恢复流程也应完整执行一次。单纯 `docker compose ps` 显示 healthy 不能替代这些检查。容器检查需要 Docker 环境，本次交付环境未安装 Docker，不能声称已执行。

## 故障定位

| 现象 | 检查与处理 |
| --- | --- |
| 启动提示配置不合法 | 核对 `.env` 必填项、数字 ADMIN_ID、HTTPS origin、Site Key/Secret；不要打印完整配置 |
| 数据目录权限错误 | 核对卷挂载和 UID 1000 的权限；不要删除卷或换 root 绕过 |
| 检测到其他实例/轮询冲突 | 停止同 token 的另一实例；应用锁可随进程退出自动释放，不要手工删除活动锁 |
| 存在 webhook | 由拥有者核实原用途后在 Telegram 配置层处理；应用不自动删除 |
| 验证页没有 Telegram 身份 | 从机器人私聊的验证按钮重新打开，超过身份时效需重新打开；不要用普通浏览器地址栏代替 |
| Cloudflare 验证失败/超时 | 检查 widget hostname、公开 Site Key、私密 Secret、服务器出站；重新创建挑战重试，不批量放行 |
| 管理员收不到消息 | 管理员是否先 `/start`、ADMIN_ID 是否正确、访客是否验证/被封禁/超限；注意不确定结果不自动重发 |
| 访客收不到回复 | 是否拉黑机器人、是否回复仍保留映射的消息、是否已封禁；不要按名字猜测收件人 |
| 429 | transport 有限遵循 retry_after；不要通过持续重发放大限流 |
| 发送超时/网络失败 | 结果可能不确定，先双方核对再决定手工重发；不承诺 exactly-once |
| 老消息无法回复 | 映射默认 30 天后清理，或备份恢复丢失了之后映射；请访客重新发消息 |
| HTTPS 证书失败 | 检查 DNS/错误 AAAA、80/443、防火墙、Caddy 持久化卷和 ACME 日志 |
| 健康检查失败 | 检查 bot 日志与外部网络；健康仅是就绪信号，不是服务联调结论 |

日志默认不保存正文、完整验证材料和含秘密的请求 URL。提交问题时只提供错误类别、时间、运行版本和脱敏配置项名；不要附 `.env`、真实 initData/token 或完整数据库。

## 数据保留与发送语义

服务定期清理过期挑战、令牌摘要、回调确认、重复内容摘要与限流桶；验证期固定 24 小时。默认映射/投递元数据 30 天、去重记录 7 天，不活跃且无保留状态的用户身份 90 天。封禁不因时间、重启或验证码通过而取消。清理旧映射后会明确拒绝路由，不能误投递。

发送前记录 intent，Telegram 返回成功后保存映射和 sent。两者不是跨系统原子事务；在远端已发送但本地未记录时，只能记录/恢复为 uncertain。程序不会盲目补发，也不能保证每条消息恰好投递一次。会话面板和消息反馈不会把“转交成功”等同“已读”。
