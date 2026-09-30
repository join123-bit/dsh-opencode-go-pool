# dsh-opencode-go-pool —— DSH rc 线兼容补丁版

本仓库是 [whitelonng/dsh-opencode-go-pool](https://github.com/whitelonng/dsh-opencode-go-pool)（MIT 协议）v0.1.10
的 **rc 线兼容补丁版**，用于个人/团队自用。当前适配 **DSH 0.1.2-rc.x ~ 0.2.0-rc.2**
（peer 范围 `>=0.1.0-rc.5 <0.3.0-0`）。功能与上游一致：

OpenCode Go 套餐的多 Key 池 —— 当前 Key 额度耗尽（`QUOTA`）或凭据失效（401/403）时，
在同一次流式调用内静默切换到下一个 Key 重发，对话零感知；提供设置页套餐用量卡片
（5h 滚动 / 每周 / 每月），额度耗尽的 Key 在 5h 窗口重置后自动复活回池。

## 为什么有这个补丁

DSH 0.1.2-rc.1 的 `@deepseek-ai/dsh-settings` 移除了 `settingsNamespace` 导出，
上游 v0.1.10 直接引用它，导致插件在 0.1.2 上启动即报错。补丁只有两行（`index.js`）：

```diff
- import { settingsNamespace } from '@deepseek-ai/dsh-settings'
  import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
...
- const NS = settingsNamespace('opencode-go-pool')
+ const NS = 'opencode-go-pool'
```

已在 DSH 0.1.2-rc.1 + Windows 实测：插件挂载、路由接管、Key 轮换与状态持久化全链路通过。

## v0.1.11 —— 防升级加固（2026-09-08）

在 0.1.10 兼容补丁之上新增：

1. **集成点探针**（`index.js`：`probeCoreImports()` / `selfCheck(ctx)`）—— 启动时逐个验证
   依赖的 DSH 接口（模块导入、`opencodeGoProvider()` 形状、`PiAiAdapter` 构造契约、
   `llm.registerAdapter` / `settings.register` / `credentials.resolve` 服务方法）。探测失败
   → 插件**休眠降级**：不接管路由、不抛错、官方单 Key 路由照常服务，原因写入日志并
   通过设置卡片 `takeoverHint` 显示；不再因 DSH rc 升级而"启动即崩"。
2. **升级冒烟脚本**（`smoke.mjs`）—— DSH 升级后先跑：
   `cd "$DSH_HOME/profiles/web" && node node_modules/dsh-opencode-go-pool/smoke.mjs`，
   全部 PASS 再信任插件；FAIL 行即被改动的接口。
3. **兼容矩阵 + 版本锁定文档**（README「稳定性」章节）—— 锁定 git commit 安装，
   升级 = 显式动作可回滚；每升级一次 DSH 更新一次矩阵。

行为变化：0.1.11 在探测不通过时静默休眠而不是报错，因此旧日志里的"启动报错"类现象
在 0.1.11 上会变成卡片上的 `integration probe failed: …` 提示。

## v0.1.12 —— OpenCode Go 请求头透传 + 流适配器复用（2026-09-08）

修复“opencode-go-pool 的 DeepSeek Flash Max 比官方 opencode-go 路由慢”的主要已知原因：

1. **透传 `headers`**（`index.js`）：插件接管 `opencode-go` 路由时，原来只使用 pi-ai 的
   静态 catalog，没有把官方路由配置里的额外请求头（尤其是 `x-opencode-session`）带到
   实际流式请求。OpenCode Go 需要该头时，丢头会导致会话/缓存加速失效，表现为 TTFB 和
   整体速度明显慢于官方单 Key 路由。现在 `Config` 增加 `headers` 字段，`buildProfile()`
   会把它写入 pi-ai profile，随每次请求发往上游。
2. **复用 per-key PiAiAdapter**（`index.js`）：每个 Key 的 PiAiAdapter 不再每次 `stream()`
   都重建，减少 pi-ai 模型集合的重复构造开销，降低请求前置损耗。

配置示例：

```yaml
- id: opencode-go-pool
  config:
    route: opencode-go
    keys: []
    headers:
      x-opencode-session: dsh-opencode-go-session
```

## v0.1.13 —— bundle 自动挂载（2026-09-08）

**不再需要手写 cordis.patch.yml 挂载行。**

- 包内新增 `cordis.patch.yml`（insert: 格式，含默认 config：route/keys/headers/
  preemptAtPercent/modelMode/models/usageBaseUrl/usageRefreshMs/timeoutMs）；
- package.json 声明 `dsh.bundle.patch: './cordis.patch.yml'`。`dsh plugin add`
  安装后，DSH 的 reconcile 机制会把这个包自动追加到 profile 的
  `dsh.profile.bundles` 层栈，每次启动自动合并挂载。
- 安装后检查：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 应包含
  `dsh-opencode-go-pool`；然后把用户 `cordis.patch.yml` 里的同名手工行删掉
  （用户层晚于 bundle 层且按行覆盖，保留手工行会覆盖 bundle 默认 config）。
- 版本锁定仍推荐：`dsh plugin --profile web add github:join123-bit/dsh-opencode-go-pool#<sha>`。

## v0.1.15 —— profile 契约补丁：模型选择器不再“加载失败”（2026-09-10）

**现象**：模型下拉里 `OpenCode Zen Go（池）` 显示
`加载失败：Cannot read properties of undefined (reading 'get')`。
供应商能列出，但选中/解析模型即崩。

**根因**：`llm-pi-ai@0.1.5-rc.1` 的 `PiAiAdapter.modelOf()` 会**无条件**读取
profile 上的 `modelErrors`：

```js
const failure = profile.modelErrors.get(model) ?? (profile.piProvider === void 0 ? profile.catalogError : void 0)
```

而 `buildProfile()` 手写 profile 时漏了这个字段。该调用路径与 `listModels()` 分离：
`listModels()` 从不读 `modelErrors`，所以供应商照常出现在列表里；只有模型选择器走的
`resolveModel()` 必崩——这正是“能列出、却加载失败”的原因。

`probeCoreImports()` / `selfCheck(ctx)` 也抓不到它：它们只验证模块导入、构造契约和服务
方法，**不**验证 profile 对象在调用期被解引用的字段。

**修复**（`index.js`，一行）：

```diff
     configuredMaxTokens: new Map(),
+    // llm-pi-ai 0.1.5-rc.1 PiAiAdapter.modelOf() reads `profile.modelErrors`
+    // unconditionally … the value llm-pi-ai itself declares for an error-free
+    // catalog route is exactly an empty Map.
+    modelErrors: new Map(),
     modelCapabilities: new Map(),
```

空 Map 就是 `llm-pi-ai` 对“无模型错误”的目录路由自己声明的值（`catalog?.modelErrors ?? new Map()`），
因此没有引入任何新行为。已实测：`resolveModel()` 恢复，未勾选模型的 `UNKNOWN_MODEL` 拦截、
`listModels()` 选择过滤、`providerInfo()` 显示名、卡片 `status()` 全部不变。

**新增回归守卫**（`smoke.mjs` 第 4 项）：用真实 `PiAiAdapter` + 本插件出声明的 profile 形状
驱动一次 `resolveModel()`。此类“导入都在、调用期才炸”的契约漂移，从此会被冒烟脚本拦下，
而不是等到用户打开模型下拉才发现。

> ~~尚未补齐（已知、非阻塞）：profile 还缺 `maxRequestImageBytes` / `requestImagePixelBudget` /
> `requestImageMaxBytes`，官方默认分别为 20MB / 4M px / 1MB；当前为 `undefined` = 不限制，
> 与 v0.1.14 行为一致，故未在本版改动。~~
>
> **已由 v0.1.16 补齐。** 当时的判断「`undefined` = 不限制」是错的：这三个值不是可选的，
> 附件服务会**校验**它们（`Image request maxPixels must be a positive integer.`）。只是
> v0.1.15 时路由上没有任何模型声明 `image`，这条路径不可达，所以没暴露。

## v0.1.16 —— 识图：`visionModels`（2026-09-23）

**现象**：`deepseek-v4.1-flash` 在对话里贴图片被拒（`Model ... does not support image input`，
`MODEL_DOES_NOT_SUPPORT_IMAGES`），但该模型上游**确实能看图**。

**根因**：DSH 只认 pi-ai 描述符的 `input` 数组 —— 它既是 `listModels()` 上报的
`inputModalities`（`dsh-api-session-controller` 据此准入附件），也是 `dsh-llm-pi-ai`
`stream()` 内联图片前的检查（不含 `image` 直接抛 `UNSUPPORTED_CONTENT`）。而
`deepseek-v4.1-flash` 不在 pi-ai 自带目录里（属于从官方 `models` 接口拉取的"动态"模型），
`dynamicModelDescriptor()` 给所有动态模型硬编码 `input: ['text']`，模态信息无处可来。

**修复**（配置项，默认开箱可用）：

```yaml
opencode-go-pool:
  visionModels:
    - deepseek-v4.1-flash
    - deepseek-flash
```

- `models.js`：新增 `DEFAULT_VISION_MODELS`、`normalizeVisionModels()`、`withVisionInput()`
  —— 只给名单内的 id 追加 `image`，其余描述符（含字段与对象身份）不动；
- `index.js`：`Config.visionModels`（默认 = `DEFAULT_VISION_MODELS`）；`buildProfile()` 在
  `getModels()` 里套一层 `withVisionInput()`（这是唯一入口：动态模型与自带目录模型都经过它）；
  `applyConfig()` 在名单变化时重建 profile 并重发 `llm/adapters-updated`（模型选择器即时刷新）。
- `cordis.patch.yml`：bundle 默认值同上。

**修复（二）：补齐 image request policy**。只声明模态还不够 —— 首次真机上传图片就炸：

```
Image request maxPixels must be a positive integer.   [INVALID_ATTACHMENT_REF]
```

`buildProfile()` 手写的 profile 少了 `maxRequestImageBytes` / `requestImagePixelBudget` /
`requestImageMaxBytes`，适配器把后两者原样交给
`attachments.readImageRequest(ref, policy)`，而附件服务**第一步就校验**它们是正整数
（`dsh-attachment-local`：`validatePolicy()` → `checkedInteger()`）。官方目录路由这三个值由
`llm-pi-ai` 填默认（20MB / 4M px / 1MB），手写 profile 必须自己带。v0.1.15 的「`undefined`
= 不限制」是误判：v0.1.15 时路由上没有模型声明 `image`，这条路径不可达而已。

```diff
     streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
+    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,        // 20MiB
+    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,  // 2048*2048
+    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,        // 1MiB
```

**为什么不是一行改所有动态模型**：给看不了图的模型声明 `image` 不会报错，而是静默失败
（图片进会话、模型看不见、照常作答）。2026-09-23 实测：

| 模型 | 结果 |
|---|---|
| `deepseek-v4.1-flash`、`deepseek-flash` | ✅ 正确读出图中文字与图形 |
| `deepseek-v4-pro` | ⚠️ 接受 `image_url`，回答「I can't view the image」 |
| `deepseek-v4-flash`、`glm-5.3` | ❌ 400 `Model only supports text input` |
| `mimo-v2.5-pro` | ❌ 404，未在该路径提供服务 |

**验证**（全真链路：真实 `buildProfile()` + 真实 `PiAiAdapter` + **真实 `dsh-attachment-local`**
（normalize → commit → request image）+ 真实端点，同一张图）：

```
1) v0.1.16 出厂时的 policy（undefined） → INVALID_ATTACHMENT_REF: Image request maxPixels must be a positive integer.
   （用户报的就是这条）
2) 修复后的 policy                      → maxPixels=4194304 maxBytes=1048576 → 360x140 image/png 1607B

A. visionModels: []                      → inputModalities: text
                                           REFUSED [UNSUPPORTED_CONTENT] does not support image input
B. visionModels: ['deepseek-v4.1-flash'] → inputModalities: text+image
                                           "The exact text printed in the image is: ZX4-8802
                                            The shape on the left is a green triangle,
                                            the shape on the right is a yellow rectangle."
```

> 上一版验证脚本**伪造了**附件服务（只实现 `readImageRequest`），所以漏掉了 policy 校验 ——
> 这正是它没拦住这个 bug 的原因。脚本已改为走真实附件管线（`vision-e2e.mjs`）。

**新增回归守卫**：`smoke.mjs` 第 5 项 —— 用真实 `buildProfile()` + 真实 `PiAiAdapter`
断言「动态模型在名单内 → `inputModalities` 含 `image`、`resolveModel()` 同样含；
自带目录的纯文本模型（`deepseek-v4-flash`）保持 `text`；**profile 的 image request policy
是正整数**（模态断言看不见的那一半，正是上面那条真机报错）」。另有
`test/vision.test.mjs`（6 项，`node --test test/*.test.mjs`）。

**不涉及**：客户端卡片（`client.js`）与 Typert 严格 schema（`typert.host.js`）未改动 ——
本参数是纯 host 侧配置项，改 `settings.yaml` 或 bundle patch 即可，无卡片 UI。

## v0.1.20 —— 与官方 `opencode-go` 路由并存（2026-09-30）

**需求**：官方 `opencode-go` 配置和本插件要能**同时存在**，而不是「必须删掉官方行才能接管」。

**旧行为**：`route: opencode-go` 被 `llm-pi-ai` 占着时，插件不注册任何路由，卡片显示
「等待接管」并提示你去删官方行 —— 二选一。

**新行为**（`index.js`，新增 `routeConflict` 配置）：

```diff
+ routeConflict: z.union(['own-route', 'wait']).default('own-route'),
```

- `own-route`（新默认）：首选路由被占用时，**注册自有路由 `opencode-go-pool`**，
  两条路由同时在册 —— 模型选择器里选官方行=官方单 Key，选「OpenCode Zen Go（池）」=走池；
- `wait`：v0.1.19 及以前的行为（不注册，等对方释放后接管），保留给「只想接管」的部署。

配套三处改动：

1. **profile 按两条路由各建一份**：`applyConfig()` 现在为 `opencode-go` 与
   `opencode-go-pool` 各建一个 profile（`buildProfile(route, …)` 的 `provider` 字段必须
   与 map 键一致），否则实际服务的路由在 `innerCatalog` 里查不到 profile；
2. **释放后自动迁回**（`tryTakeover()`）：并存期间订阅 `llm/adapters-updated`，官方行被
   删除时把注册迁到 `opencode-go`，**无需重启**。这一条是必要的——反向不迁移（接管后不再
   降级），因为迁移会让会话里已选中的模型 id 失效；而「官方行删除 → 迁回」正好相反：不迁
   的话，老会话里指向官方 `opencode-go/*` 的模型会失去 provider。
   可用性通过 `ctx.llm.listProviders()` 探测，而不是靠捕获注册异常（后者会在官方行存在期间
   每次拓扑提交都刷一条 warn）；
3. **卡片新增 `coexisting` 状态**（`client.js` 中英双语）：`并存 · opencode-go 官方路由保留，
   本插件在 opencode-go-pool 提供池`。

**实测**（隔离虚拟环境，内核 `0.2.0-rc.2`，探针每 4s 打印 `takeoverState()` 与
`llm.listProviders()`）：

| 阶段 | takeover | 实际服务 | provider 注册表 |
|---|---|---|---|
| 官方行存在 | `coexisting` | `opencode-go-pool` | `deepseek-official, deepseek-account, **opencode-go**, **opencode-go-pool**` |
| 在「设置 → 模型」删除官方行后（未重启） | `serving` | `opencode-go` | `deepseek-official, deepseek-account, **opencode-go**` |
| `routeConflict: wait` + 官方行存在（回归） | `waiting` | — | `…, opencode-go`（仅官方） |

`smoke.mjs` 21/21、`test/vision.test.mjs` 6/6 均通过。

## v0.1.17 —— Typert codec 契约迁移：桌面版（nightly）加载失败修复（2026-09-26）

**现象**：DSH 桌面版（nightly 渠道，内置 `dsh-typert-protocol >= 0.1.6`）安装本插件后启动即报：

```
加载失败: typert: dsh-opencode-go-pool#opencodePool/status result strict codec has no create() factory
```

**根因**：`dsh-typert-protocol@0.1.6`（deepseek-harness commit `e459e326`
「perf(typert): materialize generated schemas on first use」，2026-09-14 合入，
09-15 发布 alpha）把 strict codec 从 `{ mode: 'strict', typeSymbol, schema }` 改为
`{ mode: 'strict', typeSymbol, create: () => TypertSchema }` —— schema **首次使用时才物化**。
typert-loader 在插件激活时逐条校验 invocation 的参数/结果 codec
（`requireStrictCodec()`：`typeof codec.create !== 'function'` 即抛错），而本插件的
manifest 仍是 0.1.0-rc.5 时代的旧形状，第一个 invocation（`status` 的 result codec）
就撞上校验，**整个插件激活失败**。业务侧探针（`probeCoreImports()` / `selfCheck()`）
救不了它：manifest 校验发生在插件 body 运行之前、由 loader 执行，属于硬失败而非休眠。

**修复**（`typert.host.js`，一处，所有 invocation 共用）：

```diff
- const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema })
+ const strict = (typeSymbol, schema) => ({
+   mode: 'strict',
+   typeSymbol,
+   schema,             // 兼容 0.1.2-rc 时代 loader（dsh-typert-protocol ^0.1.0-rc.5）
+   create: () => schema, // >= 0.1.6 桌面契约：工厂返回可 parse 的 TypertSchema
+ })
```

zod v4 schema 自带 `parse()`，`create()` 直接返回它就是合法的 `TypertSchema`；
保留 `schema` 字段是为了新旧 loader 双兼容。**同时**把 peerDependencies 的
`@deepseek-ai/dsh-typert-protocol` 从 `^0.1.0-rc.5` 升到 `^0.1.7-rc.2`
（桌面 nightly 对应的 next 版本）。

**新增回归守卫**：`smoke.mjs` 第 6 项 —— 导入本包 `./typert` manifest，断言每个
invocation 的参数/结果 codec 都是 strict、带 `typeSymbol`、暴露 `create()` 且
`create().parse()` 可用。此类失败发生在插件 body 之前，探针看不到，必须由
manifest 自身的形状守卫拦下。

**验证**：
- 用桌面 app（`dsh-nightly`，`D:\software\dsh\resources\app.asar`）内**真实
  typert-loader**（`@deepseek-ai/dsh-typert-loader`）的 `validateTypertManifest()`
  校验本包 `./typert`：9 个 invocation **全部 PASS**；负向对照（旧形状、无 `create()`）
  被同一 loader 拒绝，报错正是本版修复的
  `… result codec has no create() factory`；
- `smoke.mjs` 第 6 项为后续回归守卫（加载类契约漂移的前置告警）；
- 路由接管 / 设置卡片 / Key 轮换的桌面全链路：**待桌面重启后实测**（见 README
  兼容矩阵，实测后更新）。

**已知后续（非本版范围）**：其余 `@deepseek-ai/dsh-*` peer（`dsh-credentials` /
`dsh-settings` / `dsh-llm` / `dsh-llm-pi-ai` / `dsh-api-remotes` 等）同样在 rc 期
快速迭代，老 peer 范围在全新安装时可能解析不到最新器件；按 README「稳定性」章节
锁 commit 安装，升级 DSH 后先跑 `smoke.mjs` 再信任。

## v0.1.18 —— 补上客户端 codec 契约：设置卡片「加载失败」的真正来源（2026-09-26）

**现象**：v0.1.17 安装后 host 侧已能挂载（loader 不再报错），但「设置 → OpenCode Go
套餐池」卡片仍显示：

```
加载失败: typert: dsh-opencode-go-pool#opencodePool/status result strict codec has no create() factory
```

**根因（v0.1.17 漏了客户端这一半）**：Typert 的 `create()` 契约在**客户端注册表**同样生效。
`client.js` 里设置卡片用手写 descriptor 挂载远程（`ctx.remote.$mount(TYPERT_REMOTE)`），
桌面版 `dsh-typert-registry/lib/client.js` 的 `validateCodec()` 会在挂载时校验每个
参数/结果 codec：

```js
validateCodec(descriptor.result, `${descriptor.id} result`);
// …
if (typeof codec.create !== "function")
  throw new Error(`typert: ${subject} strict codec has no create() factory`);
```

而 `client.js` 的 codec 仍是旧形状 `{ mode: 'strict', typeSymbol: 'json', schema: passthrough() }`
（无 `create()`）→ 第一个 descriptor（`status` 的 result）就抛错 → 卡片装配失败、显示
「加载失败」。v0.1.17 只修复了 host 侧 loader/注册表路径（`typert.host.js`），
客户端路径漏掉了；两条路径都必须满足新契约。

**修复**（`client.js`，一处 helper，全部 descriptor 共用）：

```diff
  const passthrough = () => ({ parse(value) { return value; } });
- const strict = () => ({ mode: 'strict', typeSymbol: 'json', schema: passthrough() });
+ const strict = () => ({ mode: 'strict', typeSymbol: 'json', schema: passthrough(), create: passthrough });
  // 参数 codec 也改走 strict()，不再内联写旧形状：
- parameters: parameters.map(p => ({ name: p, wire: p, source: 'json', codec: { mode: 'strict', typeSymbol: 'json', schema: passthrough() } })),
+ parameters: parameters.map(p => ({ name: p, wire: p, source: 'json', codec: strict() })),
```

`create: passthrough` —— `passthrough()` 返回 `{ parse(value) { return value } }`，
正是 `TypertSchema` 形状；保留 `schema` 字段兼容旧客户端装配。

**新增回归守卫**：`smoke.mjs` 第 7 项 —— `client.js` 是浏览器代码（React）无法在
node 里 import，改为**源形状守卫**：断言 codec helper 带 `create:`、参数 codec 统一
走 `strict()`、不存在内联的旧形状 codec。

**验证**：
- 用桌面 app.asar 内**真实客户端注册表**（`dsh-typert-registry/lib/client.js` 的
  `validateCodec` 逻辑）逐字对照：修复后 `create` 存在、校验通过；v0.1.17 的旧形状
  恰好触发你贴出的那句报错（`typert: <endpoint> result strict codec has no create() factory`）；
- 桌面实测：冷启动后设置卡片正常渲染、`status()` 与 Key 操作可用（待填实测结果）。

## v0.1.19 —— DSH 0.2.0-rc.2 适配：settings.register 已移除 + 写入落到错误条目（2026-09-30）

在桌面版 **0.2.0-rc.2**（内核 `@deepseek-ai/*@0.2.0-rc.2`）的**隔离虚拟环境**里复现、
修复并逐项实测。三处独立故障，任何一处都足以让插件“炸掉”：

### 1. 安装即被拒：peer 范围与 0.2.0 不兼容

**现象**（`dsh plugin add` 直接失败，插件根本没装上）：

```
dsh: installation rejected: Plugin dsh-opencode-go-pool@0.1.18 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-typert-protocol":"^0.1.7-rc.2",
"@deepseek-ai/dsh-credentials":"^0.1.0-rc.5", …}
```

**根因**：`dsh-app-boot` 的 `evaluatePluginCompatibility()` 逐个校验
`@deepseek-ai/dsh*` peer：

```js
semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
```

`^0.1.0-rc.5` 展开为 `>=0.1.0-rc.5 <0.2.0`，`0.2.0-rc.2` 落在 `<0.2.0` **之外**；
而 v0.1.17 把 typert-protocol 收紧到 `^0.1.7-rc.2`，连 0.2 线都够不着。

**修复**（`package.json`，6 个 peer 全部改为）：

```diff
- "@deepseek-ai/dsh-typert-protocol": "^0.1.7-rc.2",
+ "@deepseek-ai/dsh-typert-protocol": ">=0.1.0-rc.5 <0.3.0-0",
```

`<0.3.0-0` 的上界写法（而不是 `<0.3.0`）是为了让**预发布版本参与区间判断**：
实测该范围同时匹配 `0.1.0-rc.5 / 0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.2 / 0.2.0-rc.1 /
0.2.0-rc.2 / 0.2.0 / 0.2.1`，并排除 `0.3.0`——一条范围覆盖两条内核线，不必随 rc 反复改。

### 2. `settings.register()` 在 0.2.0-rc.1 被移除 → 插件静默休眠

**现象**：安装通过、宿主正常启动、**没有任何报错**，但池功能全废（不接管路由）。
启动日志里只有两行 warn：

```
[opencode-go-pool] integration probe failed — plugin stays dormant:
  settings service: register missing (settings absent or renamed)
[opencode-go-pool] settings namespace unavailable — plugin stays dormant: …;
  settings.register threw: ctx.settings.register is not a function
```

**根因**：0.2.0-rc.1 把设置模型换成 `SettingsForms`（`configure()/describe()`）：
插件配置现在**就是它自己的 profile 条目**，读写走「Fiber config + configEditor 服务」，
不再有 `settings.register()` 返回的 scope。

**修复**（`index.js`）：

```diff
- this.scope = ctx.settings.register(NS, Config, { base: config ?? {}, validate: validateSection })
- this.current = () => this.scope.get()
- this.scope.watch(() => this.applyConfig())
+ this.current = () => this.resolvedConfig()      // Fiber config + 写后覆盖层
…
- await this.scope.update({ keys })
+ await this.writeConfig({ keys })
```

- `resolvedConfig()`：读取构造期拿到的 Fiber config（volatile 字段是 ref，用 `.get()`），
  再回灌一次 `Config(raw)` 补齐条目里没写的字段——这样一次写入能持久化**完整一行**，
  不会把没碰过的键写丢；
- `writeConfig(patch)`：经 `ctx.get('configEditor').edit(entry, () => next)` 写入
  profile 的 `cordis.patch.yml`（与内置「设置 → 模型」页同一条缝），Loader 随即带新配置
  重启插件；写后先落到 `configOverride` 并立即 `applyConfig()`，重启落地前就已生效；
- 写入**串行化**并识别 `HMR transactions cannot be nested` 重试一次（一次写入 = 一个 HMR
  事务，连点两次卡片动作会撞上）；
- 另加 `ctx.inject(['settings'], child => child.settings.configure({ auto: false }, ctx.fiber))`，
  与 `llm-pi-ai` 一致：抑制外壳为插件条目自动生成的表单（卡片是插件自己的）。

### 3. 配置写到了**别的插件**头上：远程调用里 `this.ctx` 会被调用派生上下文遮蔽 ★

**现象**（v0.1.19 前两处修好后暴露）：卡片操作看似成功，但 profile 文件里长出来的是：

```yaml
- id: typert-gateway                    # ← 应该是 opencode-go-pool！
  name: "@deepseek-ai/dsh-api-gateway"
  config:
    route: opencode-go
    keys: [ … ]
```

**根因**：Typert Gateway 调用 Remote 方法时会创建一个**调用派生 Context**，
它遮蔽了 Service 自己的 `ctx`——于是 `this.ctx.fiber.entry` 在远程方法里指向
**网关的条目**。诊断输出把两件事同时钉死：

```
[DIAG] ctorEntry=opencode-go-pool callEntry=typert-gateway ctxIsOwn=false
```

**修复**（`index.js`）：构造期固化插件自身上下文与条目，凡「必须属于本插件」的操作
（条目查找、adapter 注册、凭据访问）一律用固化值：

```diff
  super(ctx, 'opencodePool')
+ this.ownerCtx = ctx
+ this.entry = ctx.fiber?.entry ?? null
…
- const entry = this.ctx.fiber?.entry
+ const entry = this.entry ?? this.ownerCtx.fiber?.entry
- this.registration = this.ctx.llm.registerAdapter([route], this.poolAdapter)
+ this.registration = this.ownerCtx.llm.registerAdapter([route], this.poolAdapter)
```

### 4. `smoke.mjs`：非 ASCII 安装路径下的假失败

`packageVersion()` 用 `import.meta.resolve(pkg).replace(/^file:\/\//, '')` 取路径——
`file://` 剥离后仍是**百分号转义**形式，路径里含中文（`~/存储/AI_code/…`）时
`existsSync` 全部落空，于是 `@earendil-works/pi-ai` 被误报成
`package not found from this location`。改用 `fileURLToPath()`：

```diff
- entry = import.meta.resolve(pkg).replace(/^file:\/\//, '')
+ entry = fileURLToPath(import.meta.resolve(pkg))
```

> 旧版之所以没暴露：`@deepseek-ai/*` 能走 `require.resolve` 分支，只有
> `@earendil-works/pi-ai`（exports 无 `require` 条件）才会落到 ESM 兜底分支。

### 验证（全部在隔离虚拟环境，DSH 0.2.0-rc.2）

用 `@deepseek-ai/dsh@0.2.0-rc.2`（npm `latest`，与桌面版内核同版本）建独立
`DSH_HOME`，`dsh plugin --profile web add file:<checkout>` 真实安装后：

| 验证项 | 结果 |
|---|---|
| `dsh plugin add` | 通过（不再被 peer 门槛拒绝），bundle 自动挂载 |
| 宿主启动 | 无插件错误；`typert-loader` 成功导入 `./typert`（zod 解析） |
| `smoke.mjs` | **21/21 PASS**（含 `create()` 契约、profile 契约、vision、客户端 codec 形状守卫） |
| 路由接管 | `status().takeover = "serving"`，`opencode-go` 已接管，暴露 30 个模型 |
| 浏览器端到端 | Playwright 打开真实 Web UI：卡片渲染正常（**不再「加载失败」**）、0 控制台错误 |
| Key 新增（UI） | `putKeys` → 写入 `cordis.patch.yml` 的 `- id: opencode-go-pool`、自动生成凭据引用、`in use`、401 检测生效 |
| 策略保存（UI） | `preempt=85 / consec=3` 保存后刷新仍在 |
| 宿主重启 | 配置与 Key 全部保留，路由继续接管 |
| 反例（修复前） | 同一条旅程写入落在 `- id: typert-gateway`，即上面的第 3 条 |

### 已知迁移事项（升级到 v0.1.19 必读）

- **Key 列表搬家了**：旧版的 Key 存在设置文档的 `opencode-go-pool` 节
  （`$DSH_HOME/settings.yaml`，被 0.2.0 重命名为 `settings.yaml.imported`），
  新版存进 profile 的 `cordis.patch.yml` 条目。升级后卡片初始会是空的，
  需要把 `settings.yaml.imported` 里 `opencode-go-pool: keys:` 的三元组
  （`id` / `label` / `apiKeyEnv`）照抄到新条目，或在卡片里重新添加一遍
  （**Key 明文仍在凭据库里，不用重新粘贴**）。
- **`apiKeyEnv` 引用名不能忘**：密钥明文始终在
  `$DSH_HOME/.credentials.yaml` / 环境变量里，插件配置只存引用名。

## 安装（DSH）

> **v0.1.13 起自动挂载**：`dsh plugin add` 后插件自动进入 profile bundles，无需
> 下面的手工挂载（保留手工行会被用户层覆盖 bundle 默认配置，建议删除）。

```sh
# 仓库就绪后安装（GitHub 源，锁 commit）：
dsh plugin --profile web add github:join123-bit/dsh-opencode-go-pool#<sha>
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 挂载（注意：新版 loader 必须用 `insert:` 格式，
上游 README 里的裸行格式在 0.1.2 上不会生效）：

```yaml
- insert:
    - id: opencode-go-pool
      name: 'dsh-opencode-go-pool'
      config:
        route: opencode-go
        keys: []          # 到「设置 → OpenCode Go 套餐池」页面添加 Key
        preemptAtPercent: 100
        modelMode: all
        models: []
        headers:              # 官方路由有 headers 时必须带过来，否则可能变慢
          x-opencode-session: dsh-opencode-go-session
        usageBaseUrl: https://opencode.ai/zen/go/v1/usage
        usageRefreshMs: 30000
        timeoutMs: 15000
```

配套步骤：

1. 重启 DSH；
2. 「设置 → 模型」删除 `opencode-go` 供应商行（本插件自动接管该路由）；
3. 「设置 → OpenCode Go 套餐池 → Key 管理」添加每个套餐（`apiKeyEnv` 填环境变量/凭据引用名）；
4. 明文 Key 填到凭据页（设置 → 模型 → 凭据）或 `~/.dsh/.credentials.yaml`。

## 与上游同步

上游更新时：`git fetch upstream && git checkout upstream/main -- index.js` 后重新打上面两行补丁，
或直接以本仓库为主，手动 cherry-pick 上游改动。

## License

MIT（沿用上游）。多账号轮换请自行确认符合 OpenCode Go 服务条款。