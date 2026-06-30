# Aerie — Warpgate MCP Server

> 通过 [Warpgate 堡垒机](https://github.com/warp-tech/warpgate) 管理远程服务器、执行命令、传输文件、采集性能指标的 MCP 服务器。

**Aerie** 将 Warpgate 堡垒机的 SSH 目标管理能力包装为标准 MCP（Model Context Protocol）工具，使 AI 客户端（如 Claude、OpenCode）能通过 Warpgate 安全地管理远程服务器。

> 📚 **深入理解项目?** 阅读 [架构文档](docs/ARCHITECTURE.md) —— 分层可展开,含核心机制原理、扩展指南、真实 bug 复盘。

---

## 快速开始

### 前置条件

- Node.js ≥ 18
- 运行中的 [Warpgate](https://github.com/warp-tech/warpgate) 堡垒机
- Warpgate 数据库文件（默认 `/opt/warpgate/data/db/db.sqlite3`）
- SSH 私钥（用于连接 Warpgate 目标主机）

### 安装

```bash
git clone <repo-url>
cd aerie
npm install
npm run build
```

### 配置

首次运行自动生成 `~/.warpgate-mcp/config.json`，默认值如下：

```json
{
  "warpgateDbPath": "/opt/warpgate/data/db/db.sqlite3",
  "sshKeyPath": "~/.ssh/id_ed25519_warpgate",
  "sshStrictHostKeyChecking": true,
  "metricsDbPath": "~/.warpgate-mcp/metrics.db",
  "listenPort": 3100,
  "listenHost": "127.0.0.1",
  "authToken": "<自动生成的 UUID>",
  "logLevel": "info",
  "logDir": "~/.warpgate-mcp/logs"
}
```

也可通过环境变量覆盖：

| 变量 | 说明 |
|---|---|
| `WPG_DB_PATH` | Warpgate 数据库路径 |
| `WPG_SSH_KEY` | SSH 私钥路径 |
| `WPG_AUTH_TOKEN` | Bearer 认证令牌 |
| `WPG_PORT` | 监听端口 |
| `WPG_HOST` | 监听地址 |
| `WPG_LOG_LEVEL` | 日志级别 (`debug`, `info`, `warn`, `error`) |
| `WPG_METRICS_DB` | Metrics 数据库路径（默认 `~/.warpgate-mcp/metrics.db`） |
| `WPG_LOG_DIR` | 日志目录路径（默认 `~/.warpgate-mcp/logs`） |
| `WPG_SSH_STRICT_HOST_KEY` | SSH Host Key 校验开关 (`true`/`false`) |
| `WPG_TLS_CERT_PATH` | TLS 证书路径（可选，启用 HTTPS） |
| `WPG_TLS_KEY_PATH` | TLS 私钥路径（可选，启用 HTTPS） |

### 启动与首次安装

```bash
# 开发模式(热重载)
npm run dev

# 生产模式
npm run build && npm start

# PM2 部署
pm2 start ecosystem.config.cjs
```

**首次安装(Setup):**

服务首次启动时,若未检测到认证 token,会进入 setup 模式:

1. 浏览器访问 `http://127.0.0.1:3100`
2. 自动跳转到 setup 页面,设置 Bearer token(≥8 字符)
3. 设置完成后自动登录,Dashboard 可用
4. MCP 客户端用该 token 连接 `/sse?token=xxx`

Setup 完成后 token 存入 Secret Store(OS Keyring 或加密文件),不落 `config.json` 明文。

### MCP 客户端配置

在 OpenCode / Claude 的 MCP 配置中：

```json
{
  "mcpServers": {
    "aerie": {
      "type": "sse",
      "url": "http://127.0.0.1:3100/sse?token=<your-auth-token>",
      "headers": {
        "Authorization": "Bearer <your-auth-token>"
      }
    }
  }
}
```

---

## 工具参考

### 发现与健康检查

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_list_targets` | 列出所有可用服务器，支持按协议类型过滤 | 只读 |
| `warpgate_health_check` | 对目标服务器执行 ping 检查，返回延迟和在线状态，结果缓存在 metrics 数据库 | 只读 |

### 命令执行

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_exec` | 在目标服务器上执行命令或脚本。支持单条命令和 heredoc 多行脚本。内置 **28 条安全黑名单**，对危险命令分级处置 | 写入 |

**安全拦截机制:**
- **blocked 级**(直接拦截):`rm -rf /` `dd if=` `mkfs.` `sudo` `curl` `nc` `\| bash` fork 炸弹 等
- **warned 级**(放行但标记警告):`sed -i` `systemctl` `useradd` `passwd` 等
- **四级风险评估**(用于审计):critical / high / medium / low

所有命令执行均写入审计日志，记录目标、命令、退出码、耗时、风险等级。

### 文件操作

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_upload` | 上传本地文件到远程服务器（SFTP），本地路径限 `~/.warpgate-mcp` 和 `cwd` | 写入 |
| `warpgate_download` | 从远程服务器下载文件，可指定保存路径或返回内容 | 只读 |
| `warpgate_read_file` | 读取远程文件内容，支持行偏移和行数限制 | 只读 |
| `warpgate_edit_file` | 安全编辑远程文件：自动 `.bak` 备份 → 内容替换 → 生成 diff。使用**文件级队列锁**防止并发冲突 | 写入 |

所有文件操作路径均拒绝 `..` 遍历攻击。

### 性能监控

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_stats` | 采集目标服务器的实时性能快照（CPU / MEM / DISK / NET / LOAD / UPTIME），数据写入 metrics 数据库 | 只读 |
| `warpgate_alert_list` | 列出所有告警规则 | 只读 |
| `warpgate_alert_create` | 创建告警规则（支持 `cpu_percent` / `mem_percent` / `disk_percent` / `load_1m` 指标,snake_case 命名） | 写入 |
| `warpgate_alert_delete` | 删除告警规则 | 写入 |

### 审计日志

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_audit_query` | 查询操作审计日志，支持按目标、工具、风险等级过滤 | 只读 |
| `warpgate_audit_stats` | 查看审计统计摘要（总调用数、成功率、风险分布） | 只读 |

### 系统管理

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_deps_check` | 检查服务器依赖状态（DB 连接、SSH 密钥、配置完整性） | 只读 |
| `warpgate_config_get` | 查看当前配置（authToken 已脱敏） | 只读 |
| `warpgate_config_set` | 修改配置（仅限 `listenPort`, `listenHost`, `logLevel`, `sshStrictHostKeyChecking`） | 写入 |

### 目标管理

| 工具 | 说明 | 权限 |
|---|---|---|
| `warpgate_add_target` | 向 Warpgate 添加新的 SSH 目标（支持 publickey / password 认证） | 敏感 |
| `warpgate_edit_target` | 编辑已有 SSH 目标（名称、主机、端口、用户名、认证方式） | 敏感 |
| `warpgate_remove_target` | 从 Warpgate 删除目标（级联清理 target_roles） | 敏感 |
| `warpgate_get_target` | 获取单个目标详情（通过 ID 或名称） | 只读 |

---

## 架构

```
┌─────────────────┐     MCP/SSE      ┌─────────────────────────────────────┐
│  AI Client      │ ◄──────────────► │  Aerie (Express + MCP SDK)          │
│  (OpenCode,     │                  │                                     │
│   Claude, etc)  │                  │  ├─ auth.ts      — Bearer + 限流     │
│                 │                  │  ├─ config.ts    — 配置管理          │
└─────────────────┘                  │  ├─ db.ts        — Warpgate DB 只读  │
                                     │  ├─ ssh.ts       — ssh2 执行器       │
                                     │  ├─ locks.ts     — 文件级队列锁      │
                                     │  ├─ metrics-db.ts— 自有审计/指标 DB  │
                                     │  ├─ stats.ts     — 调用计数器        │
                                     │  ├─ logger.ts    — Pino 双目标日志   │
                                     │  └─ tools/       — 20 个 MCP 工具    │
                                     └──────────┬──────────────────────────┘
                                                │
                                     ┌──────────▼──────────┐
                                     │  Warpgate 堡垒机      │
                                     │  (SQLite DB + SSH)    │
                                     └──────────┬──────────┘
                                                │
                                     ┌──────────▼──────────┐
                                     │  远程服务器集群       │
                                     │  (SSH 目标)           │
                                     └─────────────────────┘
```

### 安全设计

- **双层认证**：Express Bearer Token + MCP SSE `?token` 参数,Dashboard Cookie Session
- **Setup 实时生效**：首次安装设置 token 后无需重启,`currentConfig` 实时同步
- **令牌桶限流**：60 req/min，按 IP 隔离(反代需 `trust proxy`)
- **敏感操作审计**：目标管理工具标记为 `sensitive`，自动记录审计日志
- **命令黑名单**：28 条正则 + 两级处置(blocked/warned) + 四级风险评估
- **路径防御**：禁止 `..` 遗传,上传路径限定白名单目录
- **文件锁**：相同远程文件的并发编辑自动排队
- **Token 安全存储**：Secret Store(OS Keyring 或 AES-256-GCM 加密),不落 config.json
- **RBAC 预备**：`tool-meta.ts` 定义工具分类和敏感标记，为未来角色权限体系预留

---

## 开发

```bash
# 类型检查
npx tsc --noEmit

# 运行测试
npx vitest run

# 开发热重载
npm run dev
```

### 项目约定

- 文件名：`kebab-case`，import 带 `.js` 后缀（ESM）
- 工具命名：`warpgate_{verb}_{noun}`
- 环境变量：`WPG_*` 前缀
- 工具 handler 通过 `index.ts` 依赖注入 DB，不直接 import
- 错误响应统一格式：`{ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }`

---

## 部署

推荐使用 PM2 部署到 `/opt/aerie/`：

```bash
pm2 start ecosystem.config.cjs
```

服务监听 `127.0.0.1:3100`（仅本地），通过 SSH 隧道或 OpenResty 反向代理暴露公网。支持 HTTPS（配置 `tlsCertPath` / `tlsKeyPath`）。

---

## 技术栈

| 组件 | 技术 |
|---|---|
| 运行时 | Node.js, TypeScript (ES2022/NodeNext) |
| 协议 | MCP SDK (HTTP SSE) |
| Web | Express 5 |
| SSH | ssh2 |
| 数据库 | better-sqlite3 |
| 校验 | Zod |
| 日志 | Pino |
| 测试 | Vitest, Supertest |

---

## 许可证

Apache License 2.0
