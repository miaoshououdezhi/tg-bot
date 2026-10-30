# Telegram 双向联系机器人

安全、无内置广告的单管理员 Telegram 联系入口。访客完成验证后通过机器人发送消息，管理员在与机器人的私聊中直接“回复”对应消息。每条回复按 SQLite 中的消息映射选择收件人，昵称、用户名和正文中的数字不参与路由。

支持文字、图片与说明、文件与说明、语音。多张图片按媒体组中的每条消息独立复制并建立映射，保留内容但不保证相册布局；编辑不会同步，会提示重新发送；删除或撤回不会同步，也无法可靠获知。贴纸、视频等未支持类型会给出中文提示。复制消息不默认暴露管理员个人转发身份，但本服务不是完全匿名通信：机器人运营者能看到访客数字 ID、昵称和消息，Telegram 与 Cloudflare 也分别处理服务所需数据。

应用采用 Node.js 24 LTS、内置 SQLite 和 Telegram 长轮询，没有第三方 npm 运行依赖，也没有广告、追踪脚本、AI 自动回复或付费审核。网页仅使用 Telegram Mini App SDK 和 Cloudflare Turnstile。单实例运行，不要扩容多个 bot 消费者。

## 首次准备

这些外部资源必须由部署者配置，不能省略：

1. 通过 Telegram 的官方 **@BotFather** 创建机器人，保存 Bot Token。管理员先在机器人私聊发送 `/start`。不要把 token 发到公共聊天或提交 Git。
2. 获取管理员本人 Telegram 数字 ID。若不掌握 ID，可先只在 `.env` 填入 Bot Token，在机器人未启动时运行下方的 `discover-admin.js`；它只显示待处理私聊的数字 ID，不记录正文、不确认删除更新。多名用户已经联系机器人时必须识别属于管理员本人的 ID，不可随意选第一条。
3. 准备验证域名，如 `verify.your-domain.com`，将 DNS 指向部署主机，确保 80/443 入站与 Telegram/Cloudflare 出站可达。推荐 Caddy 自动申请和续期 HTTPS。错误的 AAAA 记录也会影响证书和客户端访问。
4. 在 Cloudflare 创建 Turnstile widget，为上述 hostname 授权；取得公开的 Site Key 与私密 Secret。域名必须与 `PUBLIC_URL`、`TURNSTILE_HOSTNAME` 完全一致。不要将 Secret 放入网页。
5. 安装 Docker Engine/Desktop 与 Docker Compose v2。首次读取验证页面需从 Telegram 私聊中点击机器人发出的 **验证按钮**，普通浏览器直接打开没有有效 `initData`，不会放行。使用的 inline `web_app` 按钮需真实 Telegram 客户端验证；可在 BotFather 配置对应 Mini App 域名及入口。

```sh
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写真实配置；不要将其内容粘贴到日志或问题报告。
```

需要发现管理员 ID 时，先安装 Node.js 24+，仅填写 `BOT_TOKEN`，执行：

```sh
node --env-file=.env scripts/discover-admin.js
```

至少填写 `BOT_TOKEN`、`ADMIN_ID`、`VERIFY_DOMAIN`、`ACME_EMAIL`、`PUBLIC_URL`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET`、`TURNSTILE_HOSTNAME`。`.env.example` 内其余参数均有默认值和中文注释。不要运行会将全部变量展开输出的 `docker compose config` 分享给他人；检查时使用 `--quiet`。

秘密还可以通过 `BOT_TOKEN_FILE`、`TURNSTILE_SECRET_FILE` 读取；与同名环境变量二选一。此时需自行把秘密文件以只读 volume/Compose secrets 挂载到容器内相应路径，并确保 UID 1000 能读取。不得把秘密复制进镜像。

## 启动与日常使用

完成外部配置后，在项目根目录运行：

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 bot
```

默认 bot 不向宿主公开端口，Caddy 提供 80/443 HTTPS 入口。应用使用非 root 用户、只读根文件系统、持久化数据卷、健康检查和日志轮转。Caddy 需要监听 80/443，数据与证书分别使用命名卷。`/healthz` 反映应用当前就绪状态，不代表已经完成真实聊天或验证码联调。

完整验收流程：

1. 管理员发送 `/start` 或 `/panel`，确认可以打开管理面板。
2. 用另一个自己控制的访客账号发送文字及图片；未验证时管理员应收不到内容。
3. 点击验证按钮完成 Turnstile。成功页面提示返回 Telegram **重新发送**，原消息不会自动补发。
4. 访客重发文字、图片、文件和语音；管理员能收到内容，点击会话按钮可查看资料，再用 Telegram 的“回复”功能直接回复。
5. 用第二个自己控制的访客账号交错发消息、交错回复，检查接收人。
6. 在面板测试封禁前取消、确认封禁、解封、要求重新验证、手动授权与撤销、已处理和重新打开。访客新有效消息会恢复待处理。
7. 重启 bot 后再回复有效历史消息，确认映射和权限保存。24 小时权限从服务端成功时计算，发消息不续期；过期仅限制访客新消息，管理员仍可回复保留期内的历史消息。

管理员没有回复有效访客消息时，机器人不会猜测收件人。快捷回复由管理员主动点击发送。封禁不能被验证码或手动授权暗中覆盖；必须先明确解除封禁。确认之前可取消，确认后撤销仅限界面明确提供的动作；不能撤回已发出的 Telegram 消息。

“已转交”表示 Telegram 接受发送，不表示管理员已读。超时等结果不确定的发送记录为 `uncertain`，不会自动重发，以降低重复投递风险；需要由双方核对后决定是否手动重发。

## 默认策略

| 配置/规则 | 默认值 |
| --- | --- |
| 联系权限 | 服务端成功起固定 24 小时 |
| Mini App 身份和验证 challenge | 5 分钟 |
| 访客消息频率 | 每用户 20 条/分钟、全局 120 条/分钟 |
| 相同内容抑制 | 30 秒；不会因重复内容永久封禁 |
| 普通提示 | 10 秒限流 |
| 验证申请/提交 | 每用户 5/10 次每分钟 |
| 未完成验证会话 | 全局 1000、单用户 3 |
| 文件/请求体 | 20 MiB / 16 KiB |
| 链接 | 默认允许，`LINK_POLICY=deny` 可拒绝含链接内容 |
| 消息映射与投递状态 | 30 天 |
| 更新去重记录 | 7 天，另持久化轮询 offset |
| 非活跃身份 | 90 天后满足无权限、无封禁、无关联保留状态时清理 |

文件、媒体说明和文字使用一致的权限检查。若 Telegram 未提供附件 file_size，因无法确认大小而拒绝，请换一种发送方式。Turnstile、限流和封禁只能降低滥用，不能完全阻止真人广告或人工代过。应用不默认持久化正文和附件，数据库仍含数字 ID、昵称、权限、映射、摘要与投递元数据，应当保护备份访问权限。映射被清理后旧消息无法继续路由，管理员应请访客重新联系。

## 本地验证与已有代理

无真实凭证时仍可运行模拟测试，无需联网发送 Telegram 消息：

```sh
npm ci --ignore-scripts
npm test
```

本机带真实配置运行可使用 `node --env-file=.env src/main.js`；不要与容器同时轮询同一个机器人。已有反向代理请使用独立方案 `docker compose -f compose.proxy.yaml up -d --build`，详见 [运维说明](docs/operations.md)。

备份、恢复、升级、健康检查、故障定位、数据生命周期与容器重建验证见 [docs/operations.md](docs/operations.md)。需求和模块接口见 [docs/requirements.md](docs/requirements.md)、[docs/contracts.md](docs/contracts.md)。

## 验证与发布边界

测试结果以交付报告中的冻结快照为准。模拟测试、Docker 构建/运行、真实 Telegram、真实 Turnstile/客户端、GitHub Actions、公开镜像与生产部署必须分别记录。生成 Dockerfile 或工作流不意味着构建或 CI 已实际运行；本次本地交付不推送、不建 PR、不发布镜像、不改线上配置。

本地环境未发现 Docker/Podman/Colima，容器构建、非 root 卷权限与容器重建需在具备 Docker 的环境补验；数据库文件重开和备份恢复有独立本地测试。基础镜像已固定官方 registry 返回的多架构 manifest digest。发布前仍需验证所需 CPU 架构，不能根据多架构 manifest 声称每种架构均已运行通过；升级基础镜像需显式更新 digest 并重新验证。

## 许可证

原仓库为空，没有既有许可证。本次没有擅自加入版权声明或开放源码授权。建议仓库所有者在公开发布前选择 MIT 或 Apache-2.0，并填写真实版权归属；在此之前不要把当前仓库视为已授予这两种许可证之一。
