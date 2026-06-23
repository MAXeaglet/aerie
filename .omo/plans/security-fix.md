# security-fix - Work Plan

## TL;DR (For humans)

**What you'll get:** 修复 6 个安全漏洞：SSE 认证绕过、命令注入绕过、远程路径遍历、审计日志密码泄露、TOCTOU 竞争条件和缺失的运行时权限校验。

**Why this approach:** 4 个 Wave 独立修复不同文件（exec.ts / ssh.ts / target-mgmt.ts / auth.ts+index.ts），互不阻塞，全部可并行。高优漏洞优先，低优合并。

**What it will NOT do:** 不改 Warpgate 上游密码存储方案、不引入多 token 系统、不改 Express HTTP 层、不加新 npm 依赖。

**Effort:** Short
**Risk:** Low — 每个修复都是增量的附加检查，不改现有行为逻辑
**Decisions to sanity-check:** token 在消息层校验 vs HTTP 层、高危命令是否默认拦截

Your next move: approve, then `$start-work`. Full execution detail follows.

---

> TL;DR (machine): Effort: Short | Risk: Low — 4 个独立 Wave 修复 6 个安全漏洞，含认证、黑名单、路径遍历、日志泄露、TOCTOU、RBAC

## Scope
### Must have
- CallToolRequestSchema handler 中插入 token 校验（修复 C-01 认证绕过）
- 扩展 exec 命令黑名单 + high+ 级别实际拦截（修复 H-01 黑名单绕过）
- readFile/uploadFile/downloadFile/editFile 加路径规范化检查（修复 H-02 路径遍历）
- edit_target audit log 排除 auth_password（修复 M-01 日志泄露）
- add/edit_target 用 db.transaction() 包裹检查+写入（修复 L-01 TOCTOU）
- sensitive 标志运行时校验，敏感工具需要 admin token（修复 I-01 缺失 RBAC）
- 以上每个修复附带单元测试

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不修 Warpgate 上游密码存储方案（M-02 deferred）
- 不改 Express HTTP 层配置
- 不引入多 token/用户系统
- 不改 MCP SDK
- 不加新 npm 依赖
- 不改原有功能逻辑（只加安全检查，不改返回格式）
- 不改 config.ts 配置结构

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after — 先写表征测试锁定行为，再改代码
- Evidence: each todo produces unit test evidence

## Execution strategy
### Parallel execution waves
Wave 1 (4 tasks in parallel): Todo 1 / 2 / 3 / 4 — 4 个文件独立，互不阻塞
Wave 2 (0 tasks): 无需 Wave 2

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. exec.ts 黑名单强化 | — | — | 2,3,4 |
| 2. ssh.ts 路径安全检查 | — | — | 1,3,4 |
| 3. target-mgmt.ts TOCTOU+日志 | — | — | 1,2,4 |
| 4. auth.ts+index.ts 消息层认证+RBAC | — | — | 1,2,3 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. `src/tools/exec.ts` — 强化命令黑名单，高危命令实际拦截
  What to do / Must NOT do:
    - 在 `DANGEROUS_PATTERNS` 追加：
      - `/sudo\s+/` — sudo 提权命令
      - `/shred\s+/` — 安全删除
      - `/wget\s+|curl\s+-[a-z]*o\s+/i` — 远程下载
      - `/python3?\s+-c\s+['"]/` — Python 内联代码执行
      - `/find\s+\/\s+-exec/` — find exec 批量操作
      - `/chattr\s+/` — 修改文件不可变属性
      - `/systemctl\s+(stop|disable|mask)/` — 停止系统服务
    - 修改 `riskLevel` 判定逻辑：`high` 级别的命令**也拦截**（当前只记录不拦截）
      - `isDangerous()` 改为返回 `'blocked' | 'warned' | 'allowed'` 三级
      - 所有 `high` 和 `critical` 命令都返回 `isError: true`
    - 修改 handler 中拦截逻辑：不检查 `check.dangerous` 布尔值，改用分级
    - **创建 `src/tools/exec.test.ts`** 覆盖：普通命令通过、已知危险命令拦截、sudo/wget/find 等新模式拦截
    - Must NOT: 不修改命令执行逻辑本身、不改风险评级字符串
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/tools/exec.ts:6-22, src/tools/exec.ts:49-117
  Acceptance criteria: `npx tsc --noEmit` 通过 + `npx vitest run src/tools/exec.test.ts` 全部绿色
  QA scenarios: `npx vitest run src/tools/exec.test.ts` + Evidence output
  Commit: Y | fix(exec): strengthen command blacklist and block high-risk commands

- [x] 2. `src/ssh.ts` + `src/tools/file.ts` — 文件操作加路径安全检查
  What to do / Must NOT do:
    - ssh.ts 中所有 `remotePath` 参数加 normalize + 拒绝 `..` 穿透的辅助函数
    - 创建 `src/ssh.ts` 安全函数：
      ```typescript
      // 拒绝路径遍历
      function safeRemotePath(remotePath: string, label: string): string {
        const normalized = path.posix.resolve('/', remotePath).slice(1); // 去掉前导 /
        if (normalized.includes('..')) {
          throw new Error(`Path traversal denied: ${label} contains '..'`);
        }
        return normalized;
      }
      ```
    - 在 `readFile`(L260)、`uploadFile`(L198)、`downloadFile`(L222)、`editFile`(L292) 入口调用 `safeRemotePath`
    - 文件上传的 `localPath` 也做安全检查（只读取当前项目目录下的文件）
    - **创建 `src/ssh.test.ts`** 覆盖：正常路径通过、`..` 穿透被拒绝、绝对路径处理
    - Must NOT: 不修改远程服务器端的路径结构、不改文件名生成逻辑
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/ssh.ts:260-286, 198-216, 222-254, 292-360
  Acceptance criteria: `npx tsc --noEmit` 通过 + `npx vitest run src/ssh.test.ts` 全部绿色
  QA scenarios: `npx vitest run src/ssh.test.ts` + Evidence output
  Commit: Y | fix(ssh): add path traversal protection for file operations

- [x] 3. `src/tools/target-mgmt.ts` — TOCTOU 修复 + 审计日志密码泄露修复
  What to do / Must NOT do:
    - **TOCTOU 修复（L-01）**:
      - 在 `handleAddTarget` 中用 `warpgateWriteDb.transaction()` 包裹 name 检查 + INSERT
      - 在 `handleEditTarget` 中用 `warpgateWriteDb.transaction()` 包裹 name 检查 + UPDATE
    - **审计日志泄露修复（M-01）**:
      - `handleEditTarget` L206：`command: JSON.stringify(args).slice(0,200)` 改为显式构建排除 `auth_password`
      - 参考 `handleAddTarget` L88 的做法：`JSON.stringify({ host, port, username, auth_kind })`
    - 更新 `src/tools/target-mgmt.test.ts` 追加 TOCTOU 相关测试（并发 add 相同 name）
    - Must NOT: 不改 SQL 查询逻辑、不改返回格式、不改 inputSchema
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/tools/target-mgmt.ts:40-47+70-72, 140-149+196-198, 201-212
  Acceptance criteria: `npx tsc --noEmit` 通过 + `npx vitest run src/tools/target-mgmt.test.ts` 全部绿色
  QA scenarios: `npx vitest run src/tools/target-mgmt.test.ts` + Evidence output
  Commit: Y | fix(target-mgmt): wrap add/edit in transaction, sanitize audit log

- [x] 4. `src/auth.ts` + `src/index.ts` — CallToolRequestSchema 消息层认证 + sensitive 运行时检查
  What to do / Must NOT do:
    - **消息层认证（C-01）**:
      - `src/auth.ts` 追加 `validateMcpToken(token: string)` 导出函数
      - `src/index.ts` 中，在 `CallToolRequestSchema` handler 内识别 auth token（MCP 在初始化阶段通过 SSE URL 参数传 token，但当前无此机制）
      - 简化方案：在 `CallToolRequestSchema` handler 中检查 `request.params._meta?.authToken` 或检查 HTTP header（SSE 连接建立时携带）
      - 实际可行方案：在 `app.get('/sse')` 中从 query params 获取 token（`req.query.token`），存入 transport，然后在 CallTool handler 读取
      - 或者更简单的：在 `CallToolRequestSchema handler` 中拒绝所有未认证的调用（当前所有 SSE 连接已绕过 HTTP auth，相当于无认证）
      - **方案选择**：MCP 协议不支持在 JSON-RPC 消息中传 token。最简洁的做法是 `/sse` 端点要求 `?token=` query param，建立连接时校验并存储已验证状态
    - **sensitive 运行时检查（I-01）**:
      - `src/auth.ts` 新增 `isSensitiveTool(toolName: string): boolean` 函数（读取 TOOL_META）
      - `src/index.ts` 中 CallToolRequestSchema handler 中，如果工具标记为 sensitive 且未通过 admin 校验，返回错误
      - 定义一个固定 `adminToken`（与当前 `authToken` 相同），作为管理员 token
      - 添加 `TOOL_META` 的导入
    - **测试**：创建 `src/auth.test.ts` 追加测试用例覆盖 SSE token 校验、sensitive 工具拦截
    - Must NOT: 不改 Express 中间件、不改 MCP SDK、不加新依赖
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/auth.ts:1-32, src/index.ts:100-197, src/tool-meta.ts:1-34
  Acceptance criteria: `npx tsc --noEmit` 通过 + `npx vitest run src/auth.test.ts` 全部绿色
  QA scenarios: `npx vitest run src/auth.test.ts` + Evidence output
  Commit: Y | fix(auth): add message-level auth and sensitive tool runtime check

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
4 commits, one per todo, squashed into one on merge:
1. `fix(exec): strengthen command blacklist and block high-risk commands`
2. `fix(ssh): add path traversal protection for file operations`
3. `fix(target-mgmt): wrap add/edit in transaction, sanitize audit log`
4. `fix(auth): add message-level auth and sensitive tool runtime check`

## Success criteria
- SSE 连接需要 `?token=` 参数
- 高危命令（reboot/shutdown/apt install 等）被实际拦截
- 路径 `..` 穿透在所有 4 个文件操作中被拒绝
- edit_target 审计日志不包含密码
- add/edit_target 的 name 检查和写入在同一个事务中
- 标记 sensitive 的工具被非 admin token 调用时返回 403
- tsc 零错误，所有测试通过
