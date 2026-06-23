# warpgate-mcp - Work Plan

## TL;DR (For humans)

**What you'll get:** 一个 TypeScript MCP 服务器，部署在 Warpgate 堡垒机上，让你可以通过 AI 助手直接列出服务器、执行命令、传输文件、查看性能指标和搜索审计日志 — 全部通过标准 MCP 工具接口完成。

**Why this approach:** MCP 部署在堡垒机本机，直接读 Warpgate 的 SQLite 数据库获取服务器列表（单数据源，零同步问题），也直接 SSH 到目标服务器（无需二次跳转）。相比维护独立服务器配置文件的方案，这消除了数据不一致的根本来源。

**What it will NOT do:** 不维护独立的服务器配置文件、不支持交互式 TTY 会话、不提供 Web UI、不修改 Warpgate 自身的数据库（只读 targets 表）、不做用户级 RBAC（只有全局 Bearer Token 鉴权）。

**Effort:** Large
**Risk:** Medium — Warpgate DB schema 可能随上游版本变化，MCP 部署在公网服务器需注意安全。
**Decisions to sanity-check:** SSH key 路径、metrics.db 位置、HTTP/SSE 端口绑定、Bearer Token 值。

Your next move: approve and start execution via `$start-work`.

---

> TL;DR (machine): Large effort, Medium risk, 14 MCP tools in TypeScript deployed on Warpgate bastion, reading Warpgate SQLite DB for discovery, ssh2 for execution/SFTP, better-sqlite3 for metrics/audit storage.

## Scope
### Must have
- TypeScript MCP 服务器，使用 @modelcontextprotocol/sdk
- HTTP/SSE 传输模式，绑定 127.0.0.1:3100（通过 SSH 隧道暴露给本地）
- 从 Warpgate SQLite DB 读取服务器列表（/opt/warpgate/data/db/db.sqlite3）
- ssh2 直连目标服务器执行命令/SFTP 文件传输
- 14 个 MCP 工具（见 Todos）
- metrics.db 存储监控时序数据和审计日志
- 编辑文件自动 .bak 备份 + diff 审计
- audit_log 记录所有 MCP 操作，带风险分级引擎
- Bearer Token 鉴权保护所有端点（Express 中间件）
- 工具声明 readOnly 元信息，为未来工具级权限打地基
- Pino 运行时日志系统（按级别分文件输出，可配置日志级别）
- PM2 进程管理 + 开机自启（ecosystem.config.cjs + pm2 save/startup）
- DB schema 启动校验（检测预期表是否存在）
- MCP 自监控（全局调用计数器 + 启动日志 + deps_check 暴露自身健康）
- 密钥/配置文件权限检查（config.json chmod 600 + SSH key 权限告警）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- ❌ 不维护独立 YAML/JSON 服务器配置文件（一切从 Warpgate DB 读取）
- ❌ 不做交互式 TTY Session（只 exec 模式）
- ❌ 不做 Web UI
- ❌ 不写 Warpgate DB（只读 targets/roles 表）
- ❌ 不使用 Warpgate SSH 协议层（MCP 在堡垒机上，直接用 SSH 连目标）
- ❌ 不实现外部告警推送（只定义规则，推送由外部系统处理）
- ❌ 不在单个文件中塞超过 250 行代码 — 逻辑聚集到独立模块
- ❌ 不使用 `any` 类型 — 所有 SSH/DB 返回值必须 typed
- ❌ 不做用户级 RBAC / 多用户认证（当前版本只有全局 Bearer Token）
- ❌ Bearer Token 不通过 HTTP 请求体传输（只接受 Authorization header）
- ❌ 工具 handler 不自行实现鉴权（统一在 Express 中间件层处理）

## Verification strategy
> Zero human intervention — all verification is agent-executed.
- Test decision: tests-after, using `vitest`（统一框架，Task 14 也用 vitest）
- Evidence: .omo/evidence/task-<N>-warpgate-mcp.{ts,json,log}

## Execution strategy
### Parallel execution waves
- **Wave 1 (Foundation):** Task 1-4 — 项目骨架、基础设施（可并行）
- **Wave 2 (Core Tools):** Task 5-7 — 发现/执行/文件工具
- **Wave 3 (Monitoring):** Task 8-9 — 监控存储 + 工具
- **Wave 4 (Audit + System):** Task 10-11 — 审计/系统工具
- **Wave 5 (Integration):** Task 12-14 — MCP 入口 + Auth + 部署验证

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. 项目骨架 | — | 2-4 | — |
| 2. types + config | 1 | 5-11 | 3, 4 |
| 3. Warpgate DB 连接器 | 1 | 5 | 2, 4 |
| 4. SSH/SFTP 执行器 | 1 | 5-7 | 2, 3 |
| 5. 发现工具 | 3, 4 | 12 | — |
| 6. 执行工具 | 4 | 12 | 5, 7 |
| 7. 文件工具 | 4 | 12 | 5, 6 |
| 8. Metrics DB schema | 2 | 9, 10 | — |
| 9. 监控工具 | 8 | 12 | 10 |
| 10. 审计工具 | 8 | 12 | 9 |
| 11. 系统工具 | 2, 4 | 12 | 9, 10 |
| 12. MCP 入口 + Auth | 5-11 | 13, 14 | — |
| 13. 部署 + 测试 | 12 | — | 14 |
| 14. Auth 集成测试 | 12 | — | 13 |

## Todos
> Implementation + Test = ONE todo. Never separate.

### Wave 1: Foundation

- [x] 1. 项目骨架搭建
  What to do / Must NOT do:
  - 在 `D:\WorkSpace\projects\Warpgate-MCP\` 下创建完整 Node.js TypeScript 项目
  - 产出文件:
    - `package.json`, `tsconfig.json`, `.gitignore`
    - **`ecosystem.config.cjs`** — PM2 进程管理配置
  - **ecosystem.config.cjs 配置:**
    ```js
    module.exports = {
      apps: [{
        name: 'warpgate-mcp',
        script: 'node',
        args: 'dist/index.js',
        cwd: __dirname,
        max_restarts: 10,
        min_uptime: 5000,
        restart_delay: 3000,
        max_memory_restart: '200M',
        env: {
          NODE_ENV: 'production',
        },
        error_file: '~/.warpgate-mcp/logs/pm2-error.log',
        out_file: '~/.warpgate-mcp/logs/pm2-out.log',
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      }]
    };
    ```
  - package.json: name "warpgate-mcp", type "module", ESM
  - **package.json scripts:**
    - `"build": "tsc"` — 编译 TypeScript 到 dist/
    - `"start": "node dist/index.js"` — 生产启动
    - `"dev": "tsx src/index.ts"` — 开发调试
  - 生产依赖: @modelcontextprotocol/sdk, ssh2, better-sqlite3, zod, express, pino
  - 开发依赖: typescript, @types/node, @types/ssh2, @types/better-sqlite3, @types/express, tsx, vitest, supertest, @types/supertest
  - tsconfig.json: target ES2022, module NodeNext, strict true, outDir dist, rootDir src
  - .gitignore: node_modules, dist, *.db, config.json, .env
  - 验证: `npm install` 成功，`npx tsc --noEmit` 通过
  - **`src/locks.ts`: 文件级并发锁（队列锁模式）**
    - `withEditLock(remotePath: string, fn: () => Promise<void>): Promise<void>`
    - 实现: `Map<string, Promise<void>>` 存每个 remotePath 的队列尾 Promise
    - 新操作先 `await` 当前队列尾，然后把自己的 Promise 设为新队尾
    - 即使某个操作 reject 也要 `.catch(() => {})` 让队列继续走，防止死锁
    - 不同 remotePath 的 edit 完全并行，不相互阻塞
  - Must NOT: 不要安装不必要的依赖（如 express 仅用于 SSE 传输头设置）
  
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2, 3, 4
  References: @modelcontextprotocol/sdk docs, ssh2 npm, better-sqlite3 npm
  Acceptance criteria: `npm install` 无报错，`npx tsc --noEmit` 通过，`ls node_modules/.package-lock.json` 存在
  QA scenarios:
  - Happy: 执行 `npm install && npx tsc --noEmit` → exit 0
  - Failure: 删除 package.json 一个依赖 → `npx tsc --noEmit` 应报模块未找到
  Commit: Y | chore(warpgate-mcp): scaffold typescript project

- [x] 2. 公共类型 + 配置模块
  What to do / Must NOT do:
  - `src/types.ts`: 定义 TargetInfo, ExecResult, FileResult, StatsSnapshot, AuditEntry, AlertRule, TargetStatus（online/offline/unknown）等类型
  - 所有类型使用 `zod` schema 定义（MCP 工具 inputSchema 需要）
  - `src/config.ts`: Config 接口 + loadConfig() 函数
    - 默认 config 路径: `~/.warpgate-mcp/config.json`
    - 配置项: warpgateDbPath（默认 /opt/warpgate/data/db/db.sqlite3）, sshKeyPath（默认 ~/.ssh/id_ed25519_warpgate）, sshStrictHostKeyChecking（默认 true）, metricsDbPath（默认 ~/.warpgate-mcp/metrics.db）, listenPort（默认 3100）, listenHost（默认 127.0.0.1）, **authToken（默认为自动生成的 UUID，可通过 env WPG_AUTH_TOKEN 覆盖）**, **logLevel（默认 "info"，可选 "debug"/"info"/"warn"/"error"）**, **logDir（默认 ~/.warpgate-mcp/logs）**
    - 支持环境变量覆盖: WPG_DB_PATH, WPG_SSH_KEY, WPG_METRICS_DB, WPG_PORT, WPG_HOST, **WPG_AUTH_TOKEN**, **WPG_LOG_LEVEL**, **WPG_LOG_DIR**, **WPG_SSH_STRICT_HOST_KEY**
    - 若配置文件不存在，自动生成 UUID token + 写入默认配置，**同时 `chmod 600 config.json`**
    - 启动时检查 SSH key 文件权限：若不是 600 或 400，logger.warn(`SSH key ${keyPath} has loose permissions: ${mode}`)
    - **config get 时 authToken 显示为 `warpgate-mcp-****`（只露后 4 位）**
  - **`src/logger.ts`: Pino 日志模块**
    - `createLogger(config: Config): Logger`
    - 输出文件: `{logDir}/error.log`（ERROR 及以上）, `{logDir}/combined.log`（INFO 及以上）
    - 开发模式时同时输出到 stdout（pino-pretty 可选，不强制）
    - 日志级别由 config.logLevel 控制
    - 日志格式: `[timestamp] [level] [module] message` — module 字段用于标记哪个模块（ssh, db, auth, exec 等）
    - 导出全局 `logger` 实例（在 index.ts 初始化后注入各模块）
    - Must NOT: 不要记录 SSH 密码或 token 原文
  - Must NOT: 不要硬编码任何路径，不要在 types.ts 中做 I/O
  
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5, 8, 11 | Can parallelize with: 3, 4
  References: zod docs, Node.js fs module, process.env
  Acceptance criteria: `npx tsx -e "import { loadConfig } from './src/config.js'; console.log(JSON.stringify(loadConfig()))"` 输出默认配置 JSON
  QA scenarios:
  - Happy: 无 config 文件 → 返回默认配置
  - Happy: 设置 WPG_PORT=8888 → loadConfig().listenPort === 8888
  - Failure: config.json 格式错误 → 抛出可读错误描述
  Commit: Y | feat(warpgate-mcp): add types and config module

- [x] 3. Warpgate DB 连接器
  What to do / Must NOT do:
  - `src/db.ts`: 只读 SQLite 连接
  - 函数:
    - `openWarpgateDb(dbPath: string): Database` — 打开只读连接
    - `listTargets(db): TargetInfo[]` — SELECT id, name, kind, options, description FROM targets
    - `getTargetByName(db, name): TargetInfo | null` — 按 name 查找
    - `listRoles(db): RoleInfo[]` — 可选，关联 target_roles 和 roles 表
  - Warpgate DB 结构参考 warpgate-manager SKILL.md:104-131
    - targets 表: id(TEXT UUID), name(TEXT), kind(TEXT "SSH"/"HTTP"/etc), options(TEXT JSON), description(TEXT)
    - options JSON 包含: host, port, username 等
  - 解析 options JSON 字段时使用 zod schema 做类型校验
  - **`validateSchema(db: Database): string[]`** — 检查 sqlite_master 中 EXPECTED_TABLES 是否存在，返回缺失表列表
    - EXPECTED_TABLES = ['targets', 'roles', 'target_roles']
    - 启动时调用，缺失则 logger.error + 工具调用返回友好提示
  - Must NOT: 绝不执行 INSERT/UPDATE/DELETE，绝不写 Warpgate DB
  
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5 | Can parallelize with: 2, 4
  References: better-sqlite3 docs, warpgate-manager SKILL.md:104-131, zod docs
  Acceptance criteria: **开发环境用内存 mock DB 测试** — `npx tsx -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.exec('CREATE TABLE targets (id TEXT, name TEXT, kind TEXT, options TEXT, description TEXT)'); db.prepare(\"INSERT INTO targets VALUES('x','test','SSH','{\\\"host\\\":\\\"x\\\",\\\"port\\\":22}','')\").run(); import { listTargets } from './src/db.js'; console.log(listTargets(db).length)"` 输出 1`
  QA scenarios:
  - Happy: 连接真实 DB → 返回目标列表
  - Failure: DB 路径不存在 → 抛出 FileNotFound 错误
  - Failure: DB 中 targets 表为空 → 返回空数组
  Commit: Y | feat(warpgate-mcp): add warpgate db connector

- [x] 4. SSH/SFTP 执行器
  What to do / Must NOT do:
  - `src/ssh.ts`: 封装 ssh2 的 Client + SFTP
  - 函数:
    - `exec(target: TargetInfo, command: string, timeout?: number): Promise<ExecResult>` — 执行单条命令，返回 { stdout, stderr, exitCode }
      - 使用 ssh2 Client.on('ready') 模式
      - 超时机制（默认 30s）
      - 自动用 SSH key 认证（配置的 keyPath）
    - `execScript(target: TargetInfo, script: string): Promise<ExecResult>` — 用 heredoc 方式执行多行脚本
    - `uploadFile(target: TargetInfo, localPath: string, remotePath: string): Promise<void>` — SFTP fastPut
    - `downloadFile(target: TargetInfo, remotePath: string, localPath?: string): Promise<string>` — 返回文件内容或保存路径
    - `readFile(target: TargetInfo, remotePath: string): Promise<string>` — SFTP 读取并返回文本内容
    - `editFile(target: TargetInfo, remotePath: string, oldText: string, newText: string): Promise<{ backupPath: string, diff: string }>` — 读文件→备份(.bak)→替换→验证
  - 所有函数超时 30s，可配置
  - SSH 连接选项: host, port, username, privateKey（从文件读），readyTimeout 10000
  - **Host key 校验:**
    - 默认启用 `sshStrictHostKeyChecking: true`（安全）
    - 使用 ssh2 的 `hostVerifier` 回调，校验目标 host key
    - 如果配置中 `sshStrictHostKeyChecking: false`，则 `hostVerifier: () => true`（相当于 `-o StrictHostKeyChecking=no`）
    - 部署文档提示用户：建议先手动 SSH 到所有目标一次录入 host key
  - Must NOT: 不要在函数内部 console.log 敏感信息（IP/端口），不要缓存 SSH 连接（每次执行创建新连接）
  
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5, 6, 7 | Can parallelize with: 2, 3
  References: ssh2 npm (Client, SFTP), node:fs, node:path
  Acceptance criteria: `npx tsx -e "import { exec } from './src/ssh.js'; exec({host:'45.207.222.63',port:37722,username:'root'} as any, 'echo hello').then(r => console.log(r.stdout))"` 返回 "hello\n"
  QA scenarios:
  - Happy: exec('echo hello') → stdout="hello\n", exitCode=0
  - Happy: editFile 后 → 原文件存在 .bak，diff 正确
  - Failure: exec 目标不可达 → 抛出 ConnectionError（非超时）
  - Failure: exec 超时 → 抛出 TimeoutError
  - Failure: downloadFile 文件不存在 → 抛出 FileNotFoundError
  Commit: Y | feat(warpgate-mcp): add ssh/sftp executor

### Wave 2: Core Tools

- [x] 5. 发现工具 (list_targets, health_check)
  What to do / Must NOT do:
  - `src/tools/discovery.ts`: 导出两个工具定义
  - `warpgate_list_targets`:
    - inputSchema: { includeOffline?: boolean, kind?: "SSH" | "HTTP" | "MySQL" | "Postgres" }
    - 从 DB 读 targets 列表
    - 返回: name, kind, host, port, description, status（从上次健康检查缓存读取）
    - readOnlyHint: true
  - `warpgate_health_check`:
    - inputSchema: { targetNames?: string[]（不传则检查全部）}
    - 循环或并行执行 `echo ok`（最大并发 5）
    - 记录延迟 ms 和状态
    - results 写入 metrics.db 的 health_cache 表（由 Task 8 创建 schema，Task 12 initMetricsDb() 时建表）
    - readOnlyHint: true
  - Must NOT: 不要将 SSH 连接错误暴露为工具错误（返回 status: "offline" + error 消息）
  
  Parallelization: Wave 2 | Blocked by: 3, 4 | Blocks: 12 | Can parallelize with: 6, 7
  References: db.ts, ssh.ts, metrics-db.ts（由 Task 8 合并处理）, MCP SDK Server.setToolHandler
  Acceptance criteria: 通过 MCP SDK 注册工具，调用后返回结构化列表
  QA scenarios:
  - Happy: list_targets 返回 ≥3 个服务器
  - Happy: health_check 对已知在线服务器返回 status="online"
  - Failure: DB 不可读 → 返回空列表 + 警告消息（不抛异常）
  Commit: Y | feat(warpgate-mcp): add discovery tools

- [x] 6. 执行工具 (exec)
  What to do / Must NOT do:
  - `src/tools/exec.ts`: 导出 exec 工具
  - `warpgate_exec`:
    - inputSchema: { target: string, command: string, isScript?: boolean, timeout?: number }
    - 调用 ssh.exec 或 ssh.execScript（根据 isScript）
    - 自动记录审计日志到 metrics.db（audit_log 表）
    - 返回: { stdout, stderr, exitCode, duration }
    - destructiveHint: true（但标注 script=false 时风险较低）
  - 命令黑白名单:
    - 默认禁止: rm -rf /, dd if=, :(){ :|:& };:, 任何可能造成破坏的 shell 注入
    - 在工具 handler 中做字符串检测，命中则拒绝执行并返回错误
  - Must NOT: 不做交互式 Session，不做 tmux 模式
  
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 12 | Can parallelize with: 5, 7
  References: ssh.ts, metrics-db.ts（audit_log 表由 Task 8 实现）, MCP SDK CallToolRequestSchema
  Acceptance criteria: `warpgate_exec(target="volc_guangzhou", command="uname -a")` 返回 Linux 版本信息
  QA scenarios:
  - Happy: 执行 `echo hello` → exitCode=0, stdout="hello"
  - Happy: 执行多行脚本（isScript=true）→ 所有命令成功
  - Failure: 命中黑名单命令 → 返回安全拒绝错误
  - Failure: 目标 offline → 返回离线错误
  - Failure: 超时 → 返回 TimeoutError
  Commit: Y | feat(warpgate-mcp): add exec tool

- [x] 7. 文件工具 (upload, download, read_file, edit_file)
  What to do / Must NOT do:
  - `src/tools/file.ts`: 导出 4 个文件工具
  - `warpgate_upload`:
    - inputSchema: { target: string, localPath: string, remotePath: string }
    - 调用 ssh.uploadFile
    - destructiveHint: true
  - `warpgate_download`:
    - inputSchema: { target: string, remotePath: string, saveTo?: string }
    - 调用 ssh.downloadFile
    - 若无 saveTo，返回文件内容（自动限制 1MB，超则提示用 saveTo）
    - readOnlyHint: true
  - `warpgate_read_file`:
    - inputSchema: { target: string, path: string, maxLines?: number, offset?: number }
    - 用 ssh.exec 执行 `head -n $maxLines $path | tail -n +$offset`（或类似）
    - 返回文件内容行
    - readOnlyHint: true
  - `warpgate_edit_file`:
    - inputSchema: { target: string, path: string, oldText: string, newText: string }
    - 调用 ssh.editFile，**外层包裹 `withEditLock(remotePath, ...)`** 防止同文件并发
    - 自动 .bak 备份，记录 diff 到审计日志
    - destructiveHint: true
  - Must NOT: upload 支持大文件分片（当前只做普通 SFTP，文件 < 100MB），edit_file 不支持二进制文件
  
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 12 | Can parallelize with: 5, 6
  References: ssh.ts, metrics-db.ts（审计日志）
  Acceptance criteria: 上传一个临时文件到服务器，下载回本地，内容一致
  QA scenarios:
  - Happy: upload → download → 内容一致
  - Happy: read_file → 返回文件前 N 行
  - Happy: edit_file → 文件内容变更，.bak 存在，diff 可读
  - Failure: download 文件 > 1MB 且无 saveTo → 提示用 saveTo
  - Failure: edit_file oldText 不匹配 → 返回错误 + 当前文件内容
  Commit: Y | feat(warpgate-mcp): add file tools

### Wave 3: Monitoring

- [x] 8. Metrics DB schema + 监控存储
  What to do / Must NOT do:
  - `src/metrics-db.ts`: 管理独立的 metrics.db
  - 表结构（用 better-sqlite3 在 init 时 CREATE TABLE IF NOT EXISTS）:
    - `metrics_snapshots`: id INTEGER PK, target_name TEXT, collected_at DATETIME, cpu_percent REAL, mem_total_gb REAL, mem_used_gb REAL, mem_percent REAL, disk_total_gb REAL, disk_used_gb REAL, disk_percent REAL, net_rx_bytes INTEGER, net_tx_bytes INTEGER, load_1m REAL, load_5m REAL, load_15m REAL, uptime_seconds INTEGER
    - `audit_log`: id TEXT(UUID) PK, timestamp DATETIME, tool TEXT, target TEXT, command TEXT, params TEXT(JSON), exit_code INTEGER, duration_ms INTEGER, risk_level TEXT(low/medium/high/critical), diff TEXT, status TEXT(success/failure/blocked)
    - `alert_rules`: id TEXT(UUID) PK, name TEXT, target_name TEXT, metric TEXT, operator TEXT, threshold REAL, enabled INTEGER, created_at DATETIME, notify_method TEXT
    - `health_cache`: target_name TEXT PK, status TEXT, latency_ms REAL, checked_at DATETIME
  - 函数: initMetricsDb(path), insertSnapshot(), insertAuditLog(), insert/update/deleteAlertRule(), querySnapshots(), queryAuditLogs(), updateHealthCache(), getHealthCache()
  - Must NOT: 把 metrics.db 放在 Warpgate 数据目录里（放 ~/.warpgate-mcp/）
  
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 9, 10
  References: better-sqlite3 docs, SQLite CREATE TABLE syntax
  Acceptance criteria: `initMetricsDb(':memory:')` 成功创建所有表
  QA scenarios:
  - Happy: 创建表后 INSERT 一条数据 → SELECT 返回相同数据
  - Happy: 重复 init → 不报错（IF NOT EXISTS）
  - Failure: 路径不可写 → 抛出可读错误
  Commit: Y | feat(warpgate-mcp): add metrics db schema

- [x] 9. 监控工具 (stats, stats_history, stats_alert)
  What to do / Must NOT do:
  - `src/tools/monitor.ts`: 导出 3 个监控工具
  - `warpgate_stats`:
    - inputSchema: { target: string }
    - 通过 SSH 执行采集命令集:
      - CPU: `top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'`
      - 内存: `free -g | awk 'NR==2{printf "%.1f %.1f %.1f", $2,$3,$3/$2*100}'`
      - 磁盘: `df -h / | awk 'NR==2{printf "%.0f %.0f %.0f", $2,$3,$5}'`
      - 网络: `cat /proc/net/dev | grep eth0 | awk '{print $2,$10}'`
      - 负载: `cat /proc/loadavg | awk '{print $1,$2,$3}'`
      - 运行时间: `cat /proc/uptime | awk '{print $1}'`
    - 解析输出，存入 metrics_snapshots 表
    - readOnlyHint: true
  - `warpgate_stats_history`:
    - inputSchema: { target: string, metric: string, from?: string(ISO), to?: string(ISO), limit?: number }
    - 查询 metrics_snapshots 表，返回时序数据
    - readOnlyHint: true
  - `warpgate_stats_alert`:
    - inputSchema: { action: "list"|"create"|"delete"|"update", name?, target?, metric?, operator?, threshold?, id? }
    - CRUD alert_rules 表
    - destructiveHint: true（create/update/delete 时）
  - Must NOT: 采集命令不用 sar/iotop 等需额外安装的工具（只用标准 Linux 命令）
  
  Parallelization: Wave 3 | Blocked by: 4, 8 | Blocks: 12 | Can parallelize with: 10
  References: metrics-db.ts, ssh.ts, /proc filesystem docs
  Acceptance criteria: `warpgate_stats(target="volc_guangzhou")` 返回完整性能数据
  QA scenarios:
  - Happy: stats 返回所有指标（CPU/内存/磁盘/网络/负载）
  - Happy: stats_history 返回指定时间段数据
  - Happy: alert create → list → delete 完整 CRUD
  - Failure: stats 目标离线 → 返回离线错误，不写脏数据
  - Failure: stats_history 无数据 → 返回空数组
  Commit: Y | feat(warpgate-mcp): add monitoring tools

### Wave 4: Audit + System

- [x] 10. 审计工具 (audit_search, audit_session)
  What to do / Must NOT do:
  - `src/tools/audit-query.ts`: 导出审计查询工具
  - `warpgate_audit_search`:
    - inputSchema: { tool?: string, target?: string, riskLevel?: string, from?: string, to?: string, command?: string, limit?: number(默认50) }
    - 查询 audit_log 表，支持组合过滤
    - readOnlyHint: true
  - `warpgate_audit_session`:
    - inputSchema: { sessionId: string }
    - 返回某条审计日志的完整详情（含 diff 字段）
    - readOnlyHint: true
  - 风险分级引擎（在审计日志写入时执行）:
    - `riskLevel(command: string): "low"|"medium"|"high"|"critical"`
    - 检测逻辑:
      - critical: rm -rf, dd, :(){}, 格式化, 删除系统目录
      - high: 重启服务, chmod -R 777, 修改 /etc, kill -9, 安装/卸载软件
      - medium: 修改配置文件, 重启, 用户管理
      - low: 查看文件, 读取日志, ps/top/df 等只读命令
    - 写入审计日志时自动计算 risk_level
  - Must NOT: audit_session 不提供 real-time 会话查看（那是 Warpgate Web UI 的事）
  
  Parallelization: Wave 4 | Blocked by: 8 | Blocks: 12 | Can parallelize with: 9
  References: metrics-db.ts（audit_log 表）
  Acceptance criteria: 写入一条审计日志后，audit_search 能查出来
  QA scenarios:
  - Happy: 搜索所有 critical 操作 → 返回列表
  - Happy: 按 target + time range 过滤 → 返回精确结果
  - Happiness: riskLevel("rm -rf /") → "critical"
  - Failure: sessionId 不存在 → 返回 null
  Commit: Y | feat(warpgate-mcp): add audit tools

- [x] 11. 系统工具 (deps_check, config)
  What to do / Must NOT do:
  - `src/tools/system.ts`: 导出 2 个系统工具
  - `warpgate_deps_check`:
    - inputSchema: {}（无参数）
    - 检查项:
      - Warpgate DB 可读（尝试打开 db.sqlite3）
      - SSH key 存在且权限正确（检查 keyPath 文件存在 + 权限为 600 或 400）
      - config.json 权限正确（应为 600）
      - metrics.db 可写（尝试创建/打开）
      - 配置完整（校验 config 所有字段）
      - **MCP 自身健康（读取 stats.ts 的全局计数器）:**
        - version, uptime_seconds, memory_rss_mb, tools_called, failed_calls
        - 若 failed_calls / tools_called > 10% 且 tools_called > 20，标记 warning
    - 返回每项的状态 + 详细信息
    - readOnlyHint: true
  - `warpgate_config`:
    - inputSchema: { action: "get"|"set", key?: string, value?: string }
    - get: 返回当前配置（隐藏 SSH key 路径内容）
    - set: 更新配置（持久化到 config.json）
    - destructiveHint: true（set 时）
  - Must NOT: deps_check 不检查远程 Warpgate 版本号
  
  Parallelization: Wave 4 | Blocked by: 2, 4 | Blocks: 12 | Can parallelize with: 9, 10
  References: config.ts, db.ts, metrics-db.ts
  Acceptance criteria: `warpgate_deps_check()` 返回所有依赖检查结果
  QA scenarios:
  - Happy: 所有依赖就绪 → 全部 passed
  - Failure: DB 路径不存在 → 对应项 failed + 错误消息
  - Happy: config get → 返回配置 JSON
  - Happy: config set key=listenPort value=8888 → 持久化成功
  Commit: Y | feat(warpgate-mcp): add system tools

### Wave 5: Integration

- [x] 12. MCP 入口 (index.ts) — 工具注册 + HTTP/SSE 传输 + Bearer Token 鉴权
  What to do / Must NOT do:
  - `src/index.ts`: MCP 服务器入口
  - `src/auth.ts`: Bearer Token 鉴权中间件
  - **Auth 中间件实现（src/auth.ts）:**
    - `authMiddleware(config: Config): express.RequestHandler`
    - 对 POST /message 检查 `Authorization: Bearer <token>` header
    - 对 GET /sse **不检查 token**（因为 SSE 连接建立后 MCP 协议层有 `sessions/list` 等安全机制）
    - Token 不匹配返回 401 + JSON `{ error: "unauthorized" }`
    - 比较使用 `timingSafeEqual`（防时序攻击），没有就用 `===` 也行（token 是 UUID 足够安全）
    - `config.get` 显示 token 时 mask 为 `warpgate-mcp-****{last4}`
  - **工具 readOnly 元信息（src/tool-meta.ts）:**
    - 每个工具注册时附带 `readOnly: boolean` 属性（在 tool definition 的 `description` 中标注 `[READONLY]` 或 `[WRITE]` 前缀）
    - 为未来 L1 工具级权限预埋：handler 统一入口可通过 `if (!readOnly && !canWrite)` 拦截
  - **初始化流程（index.ts）:**
    1. loadConfig()
    2. createLogger(config) → export 全局 logger 实例
    3. **createStats()** — 初始化全局调用计数器（在注册 handler 之前）
       - `src/stats.ts`: 维护 `callsTotal`, `callsFailed`, `startTime` 三个全局变量 + getter 函数
       - 每个工具 handler 调用后 `callsTotal++`，失败时 `callsFailed++`
       - 供 `warpgate_deps_check` 查询
    4. **validateSchema()** — 打开 Warpgate DB 执行 schema 校验
       - 调用 `db.ts` 的 `validateSchema(openWarpgateDb(config.warpgateDbPath))`
       - 返回缺失表列表，若不为空则 `logger.error({ event: 'schema.missing', tables })` 
       - **不阻止启动** — 即使缺表也让 MCP 启动，工具调用时返回友好错误而非崩溃
    5. initMetricsDb()
    6. 创建 MCP Server 实例（name: "warpgate-mcp", version: "0.1.0"）
    7. 注册所有工具 handler（此时 stats 已就绪，handler 内可直接调用 stats.incCalls()）
    8. 创建 Express app:
       - `app.use(authMiddleware(config))` — 全局中间件
       - GET /sse → SSEServerTransport（走 401 白名单，跳过 token 检查）
       - POST /message → SSEServerTransport.handlePostMessage()
    9. 启动 HTTP server 监听 config.listenHost:config.listenPort
    10. **logger.info 启动日志:**
       ```typescript
       logger.info({
         event: 'server.start',
         version: '0.1.0',
         nodeVersion: process.version,
         memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
         uptime: 0
       });
       ```
    10. logger.info(`Warpgate MCP server listening on ${host}:${port}`)
  - 各模块通过 `import { logger } from './logger.js'` 使用
  - 工具 handler 中 logger.info({ tool, target, duration }) 记录每次调用性能
  - 工具 handler 路由表:
    | 工具名 | 模块 | 导入路径 |
    |--------|------|---------|
    | warpgate_list_targets | discovery | ./tools/discovery.js |
    | warpgate_health_check | discovery | ./tools/discovery.js |
    | warpgate_exec | exec | ./tools/exec.js |
    | warpgate_upload | file | ./tools/file.js |
    | warpgate_download | file | ./tools/file.js |
    | warpgate_read_file | file | ./tools/file.js |
    | warpgate_edit_file | file | ./tools/file.js |
    | warpgate_stats | monitor | ./tools/monitor.js |
    | warpgate_stats_history | monitor | ./tools/monitor.js |
    | warpgate_stats_alert | monitor | ./tools/monitor.js |
    | warpgate_audit_search | audit | ./tools/audit-query.js |
    | warpgate_audit_session | audit | ./tools/audit-query.js |
    | warpgate_deps_check | system | ./tools/system.js |
    | warpgate_config | system | ./tools/system.js |
  - 所有工具 handler 共享一个 auditLogger 实例，自动记录每次调用
  - 错误处理: handler 内 try-catch，返回 toolResult error 而非崩溃
  - Must NOT: 不在 index.ts 中包含任何业务逻辑（只做注册和路由），不引入 express 中间件路由以外的功能
  
  Parallelization: Wave 5 | Blocked by: 5, 6, 7, 9, 10, 11 | Blocks: 13
  References: MCP SDK Server, SSEServerTransport, express docs
  Acceptance criteria: `npx tsx src/index.ts` 启动成功，`curl http://127.0.0.1:3100/sse` 返回 SSE 连接
  QA scenarios:
  - Happy: 启动后 tools/list 返回 14 个工具
  - Happy: 调用 warpgate_list_targets → 返回服务器列表
  - Failure: 端口被占用 → 抛出 EADDRINUSE
  - Failure: DB 不可读 → 启动成功但工具调用时报错
  Commit: Y | feat(warpgate-mcp): add mcp server entry

- [x] 13. 部署验证 + 本地客户端配置
  What to do / Must NOT do:
  - 在堡垒机上部署:
    - git clone 或 scp 项目到堡垒机 `/opt/warpgate-mcp/`
    - `cd /opt/warpgate-mcp && npm install && npm run build && npm prune --production`
    - **PM2 启动:**
      ```bash
      pm2 start ecosystem.config.cjs
      pm2 save                           # 保存进程列表
      pm2 startup                         # 生成开机自启脚本（按提示执行）
      ```
    - 验证: `pm2 list` 显示 warpgate-mcp 状态 online, `curl http://127.0.0.1:3100/sse` 返回 SSE 连接
    - **日志轮转（可选但推荐）:**
      ```bash
      pm2 install pm2-logrotate
      pm2 set pm2-logrotate:max_size 10M
      pm2 set pm2-logrotate:retain 5
      pm2 set pm2-logrotate:compress true
      ```
    - 部署文档包含: git clone / npm install / pm2 start+save / pm2 startup 完整命令
  - 本地客户端配置（opencode.json）:
    ```json
    {
      "mcpServers": {
        "warpgate-mcp": {
          "transport": "http",
          "url": "http://127.0.0.1:3100/sse",
          "headers": {
            "Authorization": "Bearer <从堡垒机 ~/.warpgate-mcp/config.json 获取的 authToken>"
          }
        }
      }
    }
    ```
  - 建立 SSH 隧道（如果 MCP 在堡垒机上监听 127.0.0.1） — **使用 autossh 确保自动重连**:
    ```bash
    # 安装 autossh（一次）
    sudo apt install autossh   # Debian/Ubuntu
    # 或 winget install autossh  # Windows

    # 启动隧道（自动重连）
    autossh -M 0 \
      -o StrictHostKeyChecking=no \
      -i ~/.ssh/id_ed25519_warpgate \
      -p 2222 \
      -L 3100:127.0.0.1:3100 \
      -N \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      maxeagle@101.47.19.193
    ```
  - **自动启动隧道（Linux）:** 可以封装成 systemd user service 或写到 autossh 的 systemd 服务模板
  - 验证:
    - 本地 MCP 客户端能连接并通过 tools/list 获取工具列表
    - 执行一个健康检查: `warpgate_health_check`
    - 验证无 token 请求被 401 拒绝
  - Must NOT: 不要在生产环境使用 tsx 运行（应用 `npx tsc` 编译后的 dist/ 或直接用 tsx 做原型），不要把 token 提交到 git
  
  Parallelization: Wave 5 | Blocked by: 12 | Blocks: —
  References: SSH tunnel 命令（warpgate-client SKILL.md:50-52）, opencode.json MCP 配置
  Acceptance criteria: 本地 OpenCode/Claude Desktop 能发现并调用 warpgate_mcp 的所有工具
  QA scenarios:
  - Happy: 通过 SSH 隧道访问 3100 端口的 SSE 接口成功
  - Happy: 调用 warpgate_list_targets → 返回堡垒机真实服务器列表
  - Failure: 隧道断开 → 工具调用超时
  Commit: Y | docs(warpgate-mcp): add deployment and client configuration guide

- [x] 14. Auth 集成测试
  What to do / Must NOT do:
  - `src/__tests__/auth.test.ts`: 测试 auth middleware（使用 vitest + supertest）
  - 测试场景:
    1. 无 Authorization header → 返回 401
    2. Authorization: Bearer wrong-token → 返回 401
    3. Authorization: Bearer correct-token → 通过（next() called）
    4. GET /sse 不经 token 检查（白名单验证）
  - 用 `vitest` + `supertest` 直接构造请求测试
  - 只测试 auth 逻辑，不启动完整 MCP server
  - Must NOT: 不额外引入其他测试框架

  Parallelization: Wave 5 | Blocked by: 12 | Can parallelize with: 13
  References: auth.ts, config.ts, express docs, timingSafeEqual
  Acceptance criteria: `npx tsx src/__tests__/auth.test.ts` 全部测试通过
  QA scenarios:
  - Happy: token 正确 → 200
  - Failure: token 错误 → 401
  - Failure: 无 token → 401
  - Happy: GET /sse 无 token → 200（白名单）
  Commit: Y | test(warpgate-mcp): add auth middleware tests

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — 检查所有 14 个工具都实现且注册
- [x] F2. TypeScript 编译检查 — `npx tsc --noEmit` 无错误
- [x] F3. 真实环境 QA — 在堡垒机上启动 MCP 并通过 SSH 隧道调用工具
- [x] F4. 安全审查 — SSH key 未硬编码，黑名单生效，审计日志完整，Bearer Token 鉴权生效且 401 返回正确

## Commit strategy
1. chore: scaffold typescript project
2. feat: add types and config module
3. feat: add warpgate db connector
4. feat: add ssh/sftp executor
5. feat: add discovery tools
6. feat: add exec tool
7. feat: add file tools
8. feat: add metrics db schema
9. feat: add monitoring tools
10. feat: add audit tools
11. feat: add system tools
12. feat: add mcp server entry with bearer token auth
13. test: add auth middleware tests
14. docs: add deployment and client configuration guide

## Success criteria
- [ ] MCP 服务器在堡垒机上稳定运行（pm2 status online）
- [ ] 本地通过 SSH 隧道（autossh）+ opencode.json 配置可连接
- [ ] 14 个工具全部注册成功，能被 LLM 调用
- [ ] warpgate_list_targets 返回真实服务器列表
- [ ] warpgate_exec 在目标上成功执行命令并返回结果
- [ ] warpgate_upload/download 文件传输完整
- [ ] warpgate_edit_file 安全备份生效
- [ ] warpgate_stats 采集完整性能指标
- [ ] warpgate_audit_search 可检索所有操作记录
- [ ] 安全命令黑名单有效拦截危险操作
- [ ] 审计日志包含风险分级
- [ ] 无 token 或无正确 token 的请求被 401 拒绝（auth 白名单确认）
- [ ] GET /sse 不走 token 检查（白名单生效）
- [ ] 运行时日志按级别分文件写入 ~/.warpgate-mcp/logs/（error.log + combined.log）
- [ ] DB schema 校验：缺失预期表时打印清晰错误日志
- [ ] warpgate_deps_check 返回 MCP 自身健康信息（uptime / memory / calls / failures）
- [ ] config.json 自动设为 600 权限，SSH key 权限错误时抛出 warning 日志
