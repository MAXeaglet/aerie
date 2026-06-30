# Aerie — 快速开始

Aerie 是一个 MCP 服务器，通过 Warpgate 堡垒机的 SQLite 数据库管理 SSH 目标、执行远程命令、传输文件和采集性能指标。

## 部署

### 前置条件

- Node.js 18+
- PM2: `npm i -g pm2`
- 服务器上已部署 [Warpgate](https://github.com/warpgate-hq/warpgate)
- SSH 密钥对（用于连接 Warpgate 注册的各目标服务器）

### 安装

```bash
# 克隆并安装依赖
git clone <repo-url> /opt/aerie
cd /opt/aerie
npm install

# 编译
npm run build

# 首次运行自动生成配置文件
# 修改 ~/.warpgate-mcp/config.json 中的配置
```

### 配置

配置文件位于 `~/.warpgate-mcp/config.json`，首次启动自动生成：

```json
{
  "warpgateDbPath": "/opt/warpgate/data/db/db.sqlite3",
  "sshKeyPath": "/root/.ssh/id_ed25519_warpgate",
  "sshStrictHostKeyChecking": true,
  "metricsDbPath": "/root/.warpgate-mcp/metrics.db",
  "listenPort": 3100,
  "listenHost": "127.0.0.1",
  "authToken": "<自动生成的 UUID>",
  "logLevel": "info",
  "logDir": "/root/.warpgate-mcp/logs"
}
```

环境变量覆盖（优先级高于 JSON）：

| 变量 | 作用 |
|------|------|
| `WPG_DB_PATH` | Warpgate DB 路径 |
| `WPG_SSH_KEY` | SSH 密钥路径 |
| `WPG_PORT` | 监听端口 |
| `WPG_HOST` | 监听地址 |
| `WPG_AUTH_TOKEN` | Bearer token |
| `WPG_LOG_LEVEL` | 日志级别 |
| `WPG_TLS_CERT_PATH` | TLS 证书（可选） |
| `WPG_TLS_KEY_PATH` | TLS 密钥（可选） |

### PM2 启动

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

### 反向代理（OpenResty / Nginx）

Aerie 监听 `127.0.0.1:3100`，需通过反向代理暴露公网。

```nginx
upstream aerie_backend {
    server 127.0.0.1:3100;
    keepalive 64;
}

server {
    listen 443 ssl;
    server_name aerie.maxeagle.site;

    ssl_certificate     /opt/openresty/ssl/wildcard.maxeagle.site.cer;
    ssl_certificate_key /opt/openresty/ssl/wildcard.maxeagle.site.key;

    location / {
        proxy_pass http://aerie_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
    }
}
```

## 连接 MCP 客户端

### Claude Desktop

```json
{
  "mcpServers": {
    "aerie": {
      "type": "sse",
      "url": "https://aerie.maxeagle.site/sse?token=<WPG_AUTH_TOKEN>"
    }
  }
}
```

### 任意 SSE 客户端

```
Endpoint: https://aerie.maxeagle.site/sse?token=<token>
Message:  POST https://aerie.maxeagle.site/message?token=<token>
```

## 可用工具（共 20 个）

| 工具 | 说明 | 敏感 |
|------|------|------|
| `warpgate_list_targets` | 列出所有 SSH 目标 | - |
| `warpgate_health_check` | 批量健康检查 | - |
| `warpgate_exec` | 在目标上执行命令（42 条命令黑名单） | 是 |
| `warpgate_upload` | 上传文件到目标 | 是 |
| `warpgate_download` | 从目标下载文件 | 是 |
| `warpgate_read_file` | 读取目标文件内容 | 是 |
| `warpgate_edit_file` | 编辑目标文件 | 是 |
| `warpgate_add_target` | 添加 SSH 目标 | 是 |
| `warpgate_edit_target` | 编辑 SSH 目标 | 是 |
| `warpgate_remove_target` | 删除 SSH 目标 | 是 |
| `warpgate_get_target` | 查询目标详情 | - |
| `warpgate_stats` | 性能指标统计 | 是 |
| `warpgate_alert_list` | 告警规则列表 | - |
| `warpgate_alert_create` | 创建告警规则 | 是 |
| `warpgate_alert_delete` | 删除告警规则 | 是 |
| `warpgate_audit_query` | 审计日志查询 | 是 |
| `warpgate_audit_stats` | 审计统计 | 是 |
| `warpgate_deps_check` | 环境依赖检查 | - |
| `warpgate_config_get` | 查看运行配置 | - |
| `warpgate_config_set` | 修改运行配置 | 是 |

## 安全检查

敏感工具（上表标记"是"）需要额外的 Bearer token 认证 + 审计日志记录。
命令执行有 42 条危险模式黑名单（`warpgate_exec`），文件操作受路径白名单保护。
速率限制：60 请求/分钟。

## 开发

```bash
npm run dev        # tsx 热重载
npx vitest run     # 运行测试
npx tsc --noEmit   # 类型检查
```
