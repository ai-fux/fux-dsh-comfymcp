# 迭代计划（MVP Roadmap）

> 版本规约：三段 `X.Y.Z`（平台 SEMVER 限制）；分支规约：`snapshot-<version>` 稳定主分支 / `dev-snapshot-<yyyyMMdd>-<version>` 迭代分支。

## snapshot-0.4.0（功能迭代，2026-10-16）

> 开发分支 `dev-snapshot-20261016-0.4.0`（自 0.3.1 分支拉取）；插件 `plugins/dsh-comfymcp-client` 版本 0.4.0。

**MVP 主题：业务配置增强包——命中业务类时表单标题直接亮出业务类；多工作流候选按「成功率/最近使用」智能排序并支持自动换主；业务级参数预设集一键套用（工作台 + 模型侧双端）。**

| # | 迭代内容 | 落位 | 状态 |
| --- | --- | --- | --- |
| 1 | **命中业务类 → 表单标题提示**：`comfymcp_business match` 命中后记录 `lastBusinessMatch`，`comfymcp_push_form` 的标题自动以业务类显示名开头（如「文生图 · 白色机甲 · 生成参数」），用户在表单上第一眼就看到这次按哪个业务类跑；模型自己写了同名开头则不重复拼；match 的 nextSteps 同步提示。技能文本同步（title 规则 + 不重复拼） | `lib/catalog.js`（`lastBusinessMatch`）、`lib/skills.js` | ✅ |
| 2 | **候选智能排序 + 自动换主**：新增 `workflowOutcomeStats`（只认 completed/failed，running/aborted 不计）与 `businessRanking`（得分 = 成功×3 + 使用 − 失败 +（成功过再 +1），快捷指令连跑的「名字-N」后缀并入同前缀统计）。`autoRegister` 带入近期运行记录后支持**自动换主**：仅 `auto=true` 的配置参与，候选至少成功 2 次且得分超过主配置 3 分才提升，原主退回候选（source=demoted）；手动配置永不自动改。工作台业务卡新增候选条（带 ✓/✗ 战绩，点击「设为主配置」）与 `promote` 手动换主 | `lib/business.js`、`lib/workbench.js`（`runPage` 传 runs、`promoteBusiness`）、`lib/wfpage.js`（候选条）、`lib/control-server.js`（`/api/business/promote`） | ✅ |
| 3 | **业务级参数预设集**：profile 新增 `presets`（≤12 条：id/名称/params/createdAt，同名覆盖、空参数拒绝，UI 保存合并不丢）。存储侧 `savePreset`/`removePreset`（按 id 或名称删）；模型侧 `comfymcp_business` 新增 `preset_save`/`preset_remove`，match 命中时 `matched.presets` 一并带出（两路 nextSteps 都提示），register 可带 `presetName` 顺手把本次参数存成预设；工作台业务卡新增「参数预设」chip 行（一键套用进参数区 / ✕ 删除 / ＋存当前参数为预设），工作流页在属于某业务配置时渲染「业务预设」条（按复合键末段字段名匹配，一键把成套参数填进表单，checkbox 特判）；技能文本说明用户点名预设就用其 params 当推荐值 | `lib/business.js`、`lib/catalog.js`、`lib/workbench.js`（`saveBusinessPreset`/`removeBusinessPreset`、`pageWorkflow` 带 presets）、`lib/wfpage.js`（预设 chip + 预设条 + `BIZ_PRESETS` 下发）、`lib/control-server.js`（`/api/business/preset/*`）、`lib/skills.js` | ✅ |
| 4 | **版本对齐**：插件 `index.js` / `package.json` 与工程根 `package.json` 同步 0.4.0 | `index.js`、两处 `package.json` | ✅ |
| 5 | **测试回归**：新增 16 项断言/用例（预设集存删与合并保留、战绩统计边界、排序计分、自动换主三态、手动换主、promote/preset 路由成功与拒绝、push_form 标题四态、register 带 presetName、业务页/工作流页渲染与脚本体检）；页面体检 2 脚本扩展（预设/候选监听） | `test/business.test.js`、`test/catalog.test.js`、`test/workbench.test.js`、`test/wfpage.test.js`、`test/skills.test.js`、`test/control-server.test.js`、`scripts/check-page-*.mjs` | ✅ |

**校验（2026-10-16）**：`verify:dsh-plugin` 语法 OK（14 文件）· 插件 vitest **231 例全绿**（20 文件，含本次 +16）· comfy-mcp-server 13 例 / mcp 5 例全绿 · 双包 `tsc --noEmit` 通过 · 两组件 `--selftest` OK · 页面体检（脚本语法 + 关键监听 / 模板完整性）通过。

**迁移提示**：宿主改动需**重启 DSH** 加载（长驻进程 ESM 冻结）。重启前运行中的仍是 0.3.1：命中提示、预设条、候选条要等重启后才出现在实际页面/工具里；数据结构向后兼容（business.json 旧文件自动补 presets，无迁移动作）。

## snapshot-0.3.1（小修迭代，2026-10-16）

> 开发分支 `dev-snapshot-20261016-0.3.1`（自 `dev` 拉取）；插件 `plugins/dsh-comfymcp-client` 版本 0.3.1。

**MVP 主题：修「开发模式（devMode）配置无法保存、无法即时测试」。用户在设置页打开开发模式并保存后，开关永远弹回关闭、`comfymcp_dev` 始终报 `devMode:false`。**

| # | 修复内容 | 落位 | 状态 |
| --- | --- | --- | --- |
| 1 | **根因①（保存被静默丢弃）**：设置页保存的 patch 经 `sanitizeOverlayPatch` 白名单过滤，而 `OVERLAY_KEYS` 漏了 `devMode` → 开关写入覆盖层前被丢掉（实测 `POST /set-config {"devMode":true}` 返回 ok 但落盘与 applied 均为 false）。补入白名单，布尔 true/false 均可落盘 | `lib/persist.js` | ✅ |
| 2 | **根因②（保存后仍不生效/不能测）**：devMode 在激活时被捕获成布尔快照（`createDevLog`/`createTools`），`applyOverlay` 更新了 `bridge.config.devMode` 但工具与日志的指引永远用旧值 → 活值化：`devMode` 参数支持「活值函数」，`comfymcp_dev` 与报告 `guidance` 按调用时取值，保存后即时生效、无需重启；旧布尔参数保持兼容 | `lib/catalog.js`（`isDevMode`）、`lib/devlog.js`、`index.js` | ✅ |
| 3 | **根因③（UI 脏标记失灵）**：设置页 `isDirty()` 键表与 draft 初始态都漏了 `devMode` → 拨动开关不显示「有未保存的改动」；补齐并把「⑧ 开发模式」提示更新为「保存后即时生效（写入覆盖层，重启后仍保持）」 | `client.js` | ✅ |
| 4 | **版本对齐**：`index.js` 导出版本 0.2.1 与 `package.json` 0.3.0 不一致（违反版本规约），一并修正为 0.3.1（工程根 package.json 同步） | `index.js`、两处 `package.json` | ✅ |
| 5 | **测试回归**：overlay 白名单保留 devMode（true/false）+ 落盘回读；`applyOverlay({devMode})` 原地即时生效；活值函数 devMode 报告/指引切换；`comfymcp_dev` 读运行时 devMode（bridge.config 翻转后响应跟着变） | `test/rpc.test.js`、`test/bridge.test.js`、`test/devlog.test.js` | ✅ |

**迁移提示**：宿主半区改动需**重启 DSH** 加载（长驻进程模块按进程冻结，`set_plugin` 禁用/启用不会重载 ESM）。已在 `config-overlay.json` 手工补写 `"devMode": true`（用户原意图），重启后开发模式即从激活起生效；此后在设置页保存的 devMode 不再丢失。

**校验（2026-10-16）**：`pnpm verify:dsh-plugin` 语法 OK · 插件 vitest 215 例全绿（20 文件，含本次 +4 断言）· 工程全仓 `pnpm test` / `pnpm typecheck` 通过。

**复验（2026-10-16，重启后）**：控制端点 `/health` 报 version 0.3.1（新代码已加载）→ `POST /set-config {"devMode":true}` → `/config` 回读 true → 落盘 overlay true → `comfymcp_dev` 不重启即时报告 `devMode:true`（活值化生效）。已合并回 `dev`（merge 1d4c4f2）并打 tag `v0.3.1`。

## snapshot-0.3.0（稳定，2026-10-15 封板）✅

> 开发分支 `dev-snapshot-20261015-0.3.0` → 已合并回 `dev`，打 tag `v0.3.0`；插件 `plugins/dsh-comfymcp-client` 版本 0.3.0。

**MVP 主题：首次生成的工作流选择优化（业务配置）——把「跑过 / 加载过」的工作流按业务类沉淀成配置，后续会话用自然语言直接命中，不再每次捞模板 / 枚举模型烧 token；并随之补齐工作流候选来源、参数随工作流动态化、业务类动态增删、插件开发模式与设置页手风琴。**

| # | 迭代内容 | 落位 | 状态 |
| --- | --- | --- | --- |
| 1 | **业务配置存储与推断**：`lib/business.js` 新增 8 个预置业务类（文生图 / 图生图 / 文生视频 / 图生视频 / 局部重绘 / 放大 / 音频 / 其它）+ `inferBusiness(graph)`（按输出与输入模态判定：视频输出＋图像输入＝图生视频，纯文本＝文生视频/文生图，含 inpaint 节点＝局部重绘，只放大不采样＝放大）+ `extractBusinessParams(graph)`（摘 steps/尺寸/生成数/cfg/采样器/模型，找不到不猜）+ `createBusinessStore`（`<dataDir>/business.json`，一个业务类一条主配置 + candidates 候选） | `lib/business.js`（新）、`test/business.test.js`（新） | ✅ |
| 2 | **自然语言匹配**：`matchBusiness(text, profiles)` 打分——自定义触发词 > 业务类名 > 预置触发词，中文多字插入用「最长公共子串 + 覆盖率打折」兜底（「做个视频」不再误判成图生视频），再加模态微调（提到图 → 图输入类加分）。实测 9 组口语命中全对，无关句子返回 null | `lib/business.js`、`test/business.test.js` | ✅ |
| 3 | **模型侧工具 `comfymcp_business`**（开工第一步）：`match` 传用户原话 → 命中返回 workflow/params/keywords，本地 API 图直接附上 `graph`（省一次取图）；`register` 跑通后回写（可带 graph 自动判业务类）；`list`/`save`/`remove` 手工增删。技能首步改为「先查业务配置」，命中即跳过后面的模板检索与模型枚举 | `lib/catalog.js`、`lib/skills.js`、`test/catalog.test.js` | ✅ |
| 4 | **自动登记**：工作台运行页每跑一次（`runPage`）就按推断出的业务类建档/记使用；同业务类已有主配置时不抢占，只把这次的工作流记进 candidates，供工作台一键切换 | `lib/workbench.js`（`runPage` 钩子）、`test/workbench.test.js` | ✅ |
| 5 | **工作台「业务配置」Tab**（第 5 个 Tab）：卡片式编辑（业务类下拉 / 显示名 / 首选工作流（datalist 提示已有工作流）/ 触发词 / 参数覆盖 / 备注），页脚显示用过多少次与最近使用、自动登记还是手动；顶部「已跑过但还没登记的工作流」候选行支持一键登记；工具栏 ＋新增 / 保存配置 | `lib/wfpage.js` `renderBusinessHtml`、`lib/control-server.js`（`/ui/business` + `/api/business/*`）、`client.js`（第 5 个 Tab）、`scripts/check-page-*.mjs` | ✅ |
| 6 | **业务类动态配置（不写死）**：原先业务类是代码里的 8 条常量，加新业务得改代码 → 改为**业务类与配置一起落盘**（`business.json` 的 `kinds`，首次读取用内置预置类播种）：工作台「业务配置」页顶部新增**业务类管理条**——一行 chip 列出当前全部业务类（点 ✕ 删除，仍被配置引用时拒绝并说明原因），右侧「名称 + 触发词 + ＋ 添加业务类」即时新增；卡片下拉与模型侧匹配都用这份存储清单，新增后立刻生效（例：加「换脸／触发词 换脸、faceswap」→ 说「把这张照片换脸」即命中）。工具侧同步支持 `action=kind_save` / `kind_remove`，id 由名称规整（中文/空格/标点折成连字符） | `lib/business.js`（`DEFAULT_BUSINESS_KINDS`/`saveKind`/`removeKind`/`normalizeKindId`/`matchBusiness(text, profiles, kinds)`）、`lib/workbench.js`、`lib/control-server.js`、`lib/wfpage.js`、`lib/catalog.js`、`test/business.test.js` | ✅ |
| 7 | **工作流候选「没有数据」修复 + 参数随工作流动态变化**（用户回图）：①原下拉只有一个来源，实测常常空 → 改为合并**四个来源**：跑过的（运行记录，最贴预期）/ 本地工作流文件 / 服务端（我的工作流 + 模板库）/ 已配置引用过的，去重后带 origin 分组；页面用具名 `<optgroup>` 的 **select**（不再用看不出数据的 datalist），工具栏显示「可选工作流 N 个（跑过的 x · 本地文件 y · 我的工作流 z · 模板库 w）」便于一眼诊断；当前值不在清单里时补「当前值」分组保证能显示。②参数区原来写死 5 个静态输入框 → 新增 `businessSchema`（按工作流读图：本地 API 图直读 / 远端走 get_workflow）+ `extractBusinessParamFields`（只列图里**真实存在**的参数、当前值与来源节点），页面在**选择工作流时 / 首屏 / 点「⟳ 读取该工作流参数」**重建参数区：换工作流 ⇒ 参数项与占位值随之变化，留空＝沿用工作流当前值 | `lib/business.js`（`extractBusinessParamFields`/`BUSINESS_PARAM_LABELS`）、`lib/workbench.js`（`knownWorkflows`/`businessSchema`）、`lib/control-server.js`、`lib/wfpage.js`、`scripts/check-page-scripts.mjs`、`test/devlog.test.js` | ✅ |
| 8 | **开发模式开关（devMode，默认关闭）**：默认**严禁修改任何插件源码**，必须遵循插件规则执行；开启后允许大模型在交互中自主排查并修复插件、生成日志报告。实现：①`lib/devlog.js`（环形缓冲 + `<dataDir>/dev-log.jsonl`，按内容去重、写盘失败不影响主流程）；②所有工具（`defineTool` 包装 12 个）异常自动入日志、控制端点 500 也入日志；③新工具 `comfymcp_dev`（`report` 按级别/来源汇总 + 最近错误明细 + 复现线索、`note` 记录发现、`clear` 清空），报告的 `guidance` 按 devMode 给出「可改代码 / 严禁改代码」两种指引；④配置项 `devMode`（默认 false，进布尔白名单）贯通设置页「开发模式」开关与技能规则 | `lib/devlog.js`（新）、`lib/catalog.js`、`lib/control-server.js`、`lib/config.js`、`index.js`、`client.js`、`lib/skills.js`、`test/devlog.test.js`（新） | ✅ |
| 9 | **设置页重排 + 业务配置去掉历史栏**（用户回图）：①设置项按「连接 → 目录 → 运行 → 交互 → 存储 → 开发」重排为 **8 个编号分区**（①连接与服务 ②工作流目录 ③插件目录与产物 ④运行行为 ⑤快捷指令 ⑥文件存储 ⑦表单与交互 ⑧开发模式），同类项合并（MCP 宿主入口并入①；模型卸载与最大运行时间合并为④；产物下载/镜像目录并入②③），顶部新增**分区导航条**（点一下跳到该分区），每区描述重写为「这一区管什么、改了会怎样」。②业务配置页**取消「已跑过但还没登记」历史栏**——新增/编辑时工作流下拉已能直接选（候选含跑过的），历史栏只是重复噪音；同时**只列能真正打开的工作流名**：先收集本地文件 + 服务端（我的工作流/模板库）作为可解析集合，跑过的名字命中才标「跑过的」并排首位，解析不了的隐藏，工具栏提示「另有 N 个仅有运行记录、没有对应工作流文件（已隐藏，避免选了打不开）」——这正是上次「读取该工作流参数 → 工作流不存在」的根因 | `client.js`（`SettingsNav`/8 分区）、`lib/wfpage.js`（去候选栏 + 工具栏计数）、`lib/workbench.js`（`knownWorkflows` 返回 `{list, hiddenRuns}`）、`scripts/check-page-scripts.mjs`、`docs/operations.md` | ✅ |
| 10 | **设置页改手风琴（一次只开一个区域）**（用户要求：配置太长要缩短，快捷跳转可取消）：上一版 8 个分区全展开、还要靠顶部分区导航条跳转 → 改为 **accordion**：标题行常显可点（▸/▾，支持 Enter/Space 键盘开合），**正文只在展开时渲染**，同一时刻只开一个区域（默认开①，再点标题收起）。为让收起态也看得懂，每区加**摘要**：①「内置服务 · http://127.0.0.1:8000」② 工作流目录值 ③ 当前布局 ④「跑完卸载模型 · 30 分钟上限」⑤「内置「抽卡」/已自定义」⑥「本地目录 / MinIO / OSS」⑦「倒计时 30 秒自动采用推荐值」⑧「关闭（严禁改插件源码）」。分区导航条与 `SETTINGS_GROUPS`/`SettingsNav` 一并删除。**踩坑**：包装组件若在组件体内每次渲染新建（`var Section = function …`），React 会视为新组件类型并重挂载子树——**打字会丢焦点**；改用 `react.useCallback(…, [openSection])` 稳定身份 | `client.js`（`SettingsSection` 手风琴化 / `Section` 包装 / `sectionSummary` / 删导航）、`docs/operations.md` | ✅ |

**下个迭代候选**：业务配置的「优先命中提示」（命中时在表单标题里显示业务类）、多工作流候选排序（按成功率/最近使用自动选主配置）、业务级参数预设集、节点连线式画布。

**封板校验（2026-10-15）**：插件 212 项测试全绿（20 个测试文件）· 页面模板体检 5 页完整 · 页面脚本体检 4 页语法 OK 且关键监听齐全（含业务配置页的 8 项）· 全仓 `pnpm test` 通过 · 无头浏览器逐项截图核对（工作流分组下拉 / 业务类动态增删 / 参数区随工作流重建 / 设置页 8 区手风琴）。

## snapshot-0.2.1（稳定，2026-10-15 封板）✅

> 开发分支 `dev-snapshot-20261013-0.2.1` → 已合并回 `dev`，打 tag `v0.2.1`；插件 `plugins/dsh-comfymcp-client` 版本 0.2.1。

**MVP 主题：配置界面精简 + 模型卸载开关语义修正；追加工作台 UI 打磨（瀑布流/卡片/灯箱/参数框）。**

| # | 迭代内容 | 落位 | 状态 |
| --- | --- | --- | --- |
| 1 | 配置界面精简：长提示文案统一收进「ⓘ」悬浮 tips（字段、开关、分区标题皆可），去掉常显说明段落；标签与占位文案收紧（如「ComfyUI 服务地址」→「ComfyUI 地址」、「comfy-mcp 服务来源」→「服务来源」） | `client.js`（`Hint` 组件 + 各 SettingsSection） | ✅ |
| 2 | 目录布局改为一行「当前布局」链接行（主目录 ｜ 工作流 ｜ 产物 ｜ 数据），不再常显四段拼接说明 | `client.js` `layoutSummary()` | ✅ |
| 3 | **模型卸载开关语义修正**：关闭时**移除工作流自带的卸载节点**（此前只做「插入」，工作流文件自带 `UnloadAllModels` 时关闭也照样卸载） | `lib/forms.js` `stripUnloadNodes/unloadNodeIds`、`lib/runcore.js` | ✅ |
| 4 | 开启时若工作流已含卸载节点则**沿用不再重复插入**（`already present`），运行记录 `form.unload.reason` 说明实际处置 | `lib/forms.js` `integrateUnloadNode` | ✅ |
| 5 | 卸载开关行补运行期状态说明（置灰原因 / 是否整合 / 已移除几个节点） | `client.js` 模型卸载段 | ✅ |
| 6 | 测试：卸载节点移除与沿用两路（表单层 3 例 + 边界） | `test/forms.test.js` | ✅ |

| 7 | **远程传输改造**：远程模式不再 spawn 本地 stdio 宿主，改用 **MCP Streamable HTTP 直连**端点（单端点 POST + JSON/SSE 双响应形态 + Mcp-Session-Id 会话 + Bearer 令牌）；宿主工具名（connection_status / list_remote_tools / call_remote_tool / fetch_artifacts）经门面翻译成原生工具，上层无感 | lib/mcp-http.js、lib/bridge.js | ✅ |
| 8 | 修远程报错根因：探测曾对**远程模式**也强制要求 hostEntry（必然报「宿主入口未配置」）；现在仅内置/stdio 模式要求，远程报传输/端点错误 | lib/bridge.js probe() | ✅ |
| 9 | 配置切换即时生效：embeddedServer / endpoint / authToken 变化时丢弃旧客户端并重建（此前一直复用旧 stdio 子进程） | lib/bridge.js applyOverlay() | ✅ |
| 10 | 设置页：远程模式显式标注「Streamable HTTP」，新增「访问令牌」；传输/会话与宿主入口按模式分开展示 | client.js | ✅ |
| 11 | 测试：HTTP 客户端 6 例（JSON/SSE、会话头、Bearer、连接失败/超时/无端点、门面翻译）+ 桥接 4 例（传输选择、远程探测、切换重建） | `test/mcp-http.test.js`、`test/bridge.test.js` | ✅ |
| 12 | **表单倒计时自动确认**：新增 `autoAcceptForm`（默认关）+ `autoAcceptFormSec`（默认 30s）；开启后推送参数表单即启动倒计时，首题标注「⏱ N 秒内未作答将自动采用推荐参数」，超时未作答自动以推荐参数完成（空 answers＝种子沿用推送时随机值、其余保持推导值），结果标 `auto:true` 与 `autoReason`；关闭则一直等待用户作答 | `lib/catalog.js` `comfymcp_push_form`、`lib/config.js`、`lib/persist.js` | ✅ |
| 13 | **卸载开关语义落地强化**（目的定稿：开启＝跨工作流生成方便重新加载模型；关闭＝同一工作流连续生成抽卡时模型热加载加速）：设置页说明改写为该语义；运行摘要透出 `autoUnload` 与 `form.unload`，运行卡片新增「⏏ 卸载：…（开关＝开/关）」处置行 | `client.js`、`lib/rund.js` `summarize`、`lib/wfpage.js` `groupHtml` | ✅ |
| 15 | 测试 +6：倒计时超时自动确认（fake timers，验证提示注入/auto 标记/空答案）、关闭时正常等待、先答先胜（计时器清理）；`summarizeRun` 卸载透出与旧记录兼容 | `test/catalog.test.js`、`test/rund.test.js` | ✅ |
| 16 | **修倒计时「开启后未生效」**：提示原先写在 ask 对话框不渲染的 `detail` 字段 → 移入首题 `question` 文本（「⏱ N 秒内未作答将自动采用推荐参数并继续执行；本框可留空」）；重装插件后需重启 DSH 才加载新逻辑 | `lib/catalog.js` | ✅ |
| 17 | **快捷指令 Tab（第 4 个 Tab）**：`/ui/commands` 结构化管理指令（名称/标签/生成数/模式/种子策略，增删行、保存即写回配置，就地「▶ 执行」），不再手写 JSON；DSH 面板同步为四 Tab | `lib/wfpage.js` `renderCommandsHtml`、`lib/workbench.js` `pageCommands/saveQuickCommands`、`lib/control-server.js`、`client.js` | ✅ |
| 18 | **抽卡多生成数**（缺省 1）：指令新增 `count` + `batchMode`——`serial` 连续调 N 次（每次重滚种子，第 1 次即启，其余后台链式补跑）；`batch` 批次生成（直接改图中 `batch_size=N` 一次执行，无该字段则提示改用连续） | `lib/quick.js` `applyBatchSize`、`lib/workbench.js` `quickRun/chainSerialReruns` | ✅ |
| 19 | 测试 +9：quick 指令解析钳制、批次改写与边界；串行链（3 次全启动且种子互异）、批次单跑、无批次字段回退提示、saveQuickCommands 归一化落盘、指令页渲染；页面体检补 commands 页 | `test/quick.test.js`、`test/workbench.test.js`、`scripts/check-page-templates.mjs` | ✅ |
| 20 | **修「其他会话场景无倒计时」**：截图中无倒计时的对话框是模型自发的 ask_user_question 追问（页眉/正文为模型拟写），不经过插件、技术上不可安全劫持 → ①`comfymcp_status.config` 透出 `autoAcceptForm`+`autoAcceptFormSec`；②生成流技能硬性规约：策略开启时**禁止**独立追问对话框，一切澄清选择并入 push_form 表单（推荐项第一位）由倒计时兜底，`auto:true` 直接继续不重复提问 | `lib/bridge.js` `publicConfig`、`lib/skills.js`、`test/bridge.test.js`、`test/skills.test.js` | ✅ |
| 21 | **倒计时全面可见化（读取 DSH 宿主源码定案）**：①push_form 改走 seam `askTimed(callId, N*1000)`——**提问卡片自带可见倒计时**，到期返回 pending（问题仍可后答，迟到回答以用户消息送达），旧 seam/非根代理回退本地竞速守卫（双保险）；②新增 preset 覆盖 bundle `dsh-preset-timed-ask`：把 shipped `preset-standard` 的 tool-ask-user 切 `mode: timed, timeout: 30`——**所有** ask_user_question 卡片 30 秒可见倒计时、到期 pending 不阻塞（`timeout:-1` 可阻塞）；③技能同步 timed 语义（pending=按推荐项继续；策略关闭时模型显式传 `timeout:-1`） | `lib/catalog.js`、`index.js`、`lib/skills.js`、`dsh-preset-timed-ask/`（新 bundle） | ✅ |
| 22 | **卸载开关处置核验**：实测运行中进程 `autoUnloadModel=false` 已生效、`runCore` 关闭时摘除工作流自带 UnloadAllModels 节点逻辑本就存在（昨日记录为旧进程产物）——补 3 条 runcore 集成测试钉死「关＝保存的图真的没有卸载节点、开＝输出链插入卸载节点」；用户昨日所见「取消未生效」源于旧进程 + 旧记录，今日进程已正确 | `test/runcore.test.js` | ✅ |
| 23 | **成果物瀑布流改为从左侧起排**：根因＝页面容器 `.wrap{max-width:860px;margin:0 auto}` 居中，单卡片看起来「从中间开始」→ 新增 `.wrap.wide` 全宽左对齐（成果物/指令页启用），瀑布流由固定 `column-count` 改为 `column-width:300px` 自适应列数（列宽固定、列数随窗口、始终左起），两列平铺同步 `auto-fill minmax(300px,1fr)+justify-content:start`；无头浏览器截图实测：单卡片左边缘 x=20（原 x=267） | `lib/wfpage.js` `pageShell(wrapClass)`/`ARTIFACTS_CSS`、`test/wfpage.test.js` | ✅ |
| 24 | **指令页 UI 重做（卡片式）**：原横向表格 8 列在窄容器里溢出（位数/补偿位列被切、操作列需横滚）→ 改为每条指令一张卡：卡片头（名称 + ▶ 执行 + ✕ 删除）、带标签字段网格（名称/标签/生成数/模式/种子策略）、**按种子策略只显示相关参数**（范围→最小值/最大值、位数→位数、时间戳→补偿位，不再并排禁用）、卡内说明；工具栏保留新增/保存/状态提示；页面 `wrapClass:'wide'` 显示多列卡片；页面脚本体检补 commands 页并改为按页各自断言 | `lib/wfpage.js` `renderCommandsHtml/commandCardHtml/COMMANDS_CSS`、`scripts/check-page-scripts.mjs`、`test/wfpage.test.js` | ✅ |
| 25 | **瀑布流升级为真瀑布流（JS 最短列装填）**：CSS 多列在卡片高度差异大时平衡失败（用户实测：第 1-3 列只放一张就断、第 4 列堆两张、左下大片空洞）→ 改为 `display:flex` + JS `layoutMasonry()`：固定列宽 300px 算列数，按顺序把每组塞进**当前最矮的列**（并列取最左），图片加载完成/窗口变化后重排；`unwrapMasonry()` 保证切到两列平铺/重叠摊开时还原顺序。**踩坑**：页面脚本拼在 bootstrap 之后，模块级 `var MASONRY_TARGET` 在首次布局时仍是 undefined → 列数算出 NaN → `list[NaN].appendChild` 抛错、整页脚本中断；改为函数内常量。无头浏览器实测：4 列同顶线、左起铺满、无空洞 | `lib/wfpage.js` `ARTIFACTS_CSS`/`layoutMasonry`/`unwrapMasonry`/`scheduleMasonry`、`test/wfpage.test.js` | ✅ |
| 26 | **参数确认框三修（用户三点反馈）**：①**说清干什么**——每题 header＝「title · 1/N」（新增 `title` 贯通 `buildQuestions`，技能要求模型必须传 title），字段名中文化（`提示词（CLIPTextEncode）`/`采样步数`/`生成张数`…）；②**体现推荐值**——每题题面写明「推荐：X／不答将采用推荐值 X」，选项首位标 `（推荐）`（enum/boolean 用当前值，seed 用本轮随机值，number/image 用现值），并保证「（推荐）」后缀不会被写进图（`resolveAnswer` 剥离，含边界测试）；③**取消后不再吞掉倒计时**——原先任何异常都退回阻塞式 ask，用户关掉一次对话框就会**再弹一个没有倒计时的框**；现在只在计时提问前置失败（BAD_TIMEOUT/DUPLICATE_WAIT/非活跃根代理）时才回退，用户取消返回 `cancelled:true`（不执行、不重弹），倒计时说明写到**每一页**（`⏱ N 秒未答 → 自动采用【推荐】值继续（本框可留空）`） | `lib/forms.js` `buildQuestions/resolveAnswer/FIELD_LABELS`、`lib/catalog.js` push_form、`lib/skills.js`、`test/forms.test.js`、`test/catalog.test.js` | ✅ |
| 27 | **点击图片放大改为整屏遮罩灯箱**（对齐 ComfyUI 查看器体感）：原先是一个居中小弹窗（`.box` + 88vw/74vh 上限），放大后仍被窗口边距框住 → 改为 `.modal.lightbox` **铺满整个浏览器窗口**的遮罩：舞台 `position:absolute;inset:0` 铺满、图片在其中缩放平移、超出部分由遮罩裁掉；右上角圆形 ✕（Esc、点遮罩空白也可关，且只在未拖动时关，避免误触），底部浮层工具条 −/百分比/＋/适应窗口/1:1/在新窗口打开/下载，打开即「适应窗口」按窗口尺寸算比例；滚轮**以光标为锚点**缩放、指针拖拽平移（Pointer Events，触屏可用）、双击切换 适应↔1:1、`+/-/0/1` 快捷键，`viewClamp` 保证任何方向至少 40px 可见；打开时锁页面滚动。工作流页 `preview2` 与成果物页 `preview` 共用同一实现。**踩坑**：无头浏览器截图抓不到 `will-change:transform` 合成层（数值已生效但画面不更新），去掉该提示后截图可验证；另外打开瞬间布局未稳定会用到旧高度，改用 `requestAnimationFrame` 补一次 fit | `lib/wfpage.js` `PREVIEW_CSS`/`PREVIEW_JS`/两页灯箱标记、`scripts/check-page-scripts.mjs`、`test/wfpage.test.js` | ✅ |
| 28 | **灯箱关闭按钮对称 + 瀑布流「每排从最左开始」**（用户回图反馈两点）：①关闭 ✕ 原来上 10px／右 16px，且字形按 button 默认基线居中（无头实测 `gapTop=10 gapRight=16`）→ 改为上 16px＝右 16px，打开时用 `--lb-pad` 变量补上滚动条宽度（避免被压在滚动条下看起来被切），✕ 改为 flex 居中落在圆心；②瀑布流最短列装填会让某排的下一张卡落到中间（用户实测 5 列 6 卡时第 6 张落第 4 列，左下大片空白）→ 改为**同排优先往左排**：以最矮列高为基准，列高差在 `ROW_SLACK=48px` 以内视为同一排、按列序取最左一列，只有真矮很多的列才优先补位（既不留左侧空洞，又保留瀑布流补位能力） | `lib/wfpage.js` `PREVIEW_CSS`/`showPreview`/`layoutMasonry`、`test/wfpage.test.js` | ✅ |
| 29 | **成果物卡片内容重构 + 瀑布流改轮转填充**（用户回图：仍显得从中间起排、卡片内容乱）：①**排布**：`ROW_SLACK` 启发式仍会因个别卡特别高而把下一张塞到中间列（实测列高 520/971 并存）→ 直接改为**按列序轮转**（`index % columns`）：第 1 排左→右、第 2 排仍从第 1 列开始，绝不出现「中间插一张、左边空一片」，代价是列尾参差（瀑布流本来如此）。②**卡片**：原设计里「运行头 + 元信息 + 提示词」是**无边框的松散三行**、下面是另一个卡片盒（图 + 文件名 + 9 个按钮挤两行），两个视觉组互不对齐 → 改为**一次运行＝一张整卡**，内部四区用发丝线分隔：卡片头（勾选 + 工作流 + 状态 + 元信息单行右对齐省略）、提示词（单行省略可展开）、媒体（1:1 满宽，勾选框浮到图左上角不再占行高）、文件区（文件名 + 标签/字段 chip + 操作）。③**降噪**：标签/集合/字段最多显示 3/2 个、其余折叠为 `+n`（悬浮看全），操作分主次——常看的「＋标签 / ⬇下载 / ✕删除」+「⋯ 更多」就地展开（标签集合/集合/字段/绑定提示词/来源/导出 JSON）。**根因级发现**：全局表单规则 `label{min-width:130px}`（本意是运行表单字段标签）也套到勾选框 `<label class="pick">` 上 → 勾选框实测宽 130px，把卡片头元信息挤成 7px 一个字；已收窄为 `.row label` 并给 `.pick` 加 `min-width:0`。改后实测卡片头 `pick 20px / 名称 49 / 状态 75 / 元信息 117`，同排卡片高 520/520/520/520/522（近乎等高） | `lib/wfpage.js` `ARTIFACTS_CSS`/`artifactsRunsHtml`/`layoutMasonry`/`ARTIFACTS_JS`、`scripts/check-page-scripts.mjs`、`test/wfpage.test.js` | ✅ |
| 30 | **多图＝固定尺寸收集卡 + 子级画廊；视频首帧 / 音频固定封面**（用户需求）：原先同一运行出 N 张时是**纵向铺开 N 张卡**（≥4 张走 `.fan` 重叠），卡片被撑得很高、与单卡不成比例 → 改为：①**多张（≥2）合成一张收集卡**，尺寸与单卡完全一致（复用同一 `.mediacard/.thumb/.meta` 结构、媒体区仍 1:1）；②媒体区内**最多 5 张小角度扑克摊开**（`±7°`，nth-child 逐张给角度与偏移，悬浮时再展开一点），角标显示「N 张 · 另 K」；③点任意一张进入**灯箱子级画廊**：标题带序号 `名字 · 2/5`、底部缩略条高亮、`← →` 键或点缩略条逐张切换（单张模式不受影响，`GALLERY.items=[]`）；画廊索引随渲染写进 `window.__galleries`，检索结果也一并下发（`queryArtifacts` 增加 `galleries`），否则检索后点开会拿到旧列表；④**视频＝首帧**（`<video muted preload=metadata src=…#t=0.1>` + ▶ 角标）、**音频＝固定封面**（渐变 + 波形条 + ♪，不依赖磁盘缩略图）；⑤逐张的标签/下载/删除仍可达：`☰ 文件列表` 就地展开完整列表 | `lib/wfpage.js` `thumbInnerHtml`/`audioCoverHtml`/`artifactsRunsHtml`/`showGallery`/`galleryShow`/`galleryStep`/灯箱标记、`lib/workbench.js` `queryArtifacts`、`test/wfpage.test.js` | ✅ |
| 31 | **取消页内重复页头 + 布局压缩**（用户回图：顶部已有一套 Tab，页内又重复一套）：静态页是被**客户端插件的 iframe** 嵌进来的，插件已渲染「ComfyUI 工作台 + 我的工作流/模板/成果物/指令」外层 Tab，而每个静态页又渲染了一遍 `<h1>` + `workbenchTabs` → 视觉上两套。改为 **页头条件显示**：标题与页内 Tab 包进 `.pagehead`（默认 `display:none`），`pageShell` 注入的 `FRAME_JS` 只在独立窗口（`window.self === window.top`）时加 `.standalone` 露出来——嵌在工作台里完全看不到重复，单独开新窗口仍有导航。**布局同时压缩**：`.wrap` 顶部 20→14px；成果物页把摘要 `#runs-summary` 并入工具栏行（右侧对齐）并给工具栏加卡片底色，少一行且信息不丢；指令页把「最近一次运行」并进 `#cmd-note` 提示文案；检索框 `margin` 收紧。实测嵌入态首屏：宿主 Tab → 检索行 → 工具栏行（含摘要）→ 卡片，无重复标题 | `lib/wfpage.js` `pageShell`/`FRAME_JS`/`PAGE_CSS`/四个页渲染器、`docs/operations.md`、`test/wfpage.test.js` | ✅ |

**下个迭代候选**：节点连线式画布、对象存储直传、多 ComfyUI 实例、表单记忆、国际化、成果物标签批量编辑。

**封板校验（2026-10-15）**：插件 195 项测试全绿（18 个测试文件）· 页面模板体检 5 页完整 · 页面脚本体检 4 页语法 OK 且关键监听齐全 · 全仓 `pnpm test` + `pnpm typecheck` 通过 · 无头浏览器实测（瀑布流排布 / 卡片分层 / 灯箱缩放与画廊 / 页头条件显示）逐项截图核对。

## snapshot-0.2.0（稳定主分支，2026-10-13 封板）✅

**交付主题：工作台（可视化工作流 → 静态页 → 执行 → 成果物库）成型。**
源自 `dev-snapshot-20261011-0.2.0` 全部提交（含本期 12 个功能/修复提交）：

| # | 能力 | 落位 |
| --- | --- | --- |
| 1 | 工作流按协议编排成静态页（描述符 v1 + 确定性渲染，DSH 简约风） | `lib/wfpage.js` |
| 2 | 一个工作流一个页面；DSH 侧栏图标 → 中央面板；三 Tab 齐平：我的工作流 / 模板 / 成果物 | `client.js`、`/ui`、`/ui/library`、`/ui/artifacts` |
| 3 | 官方节点解析适配（宿主包装解包、COMBO+options、object_info/rows 形状、UI→API 格式、内联子图展平、自动增长组双写） | `lib/nodecat.js`、`lib/wfgraph.js` |
| 4 | 异步执行：进度（节点/步数/百分比）、loading、执行中禁用、手动中断、**单工作流最大运行时间**超时中断 | `lib/rund.js`、`lib/runcore.js` |
| 5 | 成果物：一列卡片 / 瀑布流 / 两列平铺 / 重叠摊开四种样式；图片滚轮缩放、视频音频播放、Range 流 | `lib/wfpage.js`、`control-server /artifact` 206 |
| 6 | 标签体系：标签、标签集合、动态字段、绑定提示词、使用来源；正/负提示词拆分与「⇢ 赋值」回填表单 | `lib/tags.js`、`lib/forms.js` |
| 7 | 成果物库：无模态数据不入库、复合语法检索（字段限定 / 与或非 / 比较）、勾选批量删除、单次与整体导出 JSON（base64 内嵌） | `lib/artifactsearch.js`、`/api/artifacts/*` |
| 8 | 快捷指令（抽卡＝仅重滚种子；种子策略 range/digits/timestamp）、成果物镜像目录、对象存储分发（local/MinIO/OSS） | `lib/quick.js`、`lib/runcore.js`、`lib/storage.js` |
| 9 | 模板执行一次即落库「我的工作流」；已存在时打开即带出**上次运行的参数**（标「上次」） | `lib/workbench.js` |
| 10 | 验证基线：插件 143 测试 + 服务端 13 + 宿主/存储等共 400+；页面模板/脚本双体检脚本 | `test/`、`scripts/check-page-*.mjs` |

**封板校验**：`pnpm test` 全绿（16 个测试文件 143 用例）+ `pnpm typecheck` + 真机端到端（模板落库、种子重跑、超时中断、批量删除、导出 base64 与磁盘字节一致）。

**下个迭代（v0.3.0 候选）**：节点连线式可视化画布、运行历史面板增强、对象存储直传、多 ComfyUI 实例、表单记忆、国际化、成果物标签批量编辑。

## snapshot-0.1.0（稳定主分支，2026-10-11 固化）

首个可交付闭环，源自 `dev-snapshot-20261011-0.1.0` 全部 12 个提交：

- dsh-comfymcp-client 插件：10 个 `comfymcp_*` 模型工具全流程（状态→检索→分析→表单→回填→保存运行→成果物）
- 内嵌 comfy-mcp-server（vendor 单文件包，port 0）+ MCP 宿主（stdio）+ stdio 后端 → 原版 ComfyUI
- 设置页：DSH kit 同风格；内置/远程模式选择；环回控制端点（18801..18810）兜底静态挂载拿不到 connection RPC 的场景
- 自动卸载：探测四形状兼容（rows/nodes × classType/class_type），探测可用时输出链插桩 `UnloadAllModels`
- 插件自有主目录：`$DSH_HOME/comfymcp/`，派生 `workflows|artifacts|data`，runs.json 结构化持久化
- 受管存储三实现：本地目录 / MinIO（S3 SigV4）/ 阿里云 OSS（OSS4）；产物非本地时自动推送
- 聊天渲染：运行产物卡 + 文件管理卡；远端模板拉取 `comfymcp_workflow_pull`
- 测试：插件 67、server 13（mock 后端自检另计）；文档 deployment/operations/protocol

## dev-snapshot-20261011-0.2.0（开发中，v0.2.0 迭代——用户定稿范围）

本期五项（2026-10-11 用户需求，覆盖先前草案）：

1. **工作流可视化 → 静态网页**：DSH 前端可视化当前工作流；按协议规则把工作流节点编排成静态网页（UI 对齐 DSH 简约风）。协议 = 页面描述符 JSON（`lib/wfpage.js`）：节点分组 → 控件（number/string/choice/seed，含 min/max/step/枚举），渲染器确定性输出 HTML。
2. **一工作流多静态页 + Tab 手动执行**：每个工作流一个页面 + 索引页；DSH 内注册 `sidebar.panellist` 图标 → `main` 中央面板「ComfyUI 工作台」（iframe 嵌入，浏览器亦可直接打开控制端点 URL），页面内改参 → 手动触发远程 MCP 工具调用（run）生成图像/媒体数据。
3. **成果物可视化 Tab**：成果物页（runs + 文件 + 图片瓦片）；文件支持动态字段与标签操作（标签、绑定提示词、使用来源、标签集合）。
4. **快捷指令封装**：抽卡=仅重滚种子续跑同一工作流（表单答案复用）；种子策略可配：范围 min/max、随机位数、时间戳+补偿位数；指令列表 JSON 可扩展。
5. **成果物镜像下载**：`downloadDir`（相对主目录）配置后，运行产物在下载的同时复制一份到项目空间子目录。

实现落位：`lib/wfpage.js`（协议+渲染）、`lib/quick.js`（指令/种子策略）、`lib/tags.js`（标签存储）、`lib/runcore.js`（工具与控制端点共用运行核心）、`lib/nodecat.js`（官方节点目录形状适配）、`lib/wfgraph.js`（UI 格式 ⇄ API 格式、内联子图展平）、控制端点 `/ui*` `/api/*`、`client.js` 工作台面板。

### 节点解析与格式适配（活链路实证结论）

| 环节 | 真实形状（抓包实证） | 适配落位 |
| --- | --- | --- |
| 宿主转发包装 | `structuredContent = {ok,isError,tool,data,...}` | 先解 `.data` 再取 `nodes`（`unwrapHost`） |
| 节点元数据 | `{nodes:{Cls:{inputs:[{name,group,type,required,default,min,max,step,options}]}},missing:[]}`；枚举为 `type:"COMBO"+options` | `lib/nodecat.js` 统一四种形状（含官方 object_info 裸形状、rows 分页、数组枚举旧约定） |
| 工作流来源 | 本地目录文件 + 远端 `library:*`（模板库）/`saved:*`（本地同目录被服务端索引）/工作区条目 | 本地优先；拉取写插件自有 `<home>/workflows`（绝不写用户 ComfyUI 目录） |
| 本地文件格式 | ComfyUI 前端 **UI 格式**（`nodes[]/links[]/widgets_values`），且大量使用**内联子图** | `lib/wfgraph.js`：服务端转换优先（无子图时）→ 本地展平兜底 |
| 子图展平 | 定义含虚拟边界 `inputNode(-10)/outputNode(-20)`；`def.inputs[i].linkIds` 指内部链路，槽位序 = 外节点输入序；外节点 `outputs[s].links` 需重映射到内部产出节点 | `apiGraphFromUi`：内部节点前缀 `<外节点id>:`，promoted 输入取值（外链→外部引用／widget→外节点同名值），输出链路重映射 |
| 自动增长组输入（`COMFY_AUTOGROW_V3`） | 两端契约不同：ComfyUI `/prompt` 只认扁平点号键 `values.a`（给嵌套对象 → `required_input_missing: values.a`）；comfy-mcp 校验层却要求存在名为 `values` 的输入（只给 `values.a` → `missing_input: requires input "values"`） | **双写**：既写 `values.a`，也镜像父对象 `values:{a:…}`，两端同时通过 |
| 运行工具契约 | `save_workflow(name*, graph*, overwrite)`／`run_workflow(graph, id, front, priority)`（**无** name/wait）／`job_wait(promptId*, timeoutMs)`／`fetch_outputs(promptId, files, outDir, inline, maxBytes)`（`outDir` 直接落盘并返回 `files[].path` + `artifacts[]`）；`job_progress(promptId)` 供进度 | `lib/runcore.js` 按实测 schema 调用；`lib/rund.js` 轮询进度、维护运行状态与清空标记 |
| 复合键 | 展平后节点 id 自身含冒号（`128:127`），字段名也可能含点号（`values.a`） | 页面 values 键 `nodeId:field` 按**最后一个冒号**切分 |
| 校验 | `validate_workflow`（服务端逐字段）+ ComfyUI `/prompt`（真实执行校验） | 实机 6 个本地工作流展平后全部通过；1 个为工作流自身引用了本机缺失素材（表单以「当前值·不可用」呈现，不静默丢值） |

### 成果物库与提示词（2026-10-13 追加）

- **无模态数据不入库**：成果物页只登记有产物的运行，无产物的失败记录不展示（页头给出忽略条数）
- **一列卡片**：每次运行一个分区，每个文件一张横向卡（缩略图 + 文件名 + 标签/集合/动态字段 + 操作）
- **预览/播放**：点击图片放大、视频/音频就地播放（`/artifact` 支持 HTTP Range，可拖动进度）
- **提示词正/负**：运行核心按采样节点 `positive`/`negative` 链接定位文本节点，提取正负提示词与**可回填字段键**（`forms.extractPrompts`）；卡片折叠展示、鼠标悬浮看全文、箭头展开全文
- **提示词快捷赋值**：成果物页「⇢ 赋值」暂存（`/api/prompt/assign`，落 ui-state.json），工作流页加载时一次性取回并回填对应字段（`/api/prompt/take`），带高亮提示条
- **导出**：单次运行或整体导出 JSON（`/export?runs=…`，附件下载）；内容为当前已有字段 + 提示词正负 + 标签/集合/动态字段 + 文件字节 **base64 内嵌**
- **文本字段区分**：提示词类 textarea 自动增高（按字数/行数）、显示字数行数、`⤢ 展开` 大窗口全文编辑并写回表单
- **工作流页成果区分组**：该工作流最近多次运行按组展示（自适应一行多组），每组含 状态/种子/用时/时间 + 正负提示词 + 可展开的**结构化参数表**；同一份参数写入该组 `title`，**鼠标移入即见**；组内媒体缩略图点击放大/播放，并可「⇩ 导出该次 JSON」；运行结束自动刷新分组。数据源 `/api/run/history`（`rund.summarize` 附带 `params`：提示词优先、链接引用不计入、上限 60 项）
- **重复执行**：上一次运行的收尾展示态不再阻塞新一轮（仅真并发才拒绝），支持「跑一次 → 改种子 → 立即再跑」
- **成果预览与缩放**：点击缩略图（含缩略图内的 `<img>`，经 `closest` 定位承载节点）弹出预览；图片支持**滚轮缩放**（10%–800%）、拖拽平移、双击 100%/200%、工具按钮与 `+/−/0` 快捷键、Esc 关闭；视频/音频就地播放。两页共用同一 `PREVIEW_JS`/`PREVIEW_CSS`
- **成果删除**：单件「✕ 删除」＝从运行记录移除并删盘（二次确认）；「✕ 移除该组」＝只清记录、保留文件。服务端只允许删除**登记在该运行记录内**的路径，越权路径直接拒绝（`/api/artifacts/remove`）
- **检索与批量删除（成果物库）**：检索栏＝「模糊词」（命中正/负提示词、文件名、标签/集合、动态字段名值、参数名值）＋ 标签 ＋ 参数条件（`field=value` / `field!=value`）＋ 动态字段条件，四组按 **与/或** 组合（`/api/artifacts/query`）；每件可勾选、全选/全不选，`🗑 删除选中` 批量删盘（`/api/artifacts/remove-batch`，产物清空的组自动移除）。检索前用 `summarizeRun` 富化记录（`params` 取自终图），命中来源以「命中：…」标注
- **三 Tab 齐平**：工作台顶部「我的工作流 / 模板 / 成果物」三 Tab 跨页一致（`/ui`、`/ui/library`、`/ui/artifacts`），DSH 面板内也同步为三个 Tab
- **模板跑过即入库**：模板（远端 library）执行一次即把展平后的 API 图落到插件自有 `<home>/workflows`，自动出现在「我的工作流」；运行名统一为文件词干，之后打开该工作流会自动带出**上次运行的参数**（字段标「上次」并高亮，附提示条），点「↻ 重新解析」可回到文件原值
- **成果重叠渲染**：同一组 ≥4 件时按扑克牌摊开（重叠 + 旋转），悬浮/勾选时抬起置顶显示完整卡片与操作按钮

先前草案（并入后续版本候选）：运行历史面板增强、内嵌服务自动重启、对象存储直传、多 ComfyUI 实例、表单记忆、国际化。