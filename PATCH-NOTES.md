# dsh-opencode-go-pool —— DSH 0.1.2 兼容补丁版

本仓库是 [whitelonng/dsh-opencode-go-pool](https://github.com/whitelonng/dsh-opencode-go-pool)（MIT 协议）v0.1.10
的 **0.1.2-rc.x 兼容补丁版**，用于个人/团队自用。功能与上游一致：

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