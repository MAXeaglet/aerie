# Aerie — Warpgate-MCP

## OVERVIEW
MCP 服务器（HTTP SSE 传输），通过 Warpgate 堡垒机的 SQLite 数据库管理 SSH 目标、执行远程命令、传输文件、采集性能指标。

**技术栈**: TypeScript (ES2022/NodeNext/ESM) + Express 5 + better-sqlite3 + ssh2 + Zod + Pino + Vitest

## STRUCTURE
```
src/
├── index.ts            # 入口：初始化 10 步 + MCP dispatch + Express/SSE
├── config.ts           # ~/.warpgate-mcp/config.json + WPG_* 环境变量
├── auth.ts             # Bearer token + 令牌桶限流 (60 req/min) + RBAC 审计
├── ssh.ts              # ssh2 executor (exec/execScript/SFTP upload/download/edit)
├── db.ts               # Warpgate DB 只读+可写双连接
├── metrics-db.ts       # 自有 SQLite：健康缓存/审计日志/告警规则
├── types.ts            # Zod schemas → 推断类型
├── tool-meta.ts        # 19 个工具的 readOnly/sensitive/category 元信息
├── logger.ts           # Pino 双目标 (combined.log + error.log)
├── stats.ts            # 全局调用计数器
├── locks.ts            # 文件级队列锁 (remotePath-keyed)
└── tools/
    ├── discovery.ts    # warpgate_list_targets / warpgate_health_check
    ├── exec.ts         # warpgate_exec (42 条黑名单正则)
    ├── file.ts         # warpgate_upload / _download / _read_file / _edit_file
    ├── monitor.ts      # warpgate_stats / _alert_list / _create / _delete
    ├── audit-query.ts  # warpgate_audit_query / _audit_stats
    ├── system.ts       # warpgate_deps_check / _config_get / _config_set
    └── target-mgmt.ts  # warpgate_add / _edit / _remove / _get_target
```

## WHERE TO LOOK
| Task | File | Note |
|------|------|------|
| 工具路由/注册 | `src/index.ts` | switch/case + ListTools |
| 配置字段 | `src/config.ts` | Config interface + DEFAULTS |
| 工具白名单 | `src/tool-meta.ts` | TOOL_META array |
| 命令黑名单 | `src/tools/exec.ts` | DANGEROUS_PATTERNS + riskLevel |
| 路径安全 | `src/ssh.ts` | safeRemotePath + allowedDirs |
| 部署配置 | `ecosystem.config.cjs` | PM2 |

## CODE MAP
| Symbol | Type | File | Role |
|--------|------|------|------|
| `Config` | interface | `config.ts` | 全部配置字段定义 |
| `loadConfig` | fn | `config.ts` | 加载 JSON + 环境变量 → Config |
| `authMiddleware` | fn | `auth.ts` | Express Bearer token 校验 |
| `createRateLimiter` | fn | `auth.ts` | 令牌桶 (60 req/min) |
| `isSensitiveTool` | fn | `auth.ts` | 敏感工具标记检查 |
| `safeRemotePath` | fn | `ssh.ts` | 路径遍历防御 |
| `exec` | fn | `ssh.ts` | 单条 SSH 命令 |
| `execScript` | fn | `ssh.ts` | heredoc 多行脚本 |
| `openWarpgateDb` | fn | `db.ts` | 只读 DB 连接 |
| `openWarpgateDbWritable` | fn | `db.ts` | 可写 DB 连接 |
| `TOOL_META` | const | `tool-meta.ts` | 19 工具元信息数组 |
| `execTool` / `handleExec` | const / fn | `tools/exec.ts` | 命令执行 + 黑名单 |
| `addTargetTool` / `handleAddTarget` | const / fn | `tools/target-mgmt.ts` | 目标 CRUD |
| `isValidHost` | fn | `tools/target-mgmt.ts` | IPv4/domain/localhost 校验 |
| `configSetTool` / `handleConfigSet` | const / fn | `tools/system.ts` | 白名单键修改 |

## CONVENTIONS (项目特有)
- 文件名: `kebab-case` (`.ts`, 无 `.js` 后缀)
- 本地 import 带 `.js` 后缀 (`from './config.js'`)
- 工具名称: `warpgate_{verb}_{noun}`
- 环境变量: `WPG_*` 前缀
- 错误返回: `{ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }`
- 测试邻近模式: `auth.ts` ↔ `auth.test.ts`
- DB 参数: handler 通过 index.ts 依赖注入，不直接 import

## ANTI-PATTERNS (禁止)
- `as any` — 项目有 40 处，应逐渐消除
- `@ts-ignore` / `@ts-expect-error` — 零容忍
- 工具 handler 直接 import db — 必须通过 index.ts 注入

## COMMANDS
```bash
npm run build           # tsc → dist/
npm run start           # node dist/index.js
npm run dev             # tsx src/index.ts (开发)
npx vitest run          # 运行 5 个测试文件
npx tsc --noEmit        # 类型检查
```

## NOTES
- 监听 `127.0.0.1:3100`（仅本地），需 SSH 隧道或 OpenResty 反代暴露公网
- 部署路径: `/opt/aerie/`，PM2 管理
- 配置文件: `~/.warpgate-mcp/config.json` (首次自动生成)
- PM2 日志 `~` 不展开 — 注意路径
- 包版本 `1.0.0` 但 server 版本 `0.1.0` — 未统一
