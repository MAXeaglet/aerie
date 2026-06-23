---
slug: warpgate-mcp
status: approved
intent: clear
pending-action: plan written to .omo/plans/warpgate-mcp.md
approach: "TypeScript MCP server deployed on the Warpgate bastion host, using ssh2 for direct SSH to targets, better-sqlite3 for Warpgate DB reads, and @modelcontextprotocol/sdk for MCP protocol."
---

# Draft: warpgate-mcp

## Components (topology ledger)
| id | outcome | status | evidence path |
|----|---------|--------|---------------|
| C1 | MCP Server (TypeScript, @modelcontextprotocol/sdk) | active | user decision "堡垒机本机" + "TypeScript" |
| C2 | Warpgate DB connector (better-sqlite3 -> /opt/warpgate/data/db/db.sqlite3) | active | user decision "从 Warpgate DB 读取" |
| C3 | SSH executor (ssh2 -> 目标服务器) | active | architecture requirement |
| C4 | SFTP file transfer (ssh2 sftp) | active | architecture requirement |
| C5 | Metrics store (metrics.db via better-sqlite3) | active | scope decision |
| C6 | Audit logger (audit_log table in metrics.db) | active | scope decision |
| C7 | HTTP/SSE transport (Express + SSEServerTransport) | active | MCP server remote deployment requirement |
| C8 | Bearer Token auth middleware | active | user request "做权限控制了吗" |
| C9 | Tool readOnly metadata infrastructure | active | L1 foundation |
| C10 | Pino runtime logger (file-based, level-configurable) | active | grill session - 缺少运行时日志 |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|------------|----------------|-----------|-------------|
| 堡垒机对目标有 SSH key 访问 | 使用 ~/.ssh/id_ed25519_warpgate 或 system SSH key | MCP 在堡垒机上，复用现有 SSH 配置 | Yes - 可配置 key path |
| Warpgate DB 可读 | MCP 进程需要有 /opt/warpgate/data/db/ 读权限 | 需要读取 targets 表 | Yes - 可切换为配置文件 |
| MCP 通过 HTTP/SSE 暴露 | 绑定 127.0.0.1:3100，通过 SSH 隧道或 Nginx 反代暴露 | 远程服务器需要供本地客户端连接 | Yes - 可改为 stdio |

## Findings (cited - path:lines)
- Warpgate DB targets 表结构：id(UUID), name, kind(SSH/HTTP/MySQL/Postgres), options(JSON: host/port/username), description — warpgate-manager SKILL.md:104-131
- 堡垒机 SSH 连接格式：`用户名:目标名@101.47.19.193 -p 2222` — warpgate-client SKILL.md:38-46
- Web 管理 API 在 127.0.0.1:8888（HTTPS 自签名证书）— warpgate-manager SKILL.md:12-13
- Warpgate 原生支持会话录制和 Web UI 查看 — warpgate-manager SKILL.md:74-78
- 目标列表已录入：hk_sji, volc_guangzhou, ali, hk-tmp, hk-toy — warpgate-client SKILL.md:28-34
- upstream 项目：warp-tech/warpgate v0.25.5, Rust + Svelte, Apache 2.0

## Decisions (with rationale)
| # | Decision | Rationale |
|---|----------|-----------|
| D1 | MCP Server 部署在堡垒机本机 | 直接访问 Warpgate SQLite DB / 直接 SSH 到目标 / 零网络开销 |
| D2 | TypeScript + @modelcontextprotocol/sdk | MCP SDK 生态最成熟，ssh2/better-sqlite3 包均可用 |
| D3 | 服务器列表从 Warpgate DB 读取 | 单数据源，无同步问题，DB 中有 targets 表 |
| D4 | 工具数量合并到 ~13 个 | 减少 LLM 选择负担，降低维护成本 |
| D5 | 直接 SSH 到目标（绕过 Warpgate SSH 协议层） | MCP Server 在堡垒机上时效率更高；审计日志 MCP 自己维护 |
| D6 | 审计日志与 Warpgate 录制数据共同暴露 | MCP 审计日志记录 MCP 操作，Warpgate 录制数据供查询历史 SSH 会话 |
| D7 | 监控数据存独立 metrics.db | 与 Warpgate 业务数据分离，时序查询更高效 |
| D8 | HTTP/SSE 传输模式 | 远程服务器 MCP 需要供本地 OpenCode/Claude Desktop 连接 |
| D9 | Bearer Token 鉴权（L0） | 防止未授权调用，config 自动生成 UUID token |
| D10 | readOnly 标注预埋（L1 地基） | 工具 description 标注 [READONLY]/[WRITE]，为未来细粒度权限做准备 |
| D11 | Pino 运行时日志系统 | 按级别分文件输出 error.log / combined.log，支持 debug 模式 |
| D12 | PM2 进程管理 + 开机自启 | ecosystem.config.cjs 提交到 repo，pm2 save + pm2 startup 实现自愈 |
| D13 | autossh 隧道自动重连 | 客户端侧用 autossh 替代原生 ssh 建隧道，ServerAliveInterval 30s 保活 |
| D14 | 文件级并发锁 (edit_file only) | Map<string, Promise> 链锁防止同文件并发编辑覆盖 |
| D15 | MCP 自监控 | 启动日志 + 全局调用计数器 + deps_check 暴露自身健康状态 |
| D16 | 密钥/配置安全防护 | config.json chmod 600、SSH key 权限检查、gitignore 排除 config |

## Scope IN
1. MCP Server 核心框架搭建（TypeScript, @modelcontextprotocol/sdk, HTTP/SSE）
2. 服务器发现 — 从 Warpgate SQLite DB 读取 targets 表
3. 命令执行 — ssh2 直连目标，执行命令/脚本
4. 文件传输 — sftp 上传/下载/查看/编辑（编辑带 .bak 备份）
5. 性能监控 — agentless SSH 采集（CPU/内存/磁盘/网络）+ 历史时序存储
6. 审计日志 — 所有操作记录 + 风险分级 + 搜索
7. 健康检查 — 批量检查目标连通性
8. 系统管理 — 依赖检查、配置管理
9. Bearer Token 鉴权 — 所有 HTTP 端点受 token 保护

## Scope OUT (Must NOT have)
- ❌ 不维护独立的服务器配置文件（一切从 Warpgate DB 读取）
- ❌ 不要交互式 TTY Session（只做 exec 模式命令执行）
- ❌ 不实现 Web UI（MCP 是工具接口，不是 Web 应用）
- ❌ 不实现告警推送（只提供阈值规则定义和查询，推送由外部系统处理）
- ❌ 不修改 Warpgate 自身数据库（只读 targets 表，不写）

## Open questions
（无需再问用户，所有关键决策已确认）

## Approval gate
status: approved
<!-- 用户已确认 plan。等待 $start-work 开始执行。 -->
