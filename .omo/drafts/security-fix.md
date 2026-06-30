---
slug: security-fix
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/security-fix.md
approach: 分 Wave 并行修复 5 个安全漏洞 + 实现 RBAC 框架
---

# Draft: security-fix

## Components (topology ledger)
| id | outcome | status |
|----|---------|--------|
| auth-bypass | SSE 端点认证绕过修正 | active |
| blacklist | 命令黑名单强化 + 高危命令实际拦截 | active |
| path-traversal | 文件路径规范化/安全检查 | active |
| log-leak | edit_target 审计日志泄露密码修复 | active |
| toctou | 目标名称检查+插入事务化 | active |
| rbac | sensitive 标志运行时校验 | active |
| password-storage | SSH 密码明文存储（上游限制，非本项目可修） | deferred |

## Open assumptions (announced defaults)
| assumption | default | rationale |
|------------|---------|-----------|
| 认证绕过修复策略 | 在 CallToolRequestSchema handler 中校验 token | SSE 端点是 MCP SDK 连接协议必须的，不能加 HTTP 级 auth，只能在消息级校验 |
| 黑名单扩展策略 | 追加高危模式 + 将 riskLevel 'high' 改为实际拦截 | 当前 'high' 只记录不拦截，完全无效 |
| 路径遍历防御策略 | 使用 path.resolve + startsWith 白名单判断 | 远程服务器路径不能本地检查，所以用 normalize 后拒绝 .. |
| RBAC 策略 | 在 auth.ts 中读取 token→角色映射，检查工具 sensitive 标志 | 简单 MVP，不改 multi-token 方案 |

## Findings (cited - path:lines)
- C-01: src/auth.ts:5 + src/index.ts:204-212 — SSE 白名单绕过认证
- H-01: src/tools/exec.ts:6-13 — 5 条黑名单可绕过，high 不拦截
- H-02: src/ssh.ts:270-282 — remotePath 无安全检查
- M-01: src/tools/target-mgmt.ts:206 — edit audit log 直接序列化 args 包含密码
- L-01: src/tools/target-mgmt.ts:41 + 70 — 检查和插入无事务
- I-01: src/tool-meta.ts:26-28 — sensitive 已定义但未运行时检查

## Decisions (with rationale)
- D1: 不在 SSE HTTP 层加 auth（MCP SDK 要求 SSE 无 auth），在 CallToolRequestSchema 消息层加
- D2: 黑名单使用正则匹配高危命令并实际拦截，High 级别命令默认拦截
- D3: 路径遍历用 path.posix.resolve + 拒绝 .. 穿透，上传/下载/读/编辑全部加检查
- D4: target-mgmt.ts 的 TOCTOU 和日志泄露同时修复，同一文件
- D5: RBAC 使用工具级别的 `sensitive` 标志，硬编码 admin token 判断（不引入数据库）
- D6: M-02 明文密码标记为 deferred — 这是 Warpgate 上游设计

## Scope IN
- C-01: 在 CallToolRequestSchema handler 中插入 token 校验
- H-01: 增加高危命令黑名单 + 实际拦截 high+ 级别
- H-02: ssh.ts 中 readFile/uploadFile/downloadFile/editFile 加路径安全检查
- M-01: edit_target audit log 排除 auth_password
- L-01: add_target + edit_target 用 db.transaction() 包裹
- I-01: 实现基于 sensitive 标志的运行时权限检查

## Scope OUT (Must NOT have)
- 不改 Warpgate 上游（不修密码存储方案）
- 不改 Express HTTP 层配置
- 不引入多 token / 多用户系统
- 不修改 MCP SDK 本身
- 不修改 package.json 增加新依赖

## Open questions
无。所有方案已确定。

## Approval gate
status: awaiting-approval
