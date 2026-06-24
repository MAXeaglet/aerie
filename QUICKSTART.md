# Aerie — 快速开始

通过 Warpgate 堡垒机管理 SSH 目标、执行远程命令、传输文件、采集性能指标的 MCP 服务器。

## 安装

```bash
git clone <repo> && cd <repo>
npm install && npm run build
```

## 配置

首次启动自动生成 `~/.warpgate-mcp/config.json`，按需修改后重启。

环境变量（优先级高于配置文件）：

| 变量 | 作用 |
|------|------|
| `WPG_DB_PATH` | Warpgate DB 路径 |
| `WPG_SSH_KEY` | SSH 密钥路径 |
| `WPG_PORT` | 监听端口 |
| `WPG_AUTH_TOKEN` | Bearer token |

## 启动

```bash
pm2 start ecosystem.config.cjs && pm2 save   # 推荐
npm run start                                  # 直接运行
```

默认监听 `127.0.0.1:3100`，需反代暴露公网。

## MCP 客户端连接

```json
{
  "mcpServers": {
    "aerie": {
      "type": "sse",
      "url": "https://<host>/sse?token=<token>"
    }
  }
}
```

## 开发

```bash
npm run dev        # 热重载
npx vitest run     # 测试
npx tsc --noEmit   # 类型检查
```
