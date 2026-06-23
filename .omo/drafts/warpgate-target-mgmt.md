---
slug: warpgate-target-mgmt
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/warpgate-target-mgmt.md
approach: "在现有 warpgate-mcp 项目上新增 4 个目标管理 MCP 工具，通过可写 SQLite 连接写入 Warpgate DB。新增 src/tools/target-mgmt.ts、src/db.ts 追加可写连接、tool-meta 和 index.ts 注册。"
---

# Draft: warpgate-target-mgmt

## Components (topology ledger)
| id | outcome | status | evidence path |
|----|---------|--------|---------------|
| C1 | 可写 Warpgate DB 连接 (src/db.ts) | active | 现有 openWarpgateDb 是 readonly，需要新的 openWarpgateDbWritable |
| C2 | warpgate_add_target 工具 | active | MCP 工具，admin-only，创建目标 + 关联 admin 角色 |
| C3 | warpgate_edit_target 工具 | active | MCP 工具，admin-only，编辑 name/host/port/username/description/auth |
| C4 | warpgate_remove_target 工具 | active | MCP 工具，admin-only，删除目标 + 清理角色关联 |
| C5 | warpgate_get_target 工具 | active | MCP 工具，所有 token 可用，查询单个目标详情 |
| C6 | TargetOptions 类型定义 | active | src/types.ts 新增 SSH 目标的 options JSON 类型 |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|------------|----------------|-----------|-------------|
| 堡垒机运行正常、Warpgate 服务可写 | 目标管理工具写入 Warpgate DB 即时生效，无需重启 | Warpgate 监听 SQLite 文件变化 | Yes - 如果 Warpgate 改了策略可切 Admin API |
| admin 角色一定存在 | 新目标默认关联 admin 角色 | Web UI 也默认这么做，warpgate-manager skill 文档化 | Yes - 可配置默认角色名 |
| 选项字段 JSON 结构与当前 Warpgate 版本一致 | options 列的 JSON Schema 使用 Warpgate v0.25.5 的格式 | 作者警告"后续版本可能变化"，但这是我们当前可用且已文档化的路径 | Partial - 升级 Warpgate 时需要同步更新 |

## Findings (cited - path:lines)
- Warpgate 维护者 @Eugeny 反对直接写 DB（issue #1413），但**当前版本可工作**，且 warpgate-manager skill 文档化了相同模式
- `admin` 角色默认存在，可以通过 `SELECT id FROM roles WHERE name='admin'` 获取 -- warpgate-manager skill:70-78
- targets 表 columns: id(UUID), name, kind, description, options(JSON), rate_limit_bytes_per_second, group_id, ticket_* 等 -- librarian task (GitHub sources)
- 删除目标时需要先删 `target_roles` 再删 `targets`（外键约束） -- warpgate-manager skill:81-85
- SSH 目标 options JSON 结构：`{ "kind": "Ssh", "host", "port", "username", "auth": { "kind": "PublicKey"|"Password", "password?" }, "allow_insecure_algos": false }` -- librarian task (Terraform provider source)
- 当前 DB 连接是 readonly: `new Database(dbPath, { readonly: true, fileMustExist: true })` -- src/db.ts:34
- 现有工具 handler 模式：每个工具在 `src/tools/*.ts` 定义 + `tool-meta.ts` 注册 + `index.ts` switch 分支 -- src/index.ts:89-169

## Decisions (with rationale)
| # | Decision | Rationale |
|---|----------|-----------|
| D1 | 用可写 SQLite 连接而非 Admin REST API | MCP 已在堡垒机上运行，已有 SQLite 依赖，无需 Admin API Token 鸡生蛋问题 |
| D2 | 独立可写连接（不共用 readonly 连接） | SRP：读连接用 WAL 无锁读，写连接正常读写，避免事务冲突 |
| D3 | 工具名 warpgate_add/edit/remove/get_target | 与现有 warpgate_list_targets 命名一致 |
| D4 | add/edit/remove 标记 `sensitive: true`，不做硬编码权限检查 | 为后续 RBAC 系统埋点：当前所有有效 token 均可调用（不拒绝）；`sensitive` 标签让未来 RBAC 层默认中对非 admin token 拒绝，但管理员可以手动配置给任意 token |
| D4a | `tool-meta.ts` 新增 `sensitive?: boolean` 字段 | RBAC 层需要知道哪些工具是敏感操作，以便做出正确的默认决策 |
| D5 | get_target 对所有 token 开放 | 查询操作不影响系统安全，与 list_targets 一致 |
| D6 | 支持公钥和密码两种认证方式 | 用户明确要求两种都支持 |
| D7 | 新目标默认关联 admin 角色 | 用户明确要求默认 admin |
| D8 | edit 允许修改 name | 用户要求「跟 Warpgate 一致」，Admin API 的 PUT 允许修改 name |
| D10 | name 唯一性校验：add/edit 时应用层检查 | DB 无 UNIQUE 约束，不检查会导致重复目标致 Warpgate 行为未定义 |
| D11 | edit_target auth 变更完整性：password→password 需密码、publickey→自动清密码 | 防止 silent data corruption（无效 SSH 目标） |
| D12 | 写连接也设置 `journal_mode = WAL` | 避免默认 journal 模式阻塞 WAL 读连接 |

## Scope IN
1. 新增可写 Warpgate DB 连接函数 `openWarpgateDbWritable()`
2. 新增 4 个 MCP 工具：add / edit / remove / get_target
3. 工具 handler 实现（SQLite CRUD + 角色关联 + 输入校验）
4. tool-meta 注册 + index.ts switch 注册
5. types.ts 追加 TargetOptions 类型

## Scope OUT (Must NOT have)
- ❌ 不新增 Admin REST API 调用（现有 SQLite 路径足够）
- ❌ 不改现有 readonly 连接的逻辑
- ❌ 不修改 targets 表以外的 Warpgate DB 表（roles、users 等只读操作不动）
- ❌ 不做 bulk import（一次只操作一个目标）
- ❌ 不实现 ticket/rate_limit/group 等高级字段（保持与当前 schema 一致的最小变更集）

## Open questions
（无需再问，所有决策已确认）

## Approval gate
status: awaiting-approval
