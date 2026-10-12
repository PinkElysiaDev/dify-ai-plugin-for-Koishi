# dify-ai 架构设计文档

> 一句话定位：**dify-ai 是一个 Koishi 插件，它把「群里/私聊里发生的事」翻译成对 Dify 应用的调用，再把 Dify 的回答送回聊天平台。** 全部配置都在 koishi 控制台的插件配置页（schema）里完成——应用凭据、触发规则、回复行为、运行参数——改完即生效，剩下的交给插件。

整个插件的心智模型是一条直线流水线（2026-10 瘦身后：无 WebUI、无 SSE 流式、无本地用量统计——统计交给用户在 Dify 侧自建）：

```
聊天平台消息 ──► 【触发器 Trigger】──► 【请求器 Requester】──► Dify 应用（blocking 请求）
                "这条消息该不该触发？"    "调哪个应用、带什么"            │
                     │                        │                        │ JSON 响应
                     ▼                        ▼                        ▼
                【状态机 State】◄─────── 会话绑定（两列表）◄────── 回复渲染 ──► 聊天平台
```

- **触发器**：盯住所有过路消息（以及定时器/消息密度），判断「哪条规则命中了」，产出触发上下文（谁、在哪、说了什么）。
- **状态机**：回答「这次触发接续哪个 Dify 会话」——按**应用**维度（而非规则）把 koishi 侧会话与 Dify conversation_id 绑定，只存一张两列表。
- **请求器**：组装 blocking 请求（变量、文件、会话 id）→ 解析 JSON 响应 → 按全局「回复行为」配置渲染并发回。

## 1. 目录地图

```
external/dify-ai/
├── src/
│   ├── index.ts                插件入口：装配子系统、启动类型探测、注册维护命令
│   ├── config.ts               全量配置（四组 schema）+ normalizeConfig（schema → 内部模型）
│   ├── types.ts                领域模型：触发条件判别联合、DifyRule、FireContext…
│   ├── history.ts              每频道内存消息缓冲（历史变量 + 密度统计的数据源）
│   ├── api/
│   │   ├── client.ts           DifyClient（blocking JSON + 文件上传）+ createDifyClient 工厂
│   │   └── types.ts            blocking 响应类型 + DifyApiError
│   ├── trigger/
│   │   ├── engine.ts           中间件入口：作用域→条件→优先级→触发
│   │   ├── conditions.ts       6 种消息条件的判定 + 作用域过滤（纯函数）
│   │   ├── scheduler.ts        定时触发计时（不做错过补跑）
│   │   └── pool.ts             频道消息池（密度与定时共用，取走即清空）
│   ├── state/
│   │   ├── tables.ts           唯一的表：dify_conversation（会话绑定）
│   │   └── conversation.ts     会话状态机：bindingKey/difyUser 编码、扫描式重置
│   ├── requester/
│   │   ├── runner.ts           请求执行核心：prepare → dispatch（blocking）→ 回复
│   │   ├── variables.ts        变量系统：session/meta/history → Dify inputs
│   │   ├── files.ts            文件上传管线：元素提取→三源归一→限流→上传
│   │   └── render.ts           回复渲染：分段/引用/元素解析（行为由 config 驱动）
│   ├── commands/misc.ts        dify.conv.reset 维护命令（authority 3）
│   ├── utils/                  keys（频道/群键）、session-text（文本提取）、errors
│   └── locales/                zh-CN / en-US 命令文案
└── docs/                       本文档与 Dify API 调研报告
```

依赖方向自上而下：`index/commands → trigger/requester/state → api → utils`，config.ts 是唯一的配置入口（schema 定义 + 内部模型规范化）。`types.ts` 是公共词汇表，不依赖任何业务模块。

## 2. 插件生命周期

`apply(ctx, config)`（`src/index.ts`）：

1. 注册 i18n → `defineTables(ctx)` 建唯一的会话绑定表
2. `normalizeConfig(config)` 把 schema 配置规范化为应用表 + 优先级降序的规则列表
3. 构造四个单例：`MessageHistory(config.historyLimit)` → `ConversationStore` → `RequestRunner` → `TriggerEngine`（规则注入）
4. `ctx.on('ready')` 后：**并发探测** appType=auto 的应用（GET /info，结果存内存 Map，失败 warn 回退 chat 路径）→ `engine.start()`（注册消息中间件、秒级调度 tick、监听 bot 发送事件记历史）
5. 注册 `dify.conv.reset` 维护命令（authority 3）

**配置改动即插件重载**：cordis 监听到配置变化会整体重新 apply 插件（重新规范化、重新探测、消息池与调度状态短暂复位），无需任何热重载接口。

销毁依赖 cordis 上下文自动清理；内存态（应用类型探测结果、历史缓冲、消息池）随实例消亡。

## 3. 触发器：从消息到触发

### 3.1 触发类型（8 种，判别联合 `TriggerCondition`）

| 类型 | 判定 | 触发后的 query |
|---|---|---|
| keyword-prefix | 消息以任一关键词开头 | 该条消息的统一格式（§8） |
| keyword-contains | 消息包含任一关键词 | 该条消息的统一格式（§8） |
| at-bot | @ 了机器人（koishi atSelf 优先，元素级兜底） | 该条消息的统一格式（§8） |
| at-user | @ 了 userIds 中任一用户 | 该条消息的统一格式（§8） |
| quote-bot | 引用的消息作者是机器人 | 该条消息的统一格式（§8） |
| quote-user | 引用的作者在 userIds 内 | 该条消息的统一格式（§8） |
| schedule | 到点时把消息池内该规则作用域覆盖的各频道消息合并为一次请求；作用域内无消息则跳过 | 池内该频道全部消息按统一格式逐行拼接（§8） |
| density | 池内时效窗口内的真人消息数达到阈值即触发 | 触发即取走该频道全部池内消息，按统一格式逐行拼接（§8） |

query 一律是统一消息格式，原始信息（剥离触发词后的文本等）通过 content 变量映射获取（§8）。纯 @ / 纯引用等无文本触发用占位串兜底。

规则内多个条件是**或**关系。配置页每条条件先在下拉里选类型、再填该类型对应的参数；加载时规范化为内部判别联合，缺参数的条件直接丢弃。

### 3.2 中间件判定顺序（`engine.handleMessage`）

```
消息到达
  ├─ 是其它 bot（含自己）→ 放行
  ├─ 无 channelId → 放行
  ├─ 记入历史缓冲 + 频道消息池  ← 对所有过路消息生效
  └─ 命令优先：next(callback)        ← 先让命令链消化
       └─ 命令未处理时：遍历规则（priority 降序，只含 enabled）
          ├─ 跳过无条件/未关联应用的规则
          ├─ 作用域过滤 matchScope
          └─ 逐条件 evaluateCondition，首个命中即返回
          命中 → 异步 fire（一条消息最多触发一条规则）
```

### 3.3 作用域（`TriggerScope`）

内部是六份名单（platforms/selfIds/guildIds/channelIds/users/excludeUsers，留空不限）加 isDirect 布尔；配置页是一张「维度 + 值」表格（维度含会话类型，见 §12），加载时按维度聚合成这六名单。guildId 匹配用 `guildId ?? channelId` 兜底；时间窗功能已于 2026-10 移除。

**密度与定时共用频道消息池**（`MessagePool`，trigger/pool.ts）：过路消息与 bot 自己的回复全量记入所属频道，密度与定时谁先满足条件谁**取走并清空**该频道全池，另一方重新积累。**密度**只作触发依据：池内时效窗口（条数阈值 + 窗口秒数）内的真人消息达到阈值即触发，bot 行与时效外条目不计入判定但会随全池进入 query。**定时**是消息摘要模型：调度器每秒 tick，到点对作用域内有消息的每个频道各发一次请求，无消息的频道跳过，不做错过的补跑。池按频道保留最近 256 条防无限增长。

## 4. 状态机：会话怎么绑定

**绑定维度是应用而非规则**——指向同一应用、同一会话的多条规则共享同一段 Dify 对话（不同应用的会话不能混用，这正是 appId 参与编码的原因）。

**bindingKey** 编码规则：

```
base = {appId}:{platform}:{selfId}

per-user（群内按用户区分）→ base:user:{guildId}:{userId}   私聊 → base:private:{userId}
per-guild（默认）          → base:guild:{guildId ?? channelId}
per-channel               → base:channel:{channelId}
global                    → {appId}:global
```

| 片段 | 是什么 | 来源 |
|---|---|---|
| appId | 应用配置的「应用 ID」，留空取应用名 | runner 以 appId ?? 应用名 传入 |
| `platform` | 适配器平台标识（接 QQ 为 `onebot`） | session.platform |
| `selfId` | bot 自身账号（QQ 号）；定时触发为池内最近一条消息所属的 bot | session.selfId |
| guildId | 群号；私聊/无群概念平台回退 channelId（形如 `private:{QQ号}`） | session |

**difyUser**（Dify 侧终端用户标识）不再入库，运行时按 bindingKey 字段推导：

| 粒度 | difyUser |
|---|---|
| user | 群内 `koishi:{platform}:{guildId}:{userId}`；私聊 `koishi:{platform}:private:{userId}`（private 占位，不省略段） |
| guild | `koishi:{platform}:{guildId ?? channelId}` |
| channel | `koishi:{platform}:{channelId}` |
| global | `koishi` |

> user 一致性很重要：Dify 的会话续接、文件上传等操作都校验 user 字段，全链路必须同一值。私聊恒按 user 维处理。重置时（`resetWhere`）从 bindingKey 反解出应用 ID（按 appId 或应用名反查配置取凭据）与 difyUser（调删除接口）；private 段是独立会话，不参与按群重置。

## 5. Dify API 调用说明（blocking 单一模式）

全部请求带 `Authorization: Bearer {App Key}`；`response_mode` 固定 `'blocking'`，响应就是普通 JSON（SSE 流式已整体移除）。

### 5.1 端点与请求体

| 端点 | 应用类型 | 请求体 |
|---|---|---|
| POST `/chat-messages` | chat / agent-chat / advanced-chat（及未探测默认） | `inputs`、`query`（统一消息格式；无文本触发用占位串兜底）、`response_mode`、`user`、`conversation_id`（空串=新建，携带=续接）、`files?`、`auto_generate_name` |
| POST `/workflows/run` | workflow | `inputs`、`response_mode`、`user`、`files?` |
| POST `/completion-messages` | completion | `inputs`、`response_mode`、`user`、`files?` |
| POST `/files/upload` | — | FormData：`file`（Blob+文件名+mime）+ `user`；成功状态码 201 |
| GET `/info` | — | 无；探测应用类型 |
| GET `/parameters` | — | 无；输入表单定义 |
| DELETE `/conversations/{id}` | — | `{user}`；重置时尽力清理远端会话 |

### 5.1.1 完整请求体示例

`POST /chat-messages`（chat / agent-chat / advanced-chat）：

```json
{
  "inputs": {
    "content": "今天天气怎么样",
    "chat_history": "[2026-10-04 12:00:05] 张三 (10086) [msg:Oz8xABC] 说：明天去哪玩"
  },
  "query": "[2026-10-04 12:00:05] 张三 (10086) [msg:Oz8xABC] 说：问 今天天气怎么样",
  "response_mode": "blocking",
  "user": "koishi:onebot:g1:u9",
  "conversation_id": "9da1ec0f-0f4a-4b7e-8f2e-2c6d1a7b9e41",
  "files": [
    { "type": "image", "transfer_method": "local_file", "upload_file_id": "c2f7a3e0-5d1b-4f8e-9a2b-7c3d5e1f8a04" }
  ],
  "auto_generate_name": true
}
```

（conversation_id 传空串 `""` 表示新建会话；files 仅在消息含可上传文件且开启上传时出现。）

`POST /workflows/run`（workflow）：

```json
{
  "inputs": { "query": "总结这段对话", "chat_history": "……" },
  "response_mode": "blocking",
  "user": "koishi:onebot:g1:u9",
  "files": [
    { "type": "image", "transfer_method": "local_file", "upload_file_id": "c2f7a3e0-…" }
  ]
}
```

`POST /completion-messages`（文本生成）：

```json
{
  "inputs": { "query": "把这段聊天改写成日报", "chat_history": "……" },
  "response_mode": "blocking",
  "user": "koishi:onebot:g1:u9"
}
```

`POST /files/upload`（multipart，非 JSON；成功返回 201）：

| 字段 | 内容 |
|---|---|
| file | 文件 Blob（带文件名与 MIME 类型） |
| user | 终端用户标识，与会话请求的 user 一致 |

`DELETE /conversations/{conversation_id}`：

```json
{ "user": "koishi:onebot:g1:u9" }
```

### 5.2 响应体结构（逐字段）

**`/chat-messages`（blocking）**：

```json
{
  "event": "message",
  "task_id": "uuid",
  "id": "uuid",
  "message_id": "uuid",
  "conversation_id": "uuid",
  "mode": "chat",
  "answer": "完整回复文本",
  "metadata": {
    "usage": { "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3,
                "total_price": "0.001", "currency": "USD", "latency": 1.2 },
    "retriever_resources": [ { "dataset_name": "...", "content": "...", "score": 0.9 } ]
  },
  "created_at": 1700000000
}
```

（★ 本插件消费 `answer` 与 `conversation_id`；`metadata.usage` 不再消费，统计在 Dify 侧自建。）

**`/workflows/run`（blocking）**——结果都在 `data` 内：

```json
{
  "workflow_run_id": "uuid",
  "task_id": "uuid",
  "data": {
    "id": "uuid",
    "workflow_id": "uuid",
    "status": "succeeded",
    "outputs": {
      "result": "工作流输出",
      "file": { "type": "image", "url": "https://..." }
    },
    "error": null,
    "elapsed_time": 1.5,
    "total_tokens": 100,
    "total_steps": 3,
    "created_at": 1700000000,
    "finished_at": 1700000001
  }
}
```

（★ `status`：succeeded/failed/stopped/partial-succeeded/paused；`outputs` 是工作流输出变量，文本与文件从这里取；`error` 失败原因。）

**`/completion-messages`（blocking）**：与 chat 同构但**没有 conversation_id**（文本生成应用无会话）：

```json
{
  "event": "message",
  "task_id": "uuid",
  "id": "uuid",
  "message_id": "uuid",
  "mode": "completion",
  "answer": "完整回复文本",
  "metadata": {
    "usage": { "prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3,
                "total_price": "0.001", "currency": "USD", "latency": 1.2 },
    "retriever_resources": [ { "dataset_name": "...", "content": "...", "score": 0.9 } ]
  },
  "created_at": 1700000000
}
```

**`/files/upload`（201）**：

```json
{
  "id": "uuid",                // ★ 文件唯一 ID，请求体 files 里用 upload_file_id 引用它
  "conversation_id": null,     // 关联会话 ID（可空）
  "name": "photo.png",         // 文件名
  "size": 102400,              // 文件大小（字节）
  "extension": "png",          // 扩展名（可空）
  "mime_type": "image/png",    // MIME 类型（可空）
  "created_by": "uuid",        // 上传者终端用户 ID（即请求里的 user，可空）
  "created_at": 1700000000,    // 上传时间戳（Unix 秒）
  "original_url": null,        // 原始 URL（可空）
  "preview_url": null,         // 预览 URL（可空）
  "source_url": "https://...", // 下载用签名 URL
  "file_key": null,            // 未使用，恒 null
  "reference": null,           // agent/tool 挂附件的内部引用，本端点恒 null
  "tenant_id": "uuid",         // 租户 ID（可空）
  "user_id": null              // 未使用，恒 null
}
```

（旧版 Dify 会包一层 `{data: {id}}`，客户端两种形态都兼容。）

**`/info`**：

```json
{
  "name": "我的应用",           // 应用名称
  "description": "……",        // 应用描述
  "tags": ["客服", "FAQ"],      // 应用标签
  "mode": "advanced-chat",     // ★ 应用类型，即启动探测的结果：
                               //   chat（Chatbot）/ agent-chat（Agent）/ advanced-chat（Chatflow）
                               //   / workflow（工作流）/ completion（文本生成）
  "author_name": "作者"        // 作者名
}
```

**错误体**（所有端点统一三字段）：

```json
{ "code": "not_chat_app", "message": "...", "status": 400 }
```

完整错误码表。先是全部端点通用项：

| 状态码 | code | 说明 |
|---|---|---|
| 401 | unauthorized | App Key 缺失或错误（官方 OpenAPI 规范未记录此项，实测存在） |

再按端点分组：

`POST /chat-messages`

| 状态码 | code | 说明 |
|---|---|---|
| 400 | app_unavailable | 应用不可用或未发布 |
| 400 | not_chat_app | 非 Chat 类应用调用了本端点 |
| 400 | provider_not_initialize | 模型供应商未配置 |
| 400 | provider_quota_exceeded | 模型配额不足 |
| 400 | model_currently_not_support | 当前模型不支持该调用 |
| 400 | completion_request_error | 补全请求失败 |
| 400 | bad_request | 草稿版本、workflow_id 格式错、Agent 应用用 blocking 等 |
| 400 | invalid_param | 参数错误 |
| 400 | agent_not_published | Agent 应用未发布 |
| 400 | conversation_completed | 会话已结束 |
| 403 | workflow_version_execution_not_allowed | 该工作流版本不允许执行 |
| 404 | not_found | 会话或 workflow_id 不存在 |
| 429 | too_many_requests / rate_limit_error | 限流 |
| 500 | internal_server_error | 服务端错误 |

`POST /workflows/run`

| 状态码 | code | 说明 |
|---|---|---|
| 400 | not_workflow_app | 非 Workflow 应用调用了本端点 |
| 400 | provider_not_initialize | 模型供应商未配置 |
| 400 | provider_quota_exceeded | 模型配额不足 |
| 400 | model_currently_not_support | 当前模型不支持该调用 |
| 400 | completion_request_error | 补全请求失败 |
| 400 | invalid_param | 参数错误 |
| 403 | trigger_workflow_service_mode_unavailable | 触发器启动的工作流不能经 API 运行 |
| 429 | too_many_requests / rate_limit_error | 限流 |
| 500 | internal_server_error | 服务端错误 |

`POST /completion-messages`

| 状态码 | code | 说明 |
|---|---|---|
| 400 | app_unavailable | 应用不可用或未发布 |
| 400 | provider_not_initialize | 模型供应商未配置 |
| 400 | provider_quota_exceeded | 模型配额不足 |
| 400 | model_currently_not_support | 当前模型不支持该调用 |
| 400 | completion_request_error | 补全请求失败 |
| 400 | invalid_param | 参数错误（如缺 user） |
| 429 | too_many_requests / rate_limit_error | 限流 |
| 500 | internal_server_error | 服务端错误 |

`POST /files/upload`（成功返回 201）

| 状态码 | code | 说明 |
|---|---|---|
| 400 | no_file_uploaded | 未上传文件 |
| 400 | too_many_files | 文件数超限 |
| 400 | filename_not_exists_error | 文件名缺失 |
| 400 | invalid_param | 文件名含 / 或 \ 等非法字符 |
| 400 | file_extension_blocked | 扩展名被禁 |
| 413 | file_too_large | 超过大小上限（message 为空串是已知怪癖，按 code 判断） |
| 415 | unsupported_file_type | 不支持的文件类型 |

`GET /info` 与 `GET /parameters`

| 状态码 | code | 说明 |
|---|---|---|
| 400 | app_unavailable | 应用不可用或未发布 |
| 400 | agent_not_published | Agent 应用未发布（仅 /parameters） |

### 5.3 响应消费（`runner.dispatch` + `parseWorkflowResponse`）

- **chat**：取 `answer` 为正文；`conversation_id` 与本地绑定不同则回写绑定表（首次即新建）。
- **workflow**：`data.error` 非空或 status 不在 succeeded/partial-succeeded → 抛 DifyApiError；否则从 `outputs` 提取文本（单字符串值直接用，否则拼接全部字符串值）与文件（递归收集 `{url,type}` 形态）。
- **completion**：取 `answer`。

## 6. 请求器：一次调用的路径

`RequestRunner.run(fireCtx)`：

1. 从配置应用表取凭据（规则引用的应用名未定义时 warn 返回）→ `createDifyClient(ctx, app, config.requestTimeout)`
2. 计算 bindingKey / difyUser → `resolveVariables` 构造 inputs → `config.uploadFiles` 开启且为消息触发时跑文件上传管线
3. **dispatch**（按应用类型分流——schema 显式指定优先，auto 用启动探测结果；见 §5.3）；失败记日志，`sendErrors` 开启时向会话发错误提示
4. 空回复记 warn 返回；否则 `renderReply`（行为读全局 config）→ `deliver`

超时只有一道：请求级 `requestTimeout`（blocking 无流空闲概念）。

## 7. 回复行为（独立配置，使用哪些 koishi 服务）

回复行为在 koishi 插件配置的「回复行为」组里全局设定，不再按规则区分：

| 配置 | 用的 koishi 服务/机制 | 说明 |
|---|---|---|
| `parseElements` | `h.parse(text)` vs `h.text(text)` | 开启时回复文本按消息元素解析（可输出图片/At 等）；关闭时用 `h.text` 保证 LLM 输出里的尖括号按字面发送不被转义 |
| `quoteTrigger` | `h.quote(messageId)` | 回复首段引用触发消息；messageId 即触发消息的 `session.messageId`（OneBot 场景就是 message_id） |
| `maxSegmentLength` | 多条消息逐条发送 | 超长回复按长度切成多段（单行超长硬切），每段独立成一条消息发出；0 不分段 |
| `uploadFiles` | 消息元素 `session.elements` | 提取消息里的 img/audio/video/file 元素上传给 Dify（§9） |

**投递通道**（`deliver`）：

- **消息触发**：`session.send(elements)` —— koishi core 把元素渲染为平台消息段，adapter-onebot 发 `send_group_msg`/`send_private_msg`（详见 §10）
- **定时摘要触发**（无 session，频道来自消息池记录）：在该 `platform` 的在线 bot 里任选一个，`bot.sendMessage(channelId, elements)`

## 8. 变量系统（`resolveVariables`）

规则里每条变量映射是「Dify inputs 字段名 + 来源」，运行时把来源的值填进 `inputs[字段名]` 发给 Dify。配置时先选来源（会话字段 / 历史消息 / 触发元信息），只显示该来源的配置项；历史消息是独立分支，自带「条数」配置（0 用全局）。可用变量如下。

### 会话字段

| 变量 | 内容 |
|---|---|
| userId | 发送者用户 ID |
| botId | 机器人自身账号 ID |
| guildId | 群聊 ID，私聊或无群概念的平台为频道 ID |
| channelId | 频道 ID（私聊形如 private:12345） |
| platform | 平台标识，如 onebot |
| messageId | 触发消息的 ID（定时摘要触发为空） |
| content | 触发文本，已去掉触发词与 @ 前缀；定时与密度触发为池内消息的统一格式拼接 |
| quoteContent | 被引用消息的纯文本 |
| quoteAuthorId | 被引用消息的作者 ID |
| username | 发送者用户名，缺省回退 userId |
| timestamp | 触发时刻，ISO 8601 字符串 |
| isDirect | 是否私聊，true / false |

### 历史消息

独立来源分支，字段名 + 条数（0 用全局「历史消息条数」）。值 = 该频道最近聊天记录按下方统一消息格式逐行拼接；定时与密度触发的 content 变量同样是池内消息的统一格式拼接。

### 触发元信息

| 变量 | 内容 |
|---|---|
| triggerType | 触发类型：keyword-prefix / keyword-contains / at-bot / at-user / quote-bot / quote-user / schedule / density |
| ruleName | 命中的规则名 |
| triggerTime | 触发时刻，ISO 8601 字符串 |

### 历史消息（统一消息格式）

历史消息变量、各触发的 query（消息触发为该格式的单行形态）、定时摘要、密度触发全部按同一格式逐行拼接：

```
[2026-10-04 12:00:05] 张三 (10086) [msg:Oz8xABC]（引用了 [2026-10-04 11:58:40] 李四 (10010) 说：有人吗）说：你看这条 [图片] 怎么样
[2026-10-04 12:00:10] 王五 (10011) [msg:Oz9xDEF] 说：大家好
[2026-10-04 12:00:15] 你自己的发言 (bot1) [msg:Oz7xGHI] 说：已收到
```

- 字段序：时间 → 昵称 → 用户 ID → 消息 ID →（引用段，无引用则整段省略）→ 说： → 内容
- 引用段与外层同构但不展示消息 ID；时间为本地时区秒级
- 图片元素渲染为 [图片] 占位符
- bot 自己的回复同样入记录（历史变量与消息池均含），昵称标注为 你自己的发言、用户 ID 为 bot 账号
- 条数在历史消息分支里指定，0 用全局「历史消息条数」；缓冲容量为全局值 ×2（下限 64）
- 纯内存，重启清空

## 9. 文件上传管线（`uploadMessageFiles`）

元素提取（img/audio/video/file，按来源去重）→ 三源归一（data: URL / http(s) 下载 / 本地路径读取）→ mime→Dify 类型（元素类型兜底）→ 大小限制（image 10MB / audio 50MB / video 100MB / 文档 15MB）→ FormData 上传 `/files/upload` → 以 `{type, transfer_method:'local_file', upload_file_id}` 注入请求体 `files`。单文件失败只记日志跳过。workflow 的「文件型输入变量」（inputs 内嵌）不在此管线范围。

## 10. 消息链路：Koishi ↔ NapCat

> 链路中只有「本插件」一层的两件事属于 dify-ai；标注外部的部分由各自模块实现，本插件不接触 QQ 协议、不碰 WebSocket、不写 SQL。

| 层 | 模块 | 职责 |
|---|---|---|
| QQ 协议端 | NapCat（外部） | QQ NT 侧的 OneBot 11 实现，WS 收发真实 QQ 消息 |
| 协议适配 | koishi-plugin-adapter-onebot（外部） | 收向：OneBot 事件 → koishi Session；发向：bot API → `send_group_msg`/`send_private_msg` |
| 框架 | koishi core（外部） | Session、中间件链、元素系统、minato ORM |
| 业务 | dify-ai（本插件） | ① 中间件链里挂 `engine.handleMessage` 判定触发；② 回复时调 `session.send` / `bot.sendMessage` |

**收**：QQ 消息 → NapCat 推 OneBot 事件 → adapter-onebot 构造 Session（platform='onebot'、selfId=bot QQ、channelId=群号或 `private:{QQ号}`、guildId=群号、userId=发送者 QQ、elements、messageId）→ 中间件链 → 本插件 engine。

**发**：Dify JSON 响应 → `renderReply` 产元素（h.text/h.parse/h.quote/h.image）→ `session.send(elements)` 或 `bot.sendMessage(channelId, elements)` → koishi core 渲染为 OneBot 消息段 → adapter 发 `send_group_msg {group_id, message}` / `send_private_msg {user_id, message}` → NapCat 发出。

| OneBot 字段 | 内容来源 |
|---|---|
| `group_id` / `user_id` | 消息触发 ← session.channelId；定时摘要 ← 消息池记录的频道 |
| `message` 段数组 | renderReply 产出的元素逐段翻译；image 段 url ← Dify outputs 的文件 url |
| reply 段 | `quoteTrigger` 开启时 `h.quote(quoteMessageId)`，quoteMessageId ← session.messageId |
| 发送身份 | 消息触发=收到消息的那个 bot；定时摘要=该平台任一在线 bot |

## 11. 数据库与表结构

**落库机制**（外部模块实现）：koishi core 的 minato ORM，本插件只 `ctx.model.extend()` 声明结构；宿主启用 `@koishijs/plugin-database-sqlite`，数据落 `data/koishi.db`（string(n)/char(n)→TEXT、timestamp→datetime）。

**全库只剩一张表**——应用与规则已全部搬进 koishi schema 配置，数据库仅承担「koishi 会话 ↔ Dify conversation_id」的运行时绑定持久化。

### dify_conversation —— 会话绑定（状态机持久层，仅两列）

| 字段 | 类型 | 说明 |
|---|---|---|
| bindingKey | string(255) PK | 见 §4 |
| difyConversationId | char(64) nullable | Dify 侧 conversation_id；workflow/completion 恒空 |

> difyUser 由 bindingKey 推导不入库；按频道重置通过全表读回 + 解析 bindingKey 完成（行数量级小）。dify_app / dify_rule / dify_usage 表已随全量 schema 化移除。

## 12. 配置项（全量在 koishi 插件配置页）

四组配置：应用配置 / 触发规则 / 回复行为 / 运行参数，改动保存即生效。

**触发条件是条件分支**：每条条件先在下拉里选类型，下方只显示该类型的配置项——关键词类填关键词（每行一个）、@/引用指定用户填用户 ID、定时填 Cron 表达式或间隔分钟、消息密度填条数阈值与窗口秒数、@ 机器人和引用机器人无附加项。同一规则多条条件任一命中即触发。

**作用域是一张可增行的表格**：每行选一个维度（平台 / Bot 账号 / 群聊 / 频道 / 用户 / 排除用户 / 会话类型）再填一个值，同维度多行自动合并。会话类型维度的值填 私聊 或 群聊——只写一条即限定该类型，两条都写等于不限，不写不限。

| 分组 | 字段 |
|---|---|
| 应用配置 | 应用列表：应用名 / 应用 ID（会话绑定用，留空取应用名）/ API 地址 / App Key / 应用类型（默认自动探测） |
| 触发规则 | 规则名 / 启用 / 优先级（大者先匹配）/ 应用名 / 会话粒度 + 条件分支 + 作用域表格 + 变量映射 |
| 回复行为 | 解析回复中的消息元素 / 引用触发消息 / 分段长度 / 上传消息中的文件 |
| 运行参数 | 请求超时（默认 300000ms）/ 历史消息条数（默认 20）/ 失败时提示错误 |

变量映射每条先选来源（会话字段 / 历史消息 / 触发元信息），只显示该来源的配置项；历史消息分支自带条数（0 表示用全局值）。

koishi.yml 等价示例（配置页填写后生成同样的数据）：

```yaml
dify-ai:
  apps:
    - name: my-flow
      apiURL: https://api.dify.ai/v1
      apiKey: app-xxxxxxxx
      appType: auto
  rules:
    - name: 群聊助手
      enabled: true
      priority: 10
      app: my-flow
      conversationScope: per-guild
      conditions:
        - type: keyword-prefix
          keywords: 问
      scope:
        - { dimension: platform, value: onebot }
        - { dimension: guildId, value: '123456' }
        - { dimension: isDirect, value: 群聊 }
      variables:
        - { source: session, field: content, key: content }
        - { source: history, field: chat_history, limit: 0 }
        - { source: meta, field: scene, key: triggerType }
  parseElements: false
  quoteTrigger: true
  maxSegmentLength: 0
  uploadFiles: true
  requestTimeout: 300000
  historyLimit: 20
  sendErrors: false
```

**命令只剩一个**：`dify.conv.reset`（authority 3，重置当前频道的会话绑定）。

## 13. 已知设计取舍

- **配置即全部**：应用/规则/行为均在 koishi schema，配置改动触发插件整体重载（消息池与调度状态短暂复位）；数据库仅存会话绑定。
- **blocking 单一模式**：放弃流式逐字输出（换实现简单与稳定）；长任务受 requestTimeout 约束。
- **会话绑定维度是应用**：同一应用同一会话的规则共享 Dify 对话；需要隔离时应建不同应用或调整 conversationScope。
- **历史是内存态**：重启清空；密度与历史变量短暂退化。
- **统计外移**：token/费用/调用次数在 Dify 控制台（应用日志/分析）查看，本地不再落 usage 表。
