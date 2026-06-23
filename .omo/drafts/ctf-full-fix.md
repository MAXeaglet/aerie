---
slug: ctf-full-fix
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/ctf-full-fix.md
approach: 按文件分组为 5 个并行 Todo，覆盖 15 个需修复的 CTF 发现（3 个 Info 项跳过）
---

# Draft: ctf-full-fix

## Components (topology ledger)
| id | outcome | status |
|----|---------|--------|
| blacklist | exec.ts: 黑名单追加数据泄露/网络命令 + 管道拦截 | active |
| ssh-fixes | ssh.ts: saveTo/localPath/editFile错误/heredoc 4项修复 | active |
| auth | auth.ts+index.ts: 速率限制 + RBAC 就绪 | active |
| config | config.ts+system.ts: config_set 白名单收紧 + TLS 选项 | active |
| host-validation | target-mgmt.ts: host 输入校验 | active |
| tls | index.ts: HTTPS 支持 | deferred to after config change lands |

## Open assumptions (announced defaults)
| assumption | default | rationale |
|------------|---------|-----------|
| 黑名单策略 | 追加而非白名单 | 白名单破坏兼容性，追加封锁命令足够 |
| 网络命令拦截 | curl/wget/nc/ncat/telnet/ssh/scp/rsync 全部 block | 堡垒机不应允许从服务器发起对外连接 |
| saveTo 安全目录 | 限制到 `~/.warpgate-mcp/downloads/` | 简单白名单，无需新依赖 |
| 速率限制 | 令牌桶内存实现，60 req/min | 无依赖，轻量级 |
| TLS 证书配置 | config.ts 新增 tlsCertPath/tlsKeyPath | 可选配置，无证书时不启用 |

## Findings (cited)
- CTF-001: src/tools/exec.ts:11-53 — 黑名单缺口(cat/shadow/curl)
- CTF-002: src/ssh.ts:241-274 — download saveTo 无验证
- CTF-003: src/ssh.ts:210-234 — upload localPath 任意读取
- CTF-004: src/ssh.ts:327-333 — editFile 错误泄露内容
- CTF-005: src/ssh.ts:147-153 — heredoc 分隔符注入
- CTF-006: src/tools/exec.ts:141-143 — 命令输出不过滤
- CTF-007: src/auth.ts:26-50 — 无速率限制
- CTF-008: src/index.ts:234 — 纯 HTTP 传输
- CTF-009: src/tools/system.ts:69-96 — config_set 破坏
- CTF-010: src/tools/target-mgmt.ts:33 — host 无校验
- CTF-011: src/index.ts:125-128 — RBAC 占位符
- CTF-012: src/auth.ts:17 — 定时侧信道（低优）
- CTF-013: src/config.ts:59-62 — token 掩码泄露
- CTF-017: src/config.ts:47 — 明文 token 存储

## Decisions
- D1: CTF-012 (timing) + CTF-014/015/016 (info) deferred — 利用难度极高或非代码问题
- D2: CTF-017 deferred — 已有 0o600 权限保护，且无加密存储基础设施
- D3: CTF-013 fixed by improving maskToken to show 0 chars
- D4: TLS 支持作为可选配置（无证书时回退 HTTP）
- D5: host 校验使用 IP 格式正则 + 禁止私有 IP（可选）

## Scope IN
- exec.ts: 追加网络/数据泄露命令到黑名单 + 管道拦截
- ssh.ts: saveTo 白名单化 + localPath 路径规范化 + editFile 错误截断 + heredoc 逃逸修复
- auth.ts+index.ts: 速率限制 + RBAC 门禁实装
- config.ts+system.ts: config_set 白名单收紧 + TLS 选项
- target-mgmt.ts: host IP 格式校验

## Scope OUT (Must NOT have)
- 不加新 npm 依赖
- 不改 MCP SDK
- 不引入多 token/用户系统
- CTF-012/014/015/016/017 deferred
- 不修改 SSH 命令执行底层逻辑
- 不改现有返回格式

## Open questions
无

## Approval gate
status: awaiting-approval
