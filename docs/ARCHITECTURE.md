# Aerie 架构文档

> Warpgate MCP Server —— 把 Warpgate 堡垒机的 SSH 管理能力暴露为 MCP 工具,让 AI 客户端安全地运维远程服务器集群。

这份文档按"从概览到细节"分层。你可以按需展开,不必一次读完。

---

## 0. 怎么读这份文档

| 目标 | 推荐路径 |
|---|---|
| 5 分钟了解项目 | §1 是什么 → §2 全景架构 |
| 30 分钟理解原理 | 加 §3 核心子系统 → §4 数据层 |
| 要扩展功能 | §5 工具体系 或 §6 Dashboard → §7 部署 |
| 排查问题 | §7.4 日志排查 → §8.3 常见问题 |
| 学习设计教训 | §6.4 Dashboard 设计陷阱(真实 bug 复盘) |

---

## 1. 项目是什么

### 1.1 一句话定位

Aerie 是一个 **MCP 服务器**,它把 [Warpgate](https://github.com/warp-tech/warpgate) 堡垒机管理的 SSH 目标,包装成 20 个标准 MCP 工具,供 Claude / OpenCode 等 AI 客户端调用。

### 1.2 它解决什么问题

**没有 Aerie 时:** AI 客户端要直接 SSH 到服务器,需要自己管密钥、管审计、管权限,且无法复用已有的堡垒机基础设施。

**有了 Aerie:** AI 客户端只对接 Aerie 一个端点,Aerie 走 Warpgate 堡垒机执行所有操作 —— 复用堡垒机的目标管理、会话录制、密钥托管,同时叠加 MCP 层的认证、限流、命令黑名单、审计。

### 1.3 不做什么(边界)

- **不做 SSH 协议本身**:依赖 Warpgate 已录入的目标(主机/端口/用户/密钥)
- **不做用户管理**:Warpgate 侧的用户/角色由 Warpgate 自己管,Aerie 只读 Warpgate 的 DB
- **不做公网暴露**:默认监听 `127.0.0.1:3100`,公网访问需 SSH 隧道或反向代理
- **不替代堡垒机**:它是堡垒机之上的 AI 接入层,不是堡垒机本身

---

## 2. 全景架构

### 2.1 拓扑

```
┌─────────────┐   HTTP/SSE    ┌──────────────────────────┐   SQLite    ┌───────────┐
│  AI Client  │ ────────────► │      Aerie (:3100)       │ ◄─────────► │  Warpgate │
│ Claude/Open │   Bearer/Sess │  Express + MCP SDK       │   (只读+写)  │   堡垒机   │
└─────────────┘               │                          │             └─────┬─────┘
                              │  ┌─ auth (Bearer+Session)│                   │ SSH
┌─────────────┐   Cookie      │  ├─ rateLimiter 60/min   │            ┌──────▼──────┐
│  Browser    │ ────────────► │  ├─ 20 MCP tools         │            │ 远程服务器  │
│  Dashboard  │               │  ├─ Dashboard REST + SPA │            │   集群      │
└─────────────┘               │  └─ metrics DB (自有)    │            └─────────────┘
                              └──────────────────────────┘
```

### 2.2 请求流转

**MCP 工具调用(AI 客户端):**
1. 客户端建 SSE 连接到 `/sse?token=xxx` —— `validateMcpToken` 校验
2. 通过 `/message` POST 工具调用
3. MCP SDK 解析 → `index.ts` 注册的 handler 执行
4. handler 用注入的 `warpgateDb` / `sshExec` 完成操作
5. 返回 `{ content: [{type:'text', text:JSON}], isError? }`

**Dashboard 浏览器:**
1. 浏览器加载 `/dashboard/` 静态文件(SPA)
2. 前端调 `/api/auth/login` 拿 Cookie Session(24h TTL)
3. 后续 `/api/*` 靠 Cookie 鉴权,`authMiddleware` 放行

### 2.3 三层职责

| 层 | 职责 | 关键文件 |
|---|---|---|
| 接入层 | 认证、限流、路由 | [auth.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/auth.ts) [index.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/index.ts) |
| 工具层 | 20 个 MCP 工具的实现 | [tools/](file:///d:/WorkSpace/projects/Warpgate-MCP/src/tools) |
| 适配层 | Warpgate DB、SSH 执行、自有 metrics | [db.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/db.ts) [ssh.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/ssh.ts) [metrics-db.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/metrics-db.ts) |

---

## 3. 核心子系统(可展开)

### 3.1 认证与鉴权

**双通道认证**,对应两类客户端:

| 通道 | 客户端 | 凭证 | 校验位置 |
|---|---|---|---|
| Bearer Token | MCP 客户端 | `Authorization: Bearer <token>` | `authMiddleware` |
| Cookie Session | Dashboard 浏览器 | `aerie_session=<id>` Cookie | `authMiddleware` + `validateSession` |

**关键设计:`currentConfig` 实时生效**

[auth.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/auth.ts) 的 `authMiddleware` 读的是模块级 `currentConfig`,而不是闭包捕获的参数。`currentConfig` 通过 `setAuthConfig()` 更新 —— 这样首次安装(setup)设置 token 后,**无需重启服务**即生效。

> **教训:** 早期版本中间件闭包捕获 `config` 参数,setup 时 `config = cfg` 重新赋值后,中间件还持有旧引用(setup 前空 token),导致 Bearer token 失效直到重启。详见 §6.4。

**Setup 模式(首次安装)**
- 启动时调 `isConfigured()`([config.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/config.ts))—— 检查 SecretStore 是否有 token,或旧版 `config.json` 是否有 `authToken`(≥8 字符)
- 未配置时 `/api/setup/status` 返回 `{ configured: false }`,前端跳 `#setup`
- `/api/setup/status` 和 `/api/setup/init` 在白名单,免认证可访问
- 设置 token 后 `setAuthConfig(cfg)` 实时更新,Bearer 立即生效

**白名单分层**(在 [auth.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/auth.ts) 顶部):
- `SSE_WHITELIST`:`/sse` `/message`(SSE 握手用,token 在 `/sse` 内部校验)
- `DASHBOARD_WHITELIST`:`/api/auth/login` `/api/auth/logout` `/api/setup/*` 静态资源
- `SETUP_WHITELIST`:setup 端点

### 3.2 限流

**令牌桶**,60 req/min,按 `req.ip` 隔离([auth.ts `createRateLimiter`](file:///d:/WorkSpace/projects/Warpgate-MCP/src/auth.ts))。

```ts
// 桶结构:{ tokens: number, lastRefill: number }
// 每次调用:先按时间差补 tokens(上限 60),再扣 1;不足返回 false
```

**反代注意:** 部署在 Nginx/OpenResty 后面时,必须 `app.set('trust proxy', 1)`(已在 [index.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/index.ts) 设置),否则所有请求 IP 都是反代 IP,限流退化为全局。

### 3.3 命令黑名单与风险分级

[exec.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/tools/exec.ts) 维护 42 条正则,分四级风险:

| 等级 | 示例 | 处置 |
|---|---|---|
| low | `ls` `ps` `df` | 直接执行 |
| medium | `systemctl restart` | 执行 + 审计 |
| high | `rm -rf /` `mkfs` | **拦截** + 审计 + 返回错误 |
| critical | `:(){:|:&};:` fork 炸弹 | **拦截** + 审计 |

**设计要点:** 黑名单是防御纵深的一层,不是唯一防线。真正的高危操作还应靠 Warpgate 侧的 RBAC 和操作系统权限。

### 3.4 文件锁

[locks.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/locks.ts) 按 `remotePath` 排队的 Promise 链锁。

```ts
// 同一 path 的操作串行;不同 path 并行
const current = (locks.get(path) || Promise.resolve()).catch(() => {});
locks.set(path, current.then(fn));
```

**为什么需要:** `edit_file` 是"读 → 改 → 写"三步,如果两个并发调用同时改同一文件,后写的会覆盖先写的,丢失编辑。锁保证同路径串行。

**注意:** 锁是进程内的。多实例部署时不够,需要分布式锁(目前不支持,默认单实例)。

### 3.5 审计与指标

[metrics-db.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/metrics-db.ts) 维护 4 张表:

| 表 | 写入者 | 用途 |
|---|---|---|
| `audit_log` | 所有写工具 | 每次执行/上传/编辑/目标管理都记一条,含 risk_level、exitCode、diff |
| `stats_history` | `warpgate_stats` 工具 | 采集的 CPU/MEM/DISK/LOAD 时序,Dashboard 性能图来源 |
| `health_cache` | `warpgate_health_check` | 目标健康状态缓存,避免重复探测 |
| `alert_rules` | `warpgate_alert_create` | 告警规则 |

**审计字段约定:**
- `risk_level`:`low` / `medium` / `high` / `critical`(可空)
- `status`:`success` / `failed` / `blocked`
- `diff`:编辑类操作保存前 2000 字符,用于回溯

### 3.6 Secret Store

[secret-store.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/secret-store.ts) —— Token 不落 `config.json` 明文。

**优先级:**
1. OS Keyring(macOS Keychain / Windows Credential Manager / Linux Secret Service)
2. 回退:机器密钥派生的 AES-256-GCM 加密文件(`~/.warpgate-mcp/secret.enc`)

**为什么这样设计:** `config.json` 可能被备份、被提交到 git、被其他用户读到。Keyring 是操作系统级隔离,加密文件是兜底。

---

## 4. 数据层

### 4.1 两个数据库

Aerie 同时操作两个 SQLite 数据库:

| DB | 路径 | Aerie 权限 | 用途 |
|---|---|---|---|
| Warpgate DB | Warpgate 安装目录下 | **只读** + 受控写 | 读 targets 表,写 targets(add/edit/remove) |
| Metrics DB | `~/.warpgate-mcp/metrics.db` | 完全读写 | 审计、stats 历史、告警规则 |

**为什么 Warpgate DB 有两个连接?**
[db.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/db.ts) 同时打开 `warpgateDb`(只读)和 `warpgateWriteDb`(可写)。读操作用只读连接,遵循权限最小化;只有 `add/edit/remove_target` 用可写连接。

### 4.2 表结构(Metrics DB)

```sql
-- 审计日志(所有写操作)
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT,
  command TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  risk_level TEXT,
  status TEXT,
  diff TEXT
);

-- 性能采样历史
CREATE TABLE stats_history (
  id TEXT PRIMARY KEY,
  target_name TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  cpu_percent REAL, mem_percent REAL, disk_percent REAL,
  load_1m REAL, uptime_seconds INTEGER
);

-- 目标健康缓存
CREATE TABLE health_cache (
  target_name TEXT PRIMARY KEY,
  status TEXT, latency_ms INTEGER, checked_at TEXT
);

-- 告警规则
CREATE TABLE alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT, target_name TEXT, metric TEXT,
  operator TEXT, threshold REAL,
  enabled INTEGER, notify_method TEXT, created_at TEXT
);
```

**字段命名约定:** 全部 snake_case。`stats_history` 的列名 `cpu_percent` 等也是 `alert_rules.metric` 的合法取值 —— 两者必须一致,否则告警评估匹配不到数据(见 §6.4 教训 #4)。

---

## 5. 工具体系

### 5.1 20 个工具分类

[tool-meta.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/tool-meta.ts) 定义元信息,为未来 RBAC 打地基:

| 分类 | 工具 | readOnly | sensitive |
|---|---|---|---|
| discovery | `list_targets` `health_check` `get_target` | ✓ | |
| exec | `exec` | ✗ | |
| file | `upload` `download` `read_file` `edit_file` | 混合 | |
| monitor | `stats` `alert_list` `alert_create` `alert_delete` | 混合 | |
| audit | `audit_query` `audit_stats` | ✓ | |
| system | `deps_check` `config_get` `config_set` | 混合 | |
| 目标管理 | `add_target` `edit_target` `remove_target` | ✗ | **✓** |

**sensitive 工具**需调用方传 `confirm: true` 才执行,为 RBAC 预留门禁。

### 5.2 工具生命周期

```
MCP 客户端调用
   │
   ▼
MCP SDK 解析 tool name + args
   │
   ▼
index.ts 的 handler case 分发 ────► sensitive? 检查 args.confirm === true
   │                                    │ 不通过 → 返回 error
   ▼                                    │
   handler 执行                         │
   ├─ 读 warpgateDb / metricsDb         │
   ├─ 调 sshExec / sshEdit / ...        │
   ├─ 写 audit_log                      │
   └─ 返回 { content, isError? } ◄──────┘
```

**Handler 不直接 import DB**,而是通过 `index.ts` 依赖注入。这样测试时可 mock,且 DB 连接生命周期由 `index.ts` 统一管理。

### 5.3 如何加一个新工具(可操作)

以加一个 `warpgate_list_processes` 为例:

1. **在 [tool-meta.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/tool-meta.ts) 注册元信息**
   ```ts
   { name: 'warpgate_list_processes', readOnly: true, category: 'monitor' },
   ```

2. **在 [tools/](file:///d:/WorkSpace/projects/Warpgate-MCP/src/tools) 下新建或扩展文件**,定义 tool schema + handler:
   ```ts
   export const listProcessesTool = {
     name: 'warpgate_list_processes',
     description: '[READONLY] List top processes on target',
     inputSchema: {
       type: 'object',
       properties: { target: { type: 'string' } },
       required: ['target'],
     },
   };

   export async function handleListProcesses(args, getTarget, sshExec, auditLog) {
     // 1. 校验 target 存在
     // 2. 调 sshExec('ps aux --sort=-%cpu | head -20')
     // 3. auditLog(...)
     // 4. return { content: [...] }
   }
   ```

3. **在 [index.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/index.ts) 注册到 MCP server**:
   ```ts
   server.setRequestHandler(CallToolRequestSchema, async (req) => {
     switch (req.params.name) {
       // ...
       case 'warpgate_list_processes':
         return handleListProcesses(args, getTargetByName, sshExec, auditLog);
     }
   });
   ```
   同时在 `server.setRequestHandler(ListToolsRequestSchema, ...)` 的工具列表里加入 `listProcessesTool`。

4. **写测试**:在对应 `*.test.ts` 里加 case,mock `sshExec` 验证返回结构。

5. **如果是写操作**,记得在 handler 里调 `auditLog`,并在 `tool-meta.ts` 标 `readOnly: false`。

---

## 6. Dashboard

### 6.1 SPA 路由与鉴权

前端是 **Vanilla JS + hash 路由**,无构建链。核心在 [app.js](file:///d:/WorkSpace/projects/Warpgate-MCP/src/dashboard/app.js)。

**路由表:**

| Hash | 页面 | 鉴权 |
|---|---|---|
| `#setup` | 首次安装 | 免鉴权(PUBLIC_HASHES) |
| `#login` | 登录 | 免鉴权(PUBLIC_HASHES) |
| `#overview` | 总览 | 需登录 |
| `#targets` | 目标列表 | 需登录 |
| `#target/:name` | 目标详情 | 需登录 |
| `#performance/:name` | 性能 | 需登录 |
| `#exec` | 命令执行 | 需登录 |
| `#files` | 文件管理 | 需登录 |
| `#audit` | 审计 | 需登录 |
| `#alerts` | 告警 | 需登录 |

**鉴权流程**(`onHashChange`):
```
hash 变化 → matchRoute → 若 !authenticated && hash 不在 PUBLIC_HASHES
                          → 重定向 #login
                        → 否则 renderSidebar + 执行路由函数
```

**关键时序:** `hashchange` 监听必须在 setup 检测**之前**注册,否则 setup 完成后 `window.location.replace('#overview')` 触发的 hashchange 无人响应(见 §6.4 教训 #1)。

### 6.2 前后端 API 契约

Dashboard 通过 `/api/*` REST 路由调用后端,后端路由在 [dashboard.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/dashboard.ts)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 服务健康 + targets_count + 请求计数 |
| GET | `/api/targets` | 目标列表 |
| GET | `/api/targets/:name` | 单目标详情(用只读连接) |
| POST | `/api/targets/:name/health` | 触发健康检查 |
| GET | `/api/targets/:name/stats` | 性能历史(**ASC 排序**,最新在末尾) |
| POST | `/api/targets/:name/stats/collect` | 主动采集一次 |
| GET | `/api/audit` | 审计查询(支持分页/过滤) |
| GET | `/api/audit/stats` | 审计统计(by_risk_level) |
| GET | `/api/alerts` | 告警规则列表 |
| POST | `/api/alerts` | 创建告警(metric 必须是 snake_case) |
| DELETE | `/api/alerts/:id` | 删除告警 |

**数据排序约定:** 所有返回时序数据的端点统一 **ASC**(旧→新),前端 `stats[stats.length-1]` 取最新,折线图自然左→右。不要混用 DESC。

### 6.3 如何加一个新页面

1. **在 `routes` 数组([app.js](file:///d:/WorkSpace/projects/Warpgate-MCP/src/dashboard/app.js))注册路由:**
   ```js
   { pattern: '#processes/:name', fn: renderProcesses }
   ```

2. **实现 `renderProcesses(params)`:**
   ```js
   async function renderProcesses({ name }) {
     $('#app').innerHTML = `...模板...`;
     const data = await api('GET', `/api/targets/${encodeURIComponent(name)}/processes`);
     // 渲染
   }
   ```

3. **如果需要新后端端点**,在 [dashboard.ts](file:///d:/WorkSpace/projects/Warpgate-MCP/src/dashboard.ts) 加 router 路由,调对应 handler。

4. **在侧边栏加导航项**(若需要):`renderSidebar()` 里加链接。

5. **XSS 防御:** 所有插入 HTML 的用户可控数据,显示用 `escHtml`,放进 `onclick="fn('...')"` 字符串字面量用 `escAttr`(转义单引号)。

### 6.4 Dashboard 设计陷阱(真实 bug 复盘)

这一节记录项目演进中踩过的坑,每条都附根因和修复,便于新人理解"为什么这么写"。

#### 陷阱 1:setup 死循环 —— 鉴权白名单遗漏

**现象:** 首次安装时,浏览器永远落在 login 页,无法完成初始化。

**根因:** `onHashChange` 的鉴权门禁只放行 `#login`:
```js
// 错误版本
if (!state.authenticated && hash !== '#login') {
  navigate('#login'); return;
}
```
首次安装检测到未配置后 `navigate('#setup')`,但 `#setup` 不在白名单 → 被踢回 `#login`。

**修复:** 用集合 `PUBLIC_HASHES = new Set(['#login', '#setup'])`,所有免鉴权路由集中管理,避免遗漏。

#### 陷阱 2:中间件闭包捕获旧 config

**现象:** 完成 setup 后,Dashboard 靠 Cookie 还能用,但 MCP 客户端用 Bearer token 调 API 全部 401,直到重启服务。

**根因:** `authMiddleware(config)` 在 app 启动时捕获 `config` 引用。setup 执行 `config = cfg` **重新赋值**,中间件闭包里的 `config` 仍指向旧对象(setup 前 `authToken: ''`)。而 `loginHandler` 用模块级 `currentConfig`(由 `setAuthConfig` 实时更新)—— 两条路径校验的 token 不一致。

**修复:** `authMiddleware` 改用 `currentConfig`,不依赖参数闭包。`currentConfig` 由 `setAuthConfig` 在 setup 时更新,实时生效。

**通用启示:** 中间件不要靠参数闭包持有可变状态,改用模块级引用 + 显式 setter。

#### 陷阱 3:时序数据排序与前端取值不一致

**现象:** 性能页 CPU 数字恒为旧值,折线图从右往左画。

**根因:** 后端 `ORDER BY collected_at DESC`(最新在前),前端 `stats[stats.length-1]` 当最新(实际是最旧),`slice(-60)` 取最旧 60 条且倒序。

**修复:** 后端统一 ASC。前端取值逻辑(`last` 是最新)和折线方向(左→右)自然正确。

**通用启示:** 前后端排序约定要写进契约,不能各写各的。

#### 陷阱 4:字段命名前后端分裂

**现象:** Dashboard 创建的告警 metric 是 `cpu_percent`,MCP 工具创建的是 `cpuPercent`,同一张表两种格式,告警评估匹配不到数据。

**根因:**
- MCP 工具 schema enum 声明 camelCase
- Dashboard 下拉选项 snake_case
- Dashboard 路由直接透传给 handler,**无运行时校验**,snake_case 原样入库

**修复:**
1. 统一 snake_case(与 DB 列名一致)
2. handler 加 Zod 运行时校验,拒绝非法枚举值

**通用启示:** schema 声明只是文档,handler 必须有运行时校验作为防御纵深。前后端共享的枚举值要从单一来源导出。

#### 陷阱 5:内联 onclick 的单引号注入

**现象:** target name 含单引号可突破 onclick 字符串边界,触发 XSS。

**根因:** `escHtml` 只转义 `& < >`,不转义单引号。`onclick="fn('${escHtml(name)}')"` 中 name 含 `'` 即可注入。

**修复:** 新增 `escAttr`,转义单引号 + 反斜杠 + HTML 特殊字符。所有插入 `onclick="..."` 字符串字面量的数据用 `escAttr`。

**通用启示:** 转义函数要按上下文区分:HTML 文本、属性值、JS 字符串字面量,各需不同转义。最稳是事件委托 + `data-*` 属性。

---

## 7. 部署与运维

### 7.1 本地开发

```bash
npm install
npm run dev      # tsx 热重载,监听 127.0.0.1:3100
```

测试:
```bash
npx tsc --noEmit   # 类型检查
npx vitest run      # 跑全部测试
```

### 7.2 PM2 生产部署

[ecosystem.config.cjs](file:///d:/WorkSpace/projects/Warpgate-MCP/ecosystem.config.cjs) 定义进程:

```bash
pm2 start ecosystem.config.cjs
pm2 logs aerie
pm2 restart aerie
```

### 7.3 反向代理与 HTTPS

默认监听 `127.0.0.1:3100` 仅本地。公网暴露推荐 Nginx/OpenResty 反代:

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # 必须,否则限流失效
    proxy_http_version 1.1;
    proxy_set_header Connection '';                   # SSE 需要
    proxy_buffering off;                              # SSE 实时推送
}
```

Aerie 已设 `app.set('trust proxy', 1)`,会从 `X-Forwarded-For` 取真实 IP。

HTTPS 也可直接在 Aerie 开启(`WPG_TLS_CERT_PATH` / `WPG_TLS_KEY_PATH`)。

### 7.4 日志与排查

[Pino](file:///d:/WorkSpace/projects/Warpgate-MCP/src/logger.ts) 双目标:
- `combined.log` —— 全量
- `error.log` —— 仅 error 级

**排查思路:**
1. 服务起不来 → 看 PM2 日志或 `server_err.log`
2. 401 → 检查 token 是否匹配 `config.json` 里的(或 Secret Store 里的)
3. 工具调用失败 → 查 `audit_log` 表(`status != 'success'` 的记录)
4. 限流 429 → 看 `req.ip` 是否被反代合并(检查 `trust proxy`)

---

## 8. 附录

### 8.1 配置项全表

`~/.warpgate-mcp/config.json`:

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `listenHost` | string | `127.0.0.1` | 监听地址 |
| `listenPort` | number | `3100` | 监听端口 |
| `warpgateDbPath` | string | 必填 | Warpgate 的 SQLite DB 路径 |
| `sshKeyPath` | string | `~/.ssh/id_ed25519` | SSH 私钥 |
| `authToken` | string | (setup 设置) | Bearer token(实际存 Secret Store) |

### 8.2 环境变量

所有 `WPG_*` 前缀的环境变量会覆盖 config.json:

| 变量 | 覆盖字段 |
|---|---|
| `WPG_LISTEN_HOST` | `listenHost` |
| `WPG_LISTEN_PORT` | `listenPort` |
| `WPG_WARPGATE_DB_PATH` | `warpgateDbPath` |
| `WPG_SSH_KEY_PATH` | `sshKeyPath` |
| `WPG_TLS_CERT_PATH` | TLS 证书路径 |
| `WPG_TLS_KEY_PATH` | TLS 私钥路径 |

### 8.3 常见问题

**Q: 为什么默认只监听 127.0.0.1?**
A: Aerie 持有 SSH 私钥和 Warpgate 写权限,公网暴露风险高。需要远程访问时走 SSH 隧道(`ssh -L 3100:127.0.0.1:3100 gateway`)或加反代 + HTTPS + 强 token。

**Q: setup 后改了 token,需要重启吗?**
A: 不需要。`setAuthConfig` 实时更新 `currentConfig`,中间件立即生效。(早期版本需要,见 §6.4 陷阱 2)

**Q: 多个 AI 客户端能同时连吗?**
A: 可以。SSE 支持多连接,限流按 IP。但注意 Aerie 是单进程,并发 SSH 操作受 Warpgate 侧连接池限制。

**Q: 如何审计 AI 做过什么?**
A: 查 Metrics DB 的 `audit_log` 表,或 Dashboard 的 `#audit` 页。所有写操作都有记录,含命令、退出码、风险等级、diff(编辑类)。

**Q: 命令被黑名单拦了怎么办?**
A: 这是设计如此。如果确实需要执行被拦命令,应通过 Warpgate 直接 SSH(人工操作),而不是绕过 Aerie 的黑名单。黑名单是防御纵深,不是可配置的开关。

---

## 9. 设计哲学小结

1. **复用而非重造** —— 不自建堡垒机,站在 Warpgate 肩上
2. **防御纵深** —— 认证 + 限流 + 黑名单 + 审计 + 文件锁,层层兜底
3. **权限最小化** —— Warpgate DB 分只读/可写连接,Secret Store 不落明文
4. **可观测** —— 每个写操作都留审计,每个时序都留历史
5. **单进程简单** —— 默认单实例,锁是进程内,够用就好;未来要多实例再说分布式锁

---

*文档随代码演进。如发现与代码不一致,以代码为准,并提 PR 修正本文档。*
