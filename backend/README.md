# ATLAS Market Watch（市场零件抓取后端）

每日 08:00 按表1 的零件类型去平台找在售商品，抽取厂家 / 型号 / 价格 / 销量 / 参数，
合并同款、剔除异常价，再与 `h3-parts.json` 比对：同款更新价格与参数，新款写入型号表；
拿不准的提交后台人工审核。

当前版本 **0.3.0**：平台 API 还在申请，先用本地模拟数据把整条链路跑通。
0.3.0 起审核页显示“当前产品标记为 true 的主链接”，并限制每个产品 1 条 true + 至多 3 条 false；
审核页与检查页都能看到既往审核记录。

## 地址

| 页面 | 地址 |
| --- | --- |
| 后端 · 审核 | `http://127.0.0.1:43130/review?token=TOKEN` |
| 后端 · 手动抓取 | `http://127.0.0.1:43130/run?token=TOKEN` |
| 后端 · 检查（启动日志 / 运行记录 / 审核队列） | `http://127.0.0.1:43130/inspect?token=TOKEN` |

`TOKEN` 从 `data/token.txt` 读取，页面输入一次后存在 `sessionStorage`。
第一页 `http://127.0.0.1:43125/`、第二页 `http://127.0.0.1:43125/next.html`。
完整规范见仓库根目录的 `ADDRESSES.md`。

## 三个后端页面

- **手动抓取 `/run`**：勾选零件类型（默认 28 个全选）、选择是否 dry-run，点“开始抓取”；
  页面轮询状态并展示新建 / 更新 / 审核 / 剔除数量，可跳转第二页、审核页、检查页。
- **检查 `/inspect`**：服务信息、地址规范、启动与运行日志（自动刷新）、运行记录
  （点开看 `meta.json`、决策表、最近函数调用）、审核队列统计。
- **审核 `/review`**：价格冲突或参数存疑的商品，分两块列出「当前产品（表内）」与「本次抓取」
  的链接（`true` 主链接 + 至多 3 条 `false`），通过后按中位价写回；顶部可切到「既往记录」看通过 / 驳回历史。

## 边界（重要）

- 独立服务，只监听 `127.0.0.1:43130`，与第一 / 第二页（43125）**没有任何前端入口或反向代理**；
- 所有 `/api` 都要 token（`?token=` 或 `x-market-token` 头），没有 CORS；
- 审核页、手动抓取页、检查页都由本服务自己提供，不从一二页跳转；
- AI 不能直接改文件：AI 只能通过预设函数提交结构化结果，写库由函数层执行。

## 快速开始

```bat
cd atlas\backend
node server.mjs
```

想直接跑真实 1688（不动 `market-config.env`，只临时覆盖几个环境变量）：

```bat
start-1688.cmd
```

它等价于 `MARKET_PLATFORM=1688` + `MARKET_AI_MOCK=0` + 间隔 8 秒 + 每个类型最多 2 条。
`node server.mjs` 仍是模拟模式，两者可以随时切换。

启动日志会打印三个后端页面地址；token 首次启动自动生成，保存在 `data/token.txt`：

```
后端 · 审核 /review · 手动抓取 /run · 检查 /inspect
```

打开 `http://127.0.0.1:43130/run`，粘贴 token 即可手动跑一次；三个页面顶部可以互相跳转。

也可以直接调接口：

```bat
curl -X POST "http://127.0.0.1:43130/api/run" ^
  -H "Content-Type: application/json" ^
  -H "x-market-token: TOKEN" ^
  -d "{\"partTypeCodes\":[\"h3-cam-01\"],\"dryRun\":true}"
```

结果在 `data/runs/<runId>/`：`meta.json` / `staging.json` / `decisions.json` / `functions.jsonl`；
dry-run 时还有 `parts.next.json`（拟写回的完整零件表）。

## 配置

`market-config.env`（可从 `.example` 复制），修改后重启：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `MARKET_PLATFORM` | `mock` | `mock` / `taobao` / `douyin` |
| `MARKET_PORT` | `43130` | 只监听本机 |
| `MARKET_APP_URL` | `http://127.0.0.1:43125` | 检查页里第一 / 第二页的链接 |
| `MARKET_DAILY_AT` | `08:00` | 每天抓取时间 |
| `MARKET_TIMEZONE` | `Asia/Shanghai` | 时区 |
| `MARKET_SCHEDULE_ENABLED` | `0` | 接真实平台后改 1 |
| `MARKET_SALES_RANK` | `10` | 取第 N 名月销做门槛 |
| `MARKET_SALES_RATIO` | `0.7` | 门槛 = 第 N 名 × 0.7 |
| `MARKET_OUTLIER_RATIO` | `0.4` | 偏离中位价 40% 剔除 |
| `MARKET_OUTLIER_ROUNDS` | `3` | 最多剔除轮数 |
| `MARKET_SAME_PRICE_TOLERANCE` | `0.3` | 价差超过 30% 进审核 |
| `MARKET_MIN_CONFIDENCE` | `0.6` | AI 判定最低置信度 |
| `MARKET_MAX_RESULTS` | `60` | 每个类型最多抓取条数 |
| `MARKET_ALLOW_SIMULATED_WRITE` | `0` | 模拟数据是否允许写回 |
| `MARKET_AI_MOCK` | `1` | 用本地模拟 AI（不消耗调用） |
| `MARKET_PARTS_FILE` | `../pages/public/data/h3-parts.json` | 写回目标 |
| `MARKET_AI_CONFIG_FILE` | `../ai-config.env` | AI key：**与第一 / 第二页共用根目录那一份**，改一次两端同时生效 |
| `MARKET_DATA_DIR` | `./data` | 临时表、审核队列、备份、日志 |
| `MARKET_1688_COOKIE` | 空 | 整串 Cookie（太长可改用文件） |
| `MARKET_1688_COOKIE_FILE` | `./data/1688-cookie.txt` | Cookie 文件，`--grab-only` 会写这里 |
| `MARKET_1688_DELAY_MS` | `3500` | 请求间隔；被挡过就 8000~60000 |
| `MARKET_1688_SEARCH_LIMIT` | `4` | 每个零件类型最多取几个商品（真实模式建议 2） |
| `MARKET_1688_DIRECT` | `1` | 绕开系统代理直连 1688 |
| `MARKET_1688_SEEDS_FILE` | `./seeds/1688-seeds.json` | 人工种子 |

## 每日流程

1. **搜索**：每个零件类型按“名称 + 关键词”搜索（关键词来自表1 模块）。
2. **销量门槛**：按平台月销降序，门槛 = 第 10 名月销 × 70%；不足 10 条时取最后一名。
3. **详情**：标题命中才抓详情；**是否属于该类型、参数是什么，只看详情页**。
4. **AI 判类型**：`judge_part_type`，不通过就丢弃；置信度低于 `0.6` 进人工审核。
5. **AI 抽字段**：`extract_listing` → 厂家 / 型号 / 价格 / 月销 / 参数，写入临时表。
6. **AI 合并同款**：`merge_market_part` 按“厂家 + 型号”合并，AI 给显示名（`类型 · 型号`）和
   第四段编号（接在类型三段编号后，如 `h3-cam-01-m105`）。
7. **剔除异常价**：`exclude_price_outliers`，销量加权中位价，逐轮剔除偏离 > 40% 的报价并重算，最多 3 轮。
8. **比对现有零件表**：
   - 厂家 + 型号全等 → 价差 ≤ 30% 且 `judge_same_product` 通过 → 用中位价更新价格 / 参数 / 链接；
   - 价差 > 30% 或参数存疑 → `submit_review` 进人工审核（带商品链接）；
   - 找不到 → `commit_market_part` 以型号新建 variant。
9. **写回**：`write_parts_file` 先备份、再原子替换，并校验 28 个类型、id 唯一、必填字段。

销量只用于加权和门槛，**不写入 variant**；variant 里保存厂家、型号、
加权中位价对应的商品链接（`primary: true`）以及至多 3 条备选链接（`primary: false`）。

## 临时表

每次运行都会把所有候选明细落盘，不只是汇总：

- `data/temp/latest.json`：最近一次运行的全量明细（检查页“临时表”默认读它）；
- `data/runs/<runId>/staging.json`：同一次运行的明细；
- `data/runs/<runId>/groups.json`：合并后的同款组。

每条记录包含：状态（`kept` / `outlier` / `type_rejected`）、零件类型、标题、链接、店铺、
厂家、型号、价格、月销、参数、中位价、原因。

```http
GET /api/temp?runId=&status=&partTypeCode=&limit=300
```

检查页的「临时表」标签可以按状态和类型过滤，直接看到“异常剔除”的那条报价。

## 链接规则

`lib/links.mjs` 是唯一实现，写入、审核、写盘校验共用：

- 每个产品 **1 条 `primary: true` 主链接**（审核页“当前产品（表内）”显示的就是它）；
- 备选链接 `primary: false` **至多 3 条**，合计最多 4 条；
- 地址按归一化结果去重（去 `#锚点`、`utm_*` / `spm` 等营销参数、末尾斜杠，主机名小写）；
- 合并时保留现有主链接，新抓的链接优先占备选位，旧备选兜底；
- `write_parts_file` 会再校验一次：条数超限、重复地址、没有 true 或 true 多于 1 条都会拒绝写盘。

## 审核记录

审核队列 `data/review-queue.json` 保留所有状态（`pending` / `approved` / `rejected`），
不会因为处理完就删除：

- 审核页「既往记录」标签：决定时间、结果、类型、厂家 / 型号、写入价格、说明、runId；
- 检查页「审核队列」：上半部分是待审（含当前 true 主链接），下半部分是最近 20 条既往记录；
- 通过记录额外保存 `decidedPrice`、`decidedAt`、`decidedBy: "human"`、`linksAfter`；
  驳回记录保存 `note`。

```http
GET /api/review?status=pending&limit=200
```

**审核页不使用 AI**：它只读取 `/api/review`、提交 approve / reject；通过时调用确定性函数
`commit_market_part` + `write_parts_file`，不经过任何模型。

## 预设函数

AI 侧（经 `lib/tool-schemas.mjs` 严格校验，失败自动纠错重试一次）：

| 函数 | 作用 |
| --- | --- |
| `judge_part_type` | 详情页是否属于该零件类型 |
| `extract_listing` | 抽取厂家 / 型号 / 价格 / 月销 / 参数 |
| `merge_market_part` | 合并同款：显示名、厂家、型号、第四段编号、汇总参数 |
| `judge_same_product` | 与现有型号是否同一商品（参数差异） |

确定性函数（`lib/functions.mjs`，同样只经函数入口执行）：

| 函数 | 作用 |
| --- | --- |
| `exclude_price_outliers` | 加权中位 + 多轮剔除 |
| `submit_review` | 写审核队列（同类型同厂家同型号去重） |
| `commit_market_part` | 在内存零件库中 create / update |
| `write_parts_file` | 备份 + 校验 + 原子写回 |

每次函数调用都落 `data/runs/<runId>/functions.jsonl`（参数 + 结果摘要），可审计。

## 上游 AI 参数适配

不同推理模型对 `chat/completions` 的参数各有各的规矩。`lib/ai.mjs` 在收到 400 时按报错自动降一档
重试（最多 4 次），不让人去猜参数：

| 上游 400 的说法 | 自动改成 |
| --- | --- |
| `invalid temperature: only 1 is allowed for this model` | `temperature: 1` |
| `tool_choice 'specified' is incompatible with thinking enabled` | `tool_choice: "required"`，再不行 `"auto"` |
| 报错里提到 `thinking` / `reasoning` | 附加 `thinking: { type: "disabled" }` |
| 模型没吐内容、重试时回 `assistant must not be empty` | 用一句占位文本代替空串 |

也可以在根目录 `ai-config.env` 里直接写 `AI_TEMPERATURE=1`（当前 Kimi 编程模型就是 1），省掉这一次重试；
这份配置是第一页 / 第二页 / 后端共用的，改一次三处都生效。

## 一个类型失败不会拖垮整轮

抓不到的类型（没配种子、没有候选）会被跳过并记录，其余类型继续跑；日志末尾会写
`跳过 N 类（没种子或没候选）`，`data/runs/<runId>/meta.json` 里的 `skippedTypes` 有原因。

只有**真的被风控**（连续 3 个商品都是滑块页）才会整轮失败——继续请求只会加重惩罚。

跳过之后想补数据，就在 `seeds/1688-seeds.json` 里给它加链接，再单独跑这一个类型：

```bat
curl -X POST "http://127.0.0.1:43130/api/run" ^
  -H "Content-Type: application/json" -H "x-market-token: TOKEN" ^
  -d "{\"partTypeCodes\":[\"h3-cam-02\"]}"
```

## 同一个商品不会每轮多出一条

AI 两次抽取同一个厂家，可能一次给「深圳市多视界科技有限公司」、一次给「多视界」。
`lib/parts.mjs` 的 `makerKey` / `makerMatches` 会先去掉地域前缀（`深圳市`）和公司后缀
（`有限公司` / `科技` / `电子` …），再判断是否同一家；型号必须完全一致才算同款。
这样重复抓取走的是 `update`，不会生成重复型号。

## 数据模型变化

variant 新增字段（都可选，旧数据不受影响）：

```json
{
  "id": "h3-cam-01-m105",
  "tier": "市场",
  "tierKey": "market",
  "name": "相机模组 · H3CAM01-105",
  "manufacturer": "凌越智造",
  "model": "H3CAM01-105",
  "links": [
    { "url": "https://…", "shop": "…", "price": 666.36, "monthlySales": 22400, "primary": true }
  ],
  "source": "模拟平台",
  "capturedAt": "2026-10-31T06:33:19.208Z",
  "updatedAt": "2026-10-31T06:33:19.208Z",
  "params": [{ "label": "材质", "value": "模组" }]
}
```

- 编号固定四段：`类型三段编号 + AI 给的第四段`，冲突时自动加 `-2`；
- 新 variant 的重量 / 交期沿用该类型基线（页面合计不至于归零），等详情页能给出时再更新；
- 页面二悬停与右侧详情会显示“厂家 / 型号”。

## 1688 真实数据源（v3.0）

`MARKET_PLATFORM=1688` 时走 `lib/source-1688.mjs`，不需要任何第三方 API：

| 步骤 | 做法 | 说明 |
| --- | --- | --- |
| 搜索 | ① `seeds/1688-seeds.json` 人工种子 → ② 1688 站内搜索（需 Cookie） → ③ DuckDuckGo 站内检索 | 1688 搜索页必须登录，所以种子排第一优先 |
| 详情 | `GET https://m.1688.com/offer/<id>.html` | 从页面内嵌 JSON 取标题、批发价与阶梯价、已售、公司名、店铺地址、商品属性（品牌 / 型号 / 货号 / 产地…） |
| 交给 AI | `detail.text` | 每行一个字段，直接喂给 `judge_part_type` / `extract_listing` |

**风控**：匿名高频访问会得到 `_____tmd_____/punish` 滑块页（HTTP 200，只有 2 KB）。
实测结论（2026-10-31，本机）：

- **走系统代理（Clash 之类）基本必挡**；同一时刻改成直连就能拿到完整 165 KB 商品页。
  所以 1688 的请求默认绕开代理（`node:https`），`MARKET_1688_DIRECT=0` 可关掉；
- 直连也不是无限量：连续 4~6 次、间隔几秒就会重新被挡，冷却几分钟后恢复。
  间隔拉到 60 秒时，单条商品能稳定抓到；
- **站内搜索结果页是 JS 渲染的**：`s.1688.com` 带 Cookie 直连返回 200 + 27 KB 空壳，
  HTML 里没有商品卡片；用 headless 浏览器渲染又会撞验证码。所以关键词搜索目前不可用，
  发现商品靠 `seeds/1688-seeds.json`（最稳）和 DuckDuckGo 站内检索（不稳定）。

代码已做：请求间隔 + 抖动、匿名 Cookie 预热与复用、命中后指数退避、连续 3 个商品被挡就整轮失败并报错
（不会把标题当数据写进零件库）。想更稳，三选一：

1. `MARKET_1688_DELAY_MS=8000`（默认 3500；被挡过就 30000~60000）；
2. `seeds/1688-seeds.json` 里按零件类型写 1~4 条链接——最稳，不依赖搜索；
3. 登录态 Cookie（下面这套流程），能明显放宽详情页的拦截阈值。

### 登录态：用专用浏览器配置登录一次（推荐）

```bat
cd atlas\backend
node scripts\1688-login.mjs            :: 弹窗，用 1688 / 淘宝 App 扫码
node scripts\check-1688.mjs            :: 验证（只发 1 个请求）
node scripts\1688-login.mjs --grab-only :: 以后 Cookie 快过期时刷新一次，不用再扫码
```

- 脚本用 **专用配置** `data/1688-profile`（非默认路径、不进压缩包、不影响日常浏览器），
  登录成功后自动把整串 Cookie 写进 `data/1688-cookie.txt`，后端启动时自动读取；
- 登录时脚本会顺手打开 1688 首页，把 `cna` / `_m_h5_tk` 这两个风控相关 Cookie 补齐再落盘；
- 只打印 Cookie 的名字和长度，不打印值。

**为什么不直接扒日常 Edge / Chrome 的 Cookie**（都是实测，别再试一遍）：

1. Chromium 运行时对 `Network/Cookies` 加**独占文件锁**，外部进程连复制都做不到；
2. Cookie 值从 M127 起是 **v20 App-Bound 加密**，密钥绑定「可执行文件 + 用户数据目录路径」，
   复制到别的路径或走 junction 都解不开；
3. 更糟的是：解不开时浏览器会把这些 Cookie **当损坏删掉**——拿真实配置试会掉登录态；
4. Chrome / Edge 对「默认用户数据目录」直接**禁用 `--remote-debugging-port`**，
   想用 CDP 让浏览器自己解密也会被拦。

所以正确做法就是上面的专用配置：路径固定 → 密钥一直有效，路径非默认 → CDP 可用。

**种子文件**（`seeds/1688-seeds.json`，随包分发，可随时改）：

```json
{ "h3-cam-01": ["https://detail.1688.com/offer/1072723637966.html"] }
```

**已验证**：`test/fixtures/1688-offer.html` 是 2026-10-31 真实抓下来的商品页，
能解析出标题 `GC4653摄像头模组MIPI接口10*10尺寸`、批发价 `¥33.88`（1 件；500 件 `¥32.88`）、
已售 `100+ 台`、公司 `深圳市栋芯光电科技有限公司`、型号 `DL209-2M80-V1`、35 条属性；
风控页在 `test/fixtures/1688-blocked.html`，单测确认它不会被当成商品解析。

## 平台接入（M3）

`lib/source-mock.mjs` 暴露两个方法，真实平台按同样接口实现即可：
```js
{
  name: "taobao",
  label: "淘宝",
  async search(partType, context) { /* -> [{ id, title, url, shop, sales, detail? }] */ },
  async detail(listing) { /* -> { text, manufacturer?, model?, price?, monthlySales? } */ },
}
```

平台 API 到位后：

1. 新建 `lib/source-taobao.mjs`（或 `source-douyin.mjs`），在 `pipeline.mjs` 的 `sourceFor` 里注册；
2. `MARKET_PLATFORM=taobao`；
3. 把 `MARKET_AI_MOCK` 改成 `0`，确认 `ai-config.env` 的 Key 可用；
4. 首次建议 `MARKET_ALLOW_SIMULATED_WRITE=0` 先看 `parts.next.json`，确认无误再放开。

## 模拟模式的安全性

- 平台是 `mock` 时，默认 **不写回** 真实 `h3-parts.json`，只生成 `parts.next.json`；
- 想完整演示写回，务必把 `MARKET_PARTS_FILE` 指向副本，并设置 `MARKET_ALLOW_SIMULATED_WRITE=1`。

## 定时与失败处理

- 每 20 秒检查一次时区时间，命中 `MARKET_DAILY_AT` 且当天未跑过才触发；
- 失败自动重试 3 次（间隔 60 秒）；
- 停机期间错过的不会补跑；需要补跑时手动 `POST /api/run`。

## 测试

```bat
cd atlas\backend
node --test test\market.test.mjs test\source1688.test.mjs
```

覆盖：加权中位、异常剔除、销量门槛、厂家型号归一化、函数参数校验、
四段编号创建 / 更新、链接规则（1 true + 3 false、去重）、写盘链接校验、
mock 全链路、模拟数据不写回（11 项）；再加大 1688 的详情解析、风控页识别、
搜索链接还原、种子优先（4 项）。
测试使用 `test/fixtures/h3-parts-baseline.json`（112 条基线）与两份真实 1688 页面快照，不依赖网络。

## 目录

```
atlas/backend/
  server.mjs              HTTP 43130、token、调度、审核 / 抓取 / 检查 API
  public/review.html      独立审核页（链接 true/false + 既往记录）
  public/run.html         手动抓取页
  public/inspect.html     后端检查页（日志 / 运行记录 / 临时表 / 审核队列）
  lib/links.mjs           链接规则（1 true + 3 false、去重、合并）
  lib/logbus.mjs          日志环形缓冲 + 文件追加
  lib/config.mjs          配置与路径（默认指向 ../pages）
  lib/ai.mjs              OpenAI 兼容调用（单次工具调用）
  lib/ai-functions.mjs    四个 AI 函数入口
  lib/tool-schemas.mjs    函数 Schema 与说明
  lib/functions.mjs       确定性函数（剔除 / 审核 / 写回）
  lib/parts.mjs           零件表读取、校验、备份写回
  lib/pipeline.mjs        每日流水线
  lib/source-mock.mjs     模拟平台
  lib/source-1688.mjs     1688 真实数据源（搜索 / 详情解析 / 风控重试）
  seeds/1688-seeds.json   1688 人工种子：零件类型 → 商品链接
  scripts/1688-login.mjs  专用配置扫码登录 + 提取 Cookie（推荐）
  scripts/check-1688.mjs  单请求自检：能不能抓、走直连还是代理
  lib/scheduler.mjs       08:00 调度
  lib/store.mjs           原子 JSON / 运行目录
  ai-config.env           → 已移到整合包根目录 ../ai-config.env（与第一 / 第二页共用）
  data/                   token、runs、temp、审核队列、备份、日志（不打包）
  data/1688-profile/      1688 专用浏览器配置（登录态，不打包）
  data/1688-cookie.txt    提取出来的 Cookie（不打包）
  test/                   node --test + 基线 fixture
```

## 已知限制

- 淘宝 / 抖音 API 未接入，真实抓取与反爬策略尚未实现；
- 1688 已接入（`MARKET_PLATFORM=1688`），但匿名抓取会被滑块风控；长期稳定运行需要
  种子链接或登录 Cookie，详见上一节；
- 1688 关键词搜索暂时不可用（结果页 JS 渲染 + 浏览器渲染撞验证码），发现商品靠种子；
- 一次真实全量（28 个零件类型）约等于 56+ 个详情请求，几乎必然被挡；**真实模式建议按 2~4 个
  零件类型分批跑**，每批之间隔 15 分钟以上（`/run` 页可以勾选具体类型）；
- 真实平台通常不公开销量，1688 用的是商品页上的「已售」；
- 新 variant 的重量 / 交期暂用基线值估算；
- 页面二的“系统推荐”仍固定为原基线，不会自动切到市场新款。
