# warpgate-target-mgmt - Work Plan

## TL;DR (For humans)

**What you'll get:** 四个新的 MCP 工具，让你能通过 AI 客户端直接添加、编辑、删除和查询 Warpgate 堡垒机里的目标服务器（SSH 主机），无需登 Web UI 或手写 SQL。

**Why this approach:** MCP Server 已经在堡垒机上跑着，本地有一个只读的 Warpgate DB 连接。我们加一个可写连接，用 SQLite INSERT/UPDATE/DELETE 操作 targets 表——和 warpgate-manager skill 文档化了的模式一样。官方推荐走 Admin API，但那需要先有 API Token 去调 8888 端口的 HTTPS，当前路径更简洁。

**What it will NOT do:** 不改 roles/users 表；不做批量导入；不操作 ticket/rate_limit 等高级字段。

**Effort:** Short
**Risk:** Low - 四个工具都是格式化 SQL 操作，不涉及 SSH 调用或跨服务协调。add/edit/remove 标记为 `sensitive: true`（敏感权限），但当前版本所有有效 token 均可调用。后续 RBAC 系统接入后，敏感操作默认对非 admin token 拒绝
**Decisions to sanity-check:** 新目标是否关联 admin 角色（已默认）、edit 是否允许改 name（已确认跟 Warpgate 一致）

Your next move: approve the plan. Full execution detail follows below.

---

> TL;DR (machine): Effort: Short | Risk: Low — 4 个 MCP 工具 (add/edit/remove/get) + 可写 DB 连接 + 类型定义 + 注册

## Scope
### Must have
- 新增可写 Warpgate DB 连接函数
- 新增 4 个 MCP 工具 (add/edit/remove/get_target)
- add/edit/remove 在 tool-meta 中标记 `sensitive: true`，但不做硬编码权限检查（当前所有有效 token 均可调用）
- 支持 SSH 公钥认证和密码认证两种方式
- 新目标默认关联 admin 角色
- 删除时自动清理 target_roles

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不改现有 readonly 连接
- 不调用 Admin REST API
- 不改 roles/users/其他表
- 不做 bulk import
- 不实现高级字段 (ticket/rate_limit/group)

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + manual SSH verification on bastion
- Evidence: .omo/evidence/task-1-warpgate-target-mgmt.ext

## Execution strategy
### Parallel execution waves
Wave 1 (2 tasks in parallel): 类型定义 + 可写连接 / 工具实现
Wave 2 (1 task): 注册 + 编译验证

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. types.ts + db.ts | C6, C1 | 2 | — |
| 2. target-mgmt.ts | 1 | 3 | — |
| 3. register + build | 2 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [x] 1. `src/types.ts` + `src/db.ts` + `src/db.test.ts` — 追加 TargetOptions 类型、可写 DB 连接、单元测试
  What to do / Must NOT do:
    - types.ts 追加 TargetOptions Zod schema：`{ kind: "Ssh", host, port, username, auth: { kind, password? }, allow_insecure_algos, rate_limit_bytes_per_second?, group_id?, ticket_*? }`
    - db.ts 追加 `openWarpgateDbWritable(dbPath: string)` 函数— 不设 readonly、fileMustExist=true
      - **⚠️ 必须设置 `db.pragma('journal_mode = WAL')`** — 与 readonly 连接保持 WAL 模式一致，避免写连接默认 journal 模式阻塞读连接
    - db.ts 追加 `getAdminRoleId(db: Database)` 查询 admin 角色 ID
    - **创建 `src/db.test.ts`**，覆盖 openWarpgateDbWritable（打开成功/失败）、getAdminRoleId（admin 存在/不存在）
    - Must NOT: 改动现有 openWarpgateDb（保持 readonly）
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2
  References: src/db.ts:31-40, src/types.ts:1-13, librarian task schema
  Acceptance criteria: `tsc --noEmit` 通过 + `npx vitest run src/db.test.ts` 全部绿色
  QA scenarios: `npx vitest run src/db.test.ts` + Evidence task-1-warpgate-target-mgmt.xml (vitest junit)
  Commit: Y | feat(db): add writable DB connection and TargetOptions type

- [x] 2. `src/tools/target-mgmt.ts` — 实现 4 个目标管理工具的定义 + handler
  What to do / Must NOT do:
    - 实现 `warpgate_add_target`:
      - inputs: name(required), host(required), port(default 22), username(default root), description, auth_kind(publickey|password), auth_password(当auth_kind=password时必填)
      - **name 唯一性校验**：INSERT 前执行 `SELECT id FROM targets WHERE name = ?`，若已存在返回 `isError: true` + 提示"Target name already exists"
      - 生成 UUID → INSERT INTO targets → JSON.stringify options
      - 默认关联 admin 角色（INSERT INTO target_roles）
      - 返回完整目标信息
    - 实现 `warpgate_edit_target`:
      - inputs: id(required), name?, host?, port?, username?, description?, auth_kind?, auth_password?
      - 只更新传了的字段（partial update，以 `!== undefined` 判断）
      - 支持修改 name（跟 Warpgate Admin API 一致）
      - **如果修改 name，也需要检查新 name 的唯一性**（排除自身：`WHERE name = ? AND id != ?`）
      - **auth 变更完整性规则**：
        - 如果传了 `auth_kind="password"` 但没传 `auth_password` → 拒绝，报错 "auth_password required when auth_kind=password"
        - 如果传了 `auth_kind="publickey"` → 强制清除 password 字段（auth JSON 中不包含 password）
    - 实现 `warpgate_remove_target`:
      - inputs: id(required)
      - 先 DELETE target_roles WHERE target_id=?, 再 DELETE targets WHERE id=?
      - **目标不存在时**返回 `isError: true` + "Target not found"
      - 成功返回被删除目标的基本信息
    - 实现 `warpgate_get_target`:
      - inputs: id? (UUID), name? (字符串)
      - 按 id 或 name 查询，返回完整信息
      - **id 和 name 都未提供时**返回 `isError: true` + "Must provide id or name"
      - **目标不存在时**返回 `isError: true` + "Target not found"
    - 所有 handler 签名遵循 `(warpgateWriteDb, ctx, args) => result` 模式（为后续认证层接入预留）
    - 审计日志记录所有写操作
    - Must NOT: 不调用 SSH、不修改 readonly 连接
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3
  References: src/tools/discovery.ts, src/tools/exec.ts, src/db.ts, warpgate-manager skill:60-85
  Acceptance criteria: 4 个工具定义 + handler 编译通过
  QA scenarios: `npx vitest run src/tools/target-mgmt.test.ts` + Evidence task-2-warpgate-target-mgmt.xml
  Commit: Y | feat(tools): add target management tools (add/edit/remove/get)

- [x] 3. `src/tool-meta.ts` + `src/index.ts` — 注册新工具并编译验证
  What to do / Must NOT do:
    - tool-meta.ts 做两件事：
      - **`ToolMeta` 接口追加 `sensitive?: boolean` 字段** — 为后续 RBAC 系统埋点
      - **追加 4 条记录**：
        - `{ name: 'warpgate_add_target', readOnly: false, category: 'system', sensitive: true }`
        - `{ name: 'warpgate_edit_target', readOnly: false, category: 'system', sensitive: true }`
        - `{ name: 'warpgate_remove_target', readOnly: false, category: 'system', sensitive: true }`
        - `{ name: 'warpgate_get_target', readOnly: true, category: 'discovery' }`
    - index.ts 追加：
      - import { addTargetTool, handleAddTarget, editTargetTool, handleEditTarget, removeTargetTool, handleRemoveTarget, getTargetTool, handleGetTarget } from './tools/target-mgmt.js';
      - ListToolsRequestSchema 中追加 4 个 tool 定义
      - CallToolRequestSchema 中追加 4 个 case 分支
      - 打开可写 DB 连接（warpgateWriteDb）
    - 编译 tsconfig.json 确保无 Error
    - Must NOT: 改动其他已有工具的逻辑、不改任何已有工具描述（[READONLY]/[WRITE] 保持原样）
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: —
  References: src/tool-meta.ts, src/index.ts:89-169
  Acceptance criteria: `tsc --noEmit` 无报错
  QA scenarios: `npx tsc --noEmit` + Evidence task-3-warpgate-target-mgmt.txt
  Commit: Y | feat(index): register target management tools

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — 所有 Must have 已实现，Must NOT have 无违反
- [x] F2. Code quality review — handler 遵循现有模式，Zod 校验输入，错误处理完整
- [x] F3. Real manual QA — 在部署环境实际测试 add/edit/remove/get 工具
- [x] F4. Scope fidelity — 没有越界改动（只动 target 表 + 角色关联）

## Commit strategy
3 commits, one per todo, squashed into one on merge:
1. `feat(db): add writable DB connection and TargetOptions type`
2. `feat(tools): add target management tools (add/edit/remove/get)`
3. `feat(index): register target management tools`

## Success criteria
- 4 个新工具成功注册到 MCP 工具列表
- tsc 编译无 Error
- 可写 DB 连接成功打开并写入 targets 表
- 删除目标同时清理 target_roles
- 公钥和密码两种认证方式均可写入
