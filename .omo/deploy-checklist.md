# warpgate-mcp 部署清单

## 前提

- Warpgate 堡垒机已安装 Node.js >= 18
- SSH key `~/.ssh/id_ed25519_warpgate` 已配置
- 目标服务器已手动 SSH 连接过一次（录入 host key）

## 部署步骤

### 1. 上传项目到堡垒机

```bash
rsync -avz --exclude node_modules --exclude dist --exclude '*.db' --exclude config.json ./ warpgate@<bastion>:/opt/warpgate-mcp/
```

### 2. 安装依赖并编译

```bash
cd /opt/warpgate-mcp && npm install && npm run build && npm prune --production
```

### 3. 首次运行（自动生成配置 + token）

```bash
node dist/index.js
```

首次启动会自动创建 `~/.warpgate-mcp/config.json` 并生成随机 token。按 `Ctrl+C` 停止后，可手动编辑配置。

### 4. PM2 进程管理

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 开机自启
```

### 5. 客户端 SSH 隧道

```bash
autossh -M 0 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -N -L 3100:127.0.0.1:3100 maxeagle@101.47.19.193 -p 2222
```

> 客户端通过 SSH 隧道将本地 `127.0.0.1:3100` 转发到堡垒机的 MCP 服务端口。

## 配置说明

| 项目 | 路径 |
|------|------|
| 配置文件 | `~/.warpgate-mcp/config.json` |
| 日志目录 | `~/.warpgate-mcp/logs/` |
| Token 文件 | `~/.warpgate-mcp/token.txt` |

- Token 在首次启动时自动生成，可通过 `WPG_AUTH_TOKEN` 环境变量覆盖
- 配置文件字段说明见 `config.json` 注释

## 健康检查

```bash
# 测试连通性（替换 <token> 为实际值）
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3100/sse
```

成功响应为 `data: [DONE]` 格式的 SSE 流。
