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

## 安装（DSH）

```sh
# 仓库就绪后安装（GitHub 源）：
dsh plugin --profile web add git+https://github.com/join123-bit/dsh-opencode-go-pool.git
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