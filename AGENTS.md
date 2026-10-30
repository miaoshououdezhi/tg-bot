# 本项目协作约定

用户授权仅本地开发、测试与构建；禁止推送、PR、发布或生产变更。
先读 docs/requirements.md 和 docs/contracts.md。单实例 Node.js 24+ ESM，使用 node:sqlite，无第三方运行依赖。
每个文件同一时刻仅一个写入者。角色：core 拥有 src/store.js、src/relay.js、tests/core.test.js；guard 拥有 src/guard.js、src/web.js、public/*、tests/guard.test.js；platform 拥有 Dockerfile、compose.yaml、Caddyfile、.env.example、.dockerignore、.gitignore、.github/*、scripts/*、README.md、docs/operations.md；总控拥有其他文件和公共集成。
数据库迁移归 core；任何 schema 修改先通知总控和 guard。测试与安全审查须检查同一冻结快照，不能沿用修改前结论。
不记录秘密、完整 initData、Turnstile token、聊天正文或带 Bot Token 的 URL。所有用户提示中文。测试用虚构身份和凭证。
