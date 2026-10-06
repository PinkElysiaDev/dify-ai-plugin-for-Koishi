# Dify × Koishi 插件开发综合研究报告

> 研究对象：`koishi-plugin-chatluna-dify-adapter` v1.4.1（位于本仓库 `node_modules/koishi-plugin-chatluna-dify-adapter`）
> API 依据：Dify 官方 Service API 文档（docs.dify.ai/zh/api-reference，含完整 OpenAPI 3.0.1 规范，82 个端点）
> 目的：为独立插件 **koishi-plugin-dify-ai**（`external/dify-ai`）的开发做技术铺垫
> 报告日期：2026-09-29

---

## 目录

1. [执行摘要](#一执行摘要)
2. [chatluna-dify-adapter 深度剖析](#二chatluna-dify-adapter-深度剖析)
3. [Dify Service API 全景](#三dify-service-api-全景)
4. [特色功能专题](#四特色功能专题)
5. [面向 dify-ai 的开发铺垫](#五面向-dify-ai-的开发铺垫)
6. [附录：端点速查表](#六附录端点速查表)

---

## 一、执行摘要

**现有适配器的定位**：`chatluna-dify-adapter` 是 ChatLuna 框架的平台适配器，把 Dify 上配置的每个应用（Chatbot / Agent / Chatflow / Workflow）伪装成一个 ChatLuna "模型"，使 Dify 应用可以被 ChatLuna 的会话系统、预设系统、群聊路由统一调度。它的策略是"**最小适配**"：只透传 `answer` 文本流，其余 Dify 能力（知识库管理、工作流细粒度事件、音频、消息历史、反馈、建议问题等）全部不碰。

**关键发现（对 dify-ai 最有价值）**：

| # | 发现 | 影响 |
|---|------|------|
| 1 | 适配器的 Workflow 分支（`_workflowStream`）只读 `data.answer`，但 Dify `/workflows/run` 的 SSE 事件里不存在 `answer` 字段（文本在 `text_chunk.data.text`、最终输出在 `workflow_finished.data.outputs`） | 现适配器对 Workflow 应用的流式输出实际为空；dify-ai 必须按事件类型分流处理 |
| 2 | Dify Service API 共 82 个端点，覆盖 5 类应用 + 知识库全生命周期 + 文件 + 音频 + 人工介入 | dify-ai 有巨大差异化空间，远超"聊天"范畴 |
| 3 | `user` 字段是 Dify 侧的"终端用户身份"，决定会话/文件/停止操作的数据隔离 | koishi 侧的 userId → Dify `user` 的映射是 dify-ai 的核心设计决策 |
| 4 | Dify conversation_id 与 koishi 会话的映射，现适配器用 ChatLuna cache 以 `dify/{chatlunaConvId}/{workflowName}` 为键存储 | dify-ai 需要自己的等价物（koishi database 表） |
| 5 | 文件上传是两步协议：`POST /files/upload`（multipart）拿 `id`，再以 `files: [{type, transfer_method, upload_file_id}]` 附加到消息 | 适配器的 data-URL/本地路径/远程 URL 三源归一化管线值得直接复用 |

---

## 二、chatluna-dify-adapter 深度剖析

### 2.1 包基本信息

- 名称：`koishi-plugin-chatluna-dify-adapter`，版本 1.4.1，AGPL-3.0，作者 dingyi222666（ChatLunaLab）
- `peerDependencies`: `koishi ^4.18.9`、`koishi-plugin-chatluna ^1.4.0`；`inject: ["chatluna", "database"]`
- 运行时依赖：`@chatluna/v1-shared-adapter`（请求信号等工具）、`@langchain/core`（消息类型）、`zod`；打包内嵌 undici（FormData/File）
- node_modules 中只有编译产物 `lib/index.mjs`（20,162 行，插件本体约占最后 1,000 行，从 `// src/index.ts` 标记开始，约 19144 行起）

### 2.2 三层架构

```
src/index.ts      apply(ctx, config)
   └─ ctx.on("ready") 内创建 ChatLunaPlugin(ctx, config, "dify")   # 平台名 "dify"
        ├─ plugin.parseConfig()   # koishi Schema 配置 → 平台配置数组
        ├─ plugin.registerClient(() => new DifyClient(...))
        └─ plugin.initClient()

src/client.ts     DifyClient extends PlatformModelClient
   ├─ platform = "dify"
   ├─ refreshModels()   # 把配置里的每个应用映射为一个"模型"
   └─ _createModel()    # 创建 ChatLunaChatModel(llmType: "dify")

src/requester.ts  DifyRequester extends ModelRequester   # 真正的 HTTP/SSE 逻辑
```

**配置 Schema**（含 zh-CN/en-US 双语 i18n）：

| 字段 | 类型/默认 | 说明 |
|------|-----------|------|
| `apiURL` | string, 必填 | 如 `https://api.dify.ai/v1`，所有端点直接拼在其后（`concatUrl = apiURL + path`） |
| `enableFileUpload` | boolean, 默认 true | 关闭后跳过上传与 `files` 字段 |
| `additionalModels` | table 数组 | 每项 `{apiKey(secret), workflowName, workflowType: Agent\|Workflow\|ChatBot, enabled}` |
| `maxContextRatio` | 0~1, 默认 0.35 | 截断 ChatLuna 侧注入的历史比例 |
| `temperature` | 0~2, 默认 1 | 透传 |

**模型伪装**：`refreshModels()` 把每个应用登记为 `{name: workflowName, type: llm, maxTokens: 1e11, capabilities: [ImageInput]}`——`maxTokens` 设成 10^11 是刻意 hack，让 ChatLuna 认为上下文近乎无限，实际窗口由 `maxContextRatio` 间接控制。`temperature` 等参数**并不会传给 Dify**（Dify 应用的提示词/模型参数在 Dify 侧编排时已固定）。

### 2.3 会话映射机制（核心状态设计）

ChatLuna 每个聊天会话有 `conversationId`（koishi 侧），Dify 每个对话有 `conversation_id`（UUID）。适配器的映射方案：

- **读取**：`getDifyConversationId()` → `ctx.chatluna.cache.get("chatluna/keys", "dify/" + chatlunaConvId + "/" + workflowName)`，值为 `JSON.stringify({id, user})`
- **写入时机**：仅在 Agent/ChatBot 流收到 `message_end` 事件时，把响应里的 `conversation_id` 回写（`updateDifyConversationId`）
- **Workflow 分支不写入**（Workflow 本无会话概念，每次 `/workflows/run` 都是独立运行）
- **清理**：`dispose(model, id)` → `DELETE /conversations/{difyConversationId}`（body 带 `{user}`），成功后删除缓存——对接 ChatLuna 的"清空聊天记录"能力
- **会话 ID 的来源链**（`completionStreamInternal` 开头）：`params.id` → `params.variables?.built?.conversationId` → `params.variables?.chatluna_conversation_id` → 遍历 `message.additional_kwargs` 中的 `chatluna_conversation_id / conversationId / conversation_id`；全空则直接抛错（该适配器只支持 ChatLuna chat 模式）

### 2.4 消息分流与请求构造

`completionStreamInternal` 按 `workflowType` 二分：

```
workflowType !== "Workflow"（ChatBot/Agent/Chatflow 混在一起）
   → _agentStream() → POST /chat-messages
      body: { query, response_mode: "streaming", inputs, user,
              conversation_id: difyConvId ?? "", files? }
workflowType === "Workflow"
   → _workflowStream() → POST /workflows/run
      body: { response_mode: "streaming", inputs, user, files? }
```

**SSE 处理**（两分支几乎相同）：用 ChatLuna 的 `sseIterable(response, {timeout, signal})` 迭代；对每个 `event.data` 做 `JSON.parse`；`event === "error"` 抛 `API_REQUEST_FAILED`；`data.answer != null` 时 yield `AIMessageChunk`；agent 分支在 `message_end` 持久化 conversation_id 后 break。超时/中止用 `createRequestSignal(params)`，abort 时抛出 signal.reason。

**`buildInputs()` 的约定注入**——适配器与 Dify 应用之间的"协议"（Dify 侧需在工作流里建同名变量）：

| 注入变量 | 内容 |
|----------|------|
| `input` | 最后一条消息的纯文本 |
| `chatluna_history` | 全历史 JSON：`[{role, content}]`，超 130,000 字符从头部丢弃（单条超限则截尾保留） |
| `chatluna_conversation_id` | koishi 侧会话 ID |
| `chatluna_user_id / bot_id / group_id / user_name` | 从 `params.variables` 透传 |
| `chatluna_multimodal` | 文件摘要 JSON（≤256 字符：has_files/file_count/files[idx,type,source 前 64 字符]） |
| `chatluna_{key}` | 其余所有 ChatLuna 变量逐一加前缀透传 |

**`resolveDifyUser()`**：ChatLuna `defaultGroupRouteMode === "personal"` 时用 `user_id`（回退 `user`，再回退 `"chatluna"`），否则统一 `"chatluna"`——即群聊模式下所有用户共享一个 Dify 终端用户身份及其会话。

### 2.5 文件上传管线（值得整体复用）

```
多模态消息 content[] 中的 image_url
   → extractUploadCandidates()          # 仅图片 URL，Set 去重
   → resolveFilePayload()               # 三源归一化为 {buffer, fileName, mimeType}
        ├─ data:...;base64,  → 直接解码
        ├─ 本地/file:// 路径 → fs.readFile（扩展名猜 MIME）
        └─ http(s)://        → plugin.fetch 下载（Content-Type 定 MIME，URL 定文件名）
   → uploadFileToDify()                 # POST /files/upload (undici FormData: file + user, Bearer key)
                                         兼容 result.data?.id ?? result.id
   → files: [{ type: image|document|audio|video|custom,   # mapMimeToFileType() 按 MIME 前缀映射
               transfer_method: "local_file",
               upload_file_id }]
```

注意：**Agent 应用的文件引用 Dify 不处理内容**（官方文档明示 Agent 接受引用但不消费），且上传失败是软失败（warn 后继续，不带该文件）。

### 2.6 已知局限与缺陷清单

1. **Workflow 流式输出为空（功能性 bug）**：`_workflowStream` 只 `yield data.answer`，而 `/workflows/run` 的 SSE 事件枚举为 `workflow_started / node_started / node_finished / node_retry / iteration_* / loop_* / reasoning_chunk / text_chunk / workflow_finished / tts_* / workflow_paused / agent_log / human_input_* / error / ping`——**没有 `answer` 字段**。文本块在 `text_chunk.data.text`，最终结果在 `workflow_finished.data.outputs`。
2. Chatflow（advanced-chat）虽有会话，但细粒度事件（node_started/finished、iteration、reasoning、message_file、workflow_paused 人工介入）全部被丢弃，只留 answer 文本。
3. Agent 的 `agent_thought`（工具调用过程）、`message_file`（工具产出文件 URL）、`message_replace`（内容审查替换）、`tts_message`（音频流）、`message_end.metadata.usage`（token/费用统计）与 `retriever_resources`（引用溯源）均未利用。
4. 不支持：`/completion-messages`（文本生成应用）、`stop`（中止生成）、`/messages`（历史拉取）、`/conversations` 列表/重命名/变量、反馈与建议问题、语音转写与 TTS、全部 `/datasets` 知识库 API、`/parameters`（输入表单发现——导致 inputs 只能靠 chatluna_* 约定盲注入）、`/info`（应用类型探测——导致 workflowType 靠用户手填）。
5. `user` 语义粗糙：群聊模式统一 `"chatluna"`，Dify 侧无法区分真实用户（反馈/统计/会话归属全混在一起）。
6. 文件提取只认 `image_url` 多模态部件，音频/视频/文档（Koishi 的 `<audio>`/`<video>`/附件）不会进入上传管线。

---

## 三、Dify Service API 全景

### 3.1 基础约定

- **Base URL**：Dify Cloud `https://api.dify.ai/v1`；自部署为实例自身地址（适配器配置的 `apiURL`）。
- **认证**：全部端点 `Authorization: Bearer <API_KEY>`。密钥两类：
  - **应用密钥**（应用内创建，仅作用于该应用，一把 key 服务所有终端用户，用 `user` 区分）
  - **知识库密钥**（知识库页右上"服务 API"创建；scoped key 只能访问所选知识库——路径无 `dataset_id` 或 ID 越界时 403 `forbidden`；要调用"列出/创建知识库"必须选全量）
- **`user` 字段（终端用户身份）**：开发者自定义、Dify 不认证、首次出现即建档。作用范围：
  - 会话列表/历史/重命名/删除只作用于该 user 自己的会话
  - 文件归上传者所有，换 user 引用会失败
  - 对话类 stop 要求 user 与发起者一致（不一致则**静默无效**）；Workflow stop 不检查 user
  - 恢复人工介入流时 user 不一致返回 404
- **响应模式**：`streaming`（SSE，推荐）或 `blocking`（一次性返回；**Cloudflare 层 100 秒超时**，长任务必须用流式）。
- SSE 保活：`event: ping`，无 `data:` 载荷。

### 3.2 应用类型 × 端点矩阵

| 应用类型 | mode | 发送消息端点 | 会话 | 备注 |
|----------|------|--------------|------|------|
| Chatbot（基础）| `chat` | `POST /chat-messages` | 有 | 事件：message / message_end / tts 等 |
| Agent / 旧版 Agent | `agent` / `agent-chat` | `POST /chat-messages` | 有 | 额外 agent_message / agent_thought |
| Chatflow（对话流）| `advanced-chat` | `POST /chat-messages` | 有 | 额外全套工作流事件 + 人工介入 |
| Workflow（工作流）| `workflow` | `POST /workflows/run`（新版亦可 `/workflows/{workflow_id}/run`）| 无（有 workflow_run_id）| 事件以 text_chunk + workflow_finished 为主 |
| 文本生成 | `completion` | `POST /completion-messages` | 无 | 现适配器完全未支持 |

### 3.3 核心请求 Schema

**`POST /chat-messages`**（ChatRequest）：
```jsonc
{
  "inputs": { /* 应用输入变量，字段名来自 GET /parameters 的 user_input_form */ },
  "query": "用户消息",
  "response_mode": "streaming" | "blocking",
  "user": "终端用户标识",
  "conversation_id": "",          // 空则新会话；响应回传 conversation_id
  "files": [ InputFileObject ],    // 可选
  "auto_generate_name": true       // false 时可用 Rename Conversation 异步生成标题
}
```

**`POST /workflows/run`**（WorkflowExecutionRequest）：
```jsonc
{
  "inputs": {                     // 值可为 string | number | boolean | object | InputFileObject[]
    "query": "...",
    "files": [ InputFileObject ]  // 文件型变量放 inputs 里（区别于顶层 files）
  },
  "response_mode": "streaming",
  "user": "...",
  "files": [ InputFileObject ]    // 可选，视觉模型组合输入用
}
```

**`POST /completion-messages`**（CompletionRequest）：`{inputs, query?, response_mode, user, files?}`——`query` 已是遗留字段，新应用放 `inputs`。

**InputFileObject**（两种互斥形态）：
```jsonc
{ "type": "image|document|audio|video|custom",
  "transfer_method": "remote_url", "url": "https://..." }
// 或
{ "type": "...", "transfer_method": "local_file", "upload_file_id": "<来自 /files/upload>" }
```

### 3.4 SSE 事件体系（dify-ai 的重点）

**Chat 系（ChunkChatEvent discriminator，event 枚举）**：
`message, agent_message, agent_thought, tts_message, tts_message_end, message_file, message_end, message_replace, workflow_started/finished/paused, node_started/finished/retry, iteration_started/next/completed, loop_started/next/completed, reasoning_chunk, text_chunk, agent_log, human_input_required, human_input_form_filled, human_input_form_timeout, error, ping`

**Workflow 系（ChunkWorkflowEvent）**：
`workflow_started, node_started, node_finished, node_retry, iteration_*, loop_*, reasoning_chunk, text_chunk, workflow_finished, tts_message, tts_message_end, workflow_paused, agent_log, human_input_*, error, ping`

关键事件载荷：

| 事件 | 关键字段 | 用途 |
|------|----------|------|
| `message` / `agent_message` | `answer`（增量文本）、`message_id`、`conversation_id`、`task_id` | 聊天文本流（task_id 供 stop 用） |
| `text_chunk` | `data.text`（增量）、`data.from_variable_selector`（来源变量路径，如 `["answer", "text"]`） | Workflow/Chatflow 文本流正解 |
| `reasoning_chunk` | `data.reasoning`（增量思考）、`data.is_final`、`data.node_id` | 分离式思维链；与 message 流并行、互不污染 |
| `agent_thought` | thought / tool / tool_input / observation 等 | Agent 工具调用过程可视化 |
| `message_file` | `url`、`type`（如 image）、`belongs_to: "assistant"` | 工具生成的文件（可直接下载/转发） |
| `message_replace` | `answer`、`reason` | 内容审查替换（应整体覆盖已流出的文本） |
| `node_finished` | `data.node_id/node_type/status/elapsed_time/inputs/outputs/error/execution_metadata(含 token)` | 节点级执行明细（进度展示/调试） |
| `workflow_finished` | `data.outputs/status/total_steps/total_tokens/elapsed_time/error/workflow_run_id`；status: running/succeeded/failed/stopped/partial-succeeded/paused | 最终输出（Workflow 模式的答案源） |
| `message_end` | `metadata.usage`（prompt/completion/total tokens + 价格 + latency）、`metadata.retriever_resources[]`（引用溯源：dataset/document/segment/score/hit_count） | 用量统计与知识库引用 |
| `tts_message` / `tts_message_end` | `audio`（base64 MP3 分片/空串收尾） | 语音输出流 |
| `error` | `code / message / status` | 流内错误 |

### 3.5 辅助端点

- `GET /info` → `{name, description, tags, mode, author_name}`：**可用来探测应用类型**（mode 即上表），校验 key 与自动判断 workflowType。
- `GET /parameters` → 应用输入表单（user_input_form：变量名/类型/必填/选项）、文件上传设置、系统参数——**动态生成 inputs 与本地表单的正道**。
- `GET /meta` → 工具图标等元信息（渲染 agent 过程用）。
- `GET /messages?conversation_id=&user=&first_id=&limit=`：分页拉取历史（游标 `first_id` 向前翻页）。
- `GET /conversations?user=&last_id=&limit=&sort_by=` / `DELETE /conversations/{id}`（body `{user}`）/ `POST /conversations/{id}/name`（`{name, auto_generate}`）/ 会话变量 GET + PUT。
- `POST /chat-messages/{task_id}/stop`、`POST /workflows/tasks/{task_id}/stop`（body `{user}`）。
- `POST /messages/{message_id}/feedbacks`（like/dislike + 可附文字）、`GET /app/feedbacks`。
- `GET /messages/{message_id}/suggested`：下一轮建议问题。
- `POST /audio-to-text`（multipart 音频，MP3/M4A/WAV/AMR/MPGA，≤30MB）、`POST /text-to-audio`（文本/消息引用合成语音）。
- 标注（Annotations）CRUD + `annotation-reply/{action}` 异步配置 + 任务状态轮询——命中标注直接返回预设答案。
- `GET /workflows/logs`（运行级日志：状态/token/步数/耗时）、`GET /workflows/run/{workflow_run_id}`（执行详情）、`GET /workflow/{workflow_run_id}/events?user=`（**断线续传/恢复执行的事件流**，`continue_on_pause` 可续跑）。

### 3.6 人工介入（Human-in-the-loop）——Chatflow/Workflow 的高级能力

1. 监听流中 `human_input_required` 事件 → 取 `data.form_token` 与 `workflow_run_id`
2. `GET /form/human_input/{form_token}` 加载表单（含 actions 按钮定义：id/title/button_style、expiration_time）
3. `POST /form/human_input/{form_token}` 提交（选中 action 传 `action` 字段）→ 运行恢复
4. `GET /workflow/{workflow_run_id}/events` 打开新事件流跟踪至完成（`workflow_paused` 时 `data.paused_nodes/reasons`）

对 koishi 场景极具价值：可把 form 渲染为消息按钮/选择器，把 QQ/微信群聊变成 Dify 审批流的前端。

---

## 四、特色功能专题

### 4.1 工作流（Workflow）

- 一次 `/workflows/run` = 一次独立执行（无 conversation），产出 `workflow_run_id`；`GET /workflows/run/{id}` 随时查详情。
- 输入来自 `inputs`（变量名/类型用 `/parameters` 发现；**文件型变量直接放 inputs 里以 InputFileObject[] 形式**，与顶层 `files` 的"视觉模型附加图"用途不同）。
- 文本输出：流式看 `text_chunk`（带 from_variable_selector 可区分多个回答变量），最终看 `workflow_finished.data.outputs`。
- 节点事件（node_started/finished/retry、iteration、loop）可做执行进度条/调试面板；`agent_log` 提供 agent 节点内部日志。

### 4.2 对话流（Chatflow, advanced-chat）

- 与 Chatbot 同端点 `/chat-messages`、同有 conversation_id 多轮上下文，但事件流叠加全部工作流事件。
- 独有能力：**人工介入暂停/恢复**、会话变量（跨轮持久，GET/PUT `/conversations/{id}/variables`）、`auto_generate_name` 控制标题生成。
- 会话管理与 Chatbot 完全一致（列表/重命名/删除/历史/建议问题/反馈）。

### 4.3 知识库的调用（检索）

`POST /datasets/{dataset_id}/retrieve`（**调用面，也是测试检索接口**）：
```jsonc
{
  "query": "检索文本（≤250 字符）",
  "retrieval_model": {
    "search_method": "keyword_search | semantic_search | full_text_search | hybrid_search",
    "reranking_enable": true,
    "reranking_mode": "reranking_model | weighted_score",
    "reranking_model": { "provider": "...", "model": "..." },
    "weights": { /* 加权分数模式的权重 */ },
    "top_k": 5,
    "score_threshold_enabled": true,
    "score_threshold": 0.5,
    "metadata_filtering_conditions": { "conditions": [
      { "name": "字段名", "comparison_operator": "is | contains | = | > | before | in | ...", "value": "..." }
    ]}
  },
  "external_retrieval_model": { /* 外部知识库时的精简参数 */ }
}
```
响应 `records[]` 含 content、score、segment/document/dataset 归属、child_chunks（父子分段）。元数据过滤条件按类型支持 19 种比较算子。**用途**：在 koishi 里做独立的 RAG 查询命令，或为 prompt 动态拼装上下文。

### 4.4 知识库的操作（管理面，共 40+ 端点）

- **知识库 CRUD**：`GET/POST /datasets`、`GET/PATCH/DELETE /datasets/{id}`。创建参数：`name(≤40)`、`description(≤400)`、`indexing_technique: high_quality|economy`、`permission: only_me|all_team_members|partial_members`、embedding 模型与 provider（`GET /workspaces/current/models/model-types/text-embedding` 可查）、`provider: vendor|external` + 外部知识库双字段。
- **文档管理**：`create-by-text`（name + text + doc_form: text_model|hierarchical_model|qa_model + process_rule: automatic|custom|hierarchical，可配 separator/max_tokens/chunk_overlap/预处理规则 remove_stopwords|remove_extra_spaces|remove_urls_emails）/ `create-by-file`（multipart data-source file）；`update-by-text`（**update-by-file 已废弃**）；列表/详情/单下载/批量 ZIP（≤100）/删除/批量启停用。
- **异步索引状态机**：创建文档返回 `batch` ID → `GET /documents/{batch}/indexing-status` 轮询，阶段 waiting → parsing → cleaning → splitting → indexing → completed|error。
- **分段（Chunk）管理**：CRUD + 父子模式的子分段 CRUD（API 建的 `type: "customized"`，系统建的 `automatic`）；问答模式分段需 `content + answer`。
- **元数据**：自定义字段（string/number/time）CRUD、内置字段（document_name/uploader 等）管理、按文档批量更新元数据——可当外部同步键用。
- **标签**：工作空间级标签 CRUD + 与知识库的绑定/解绑。
- **知识流水线（Pipeline，较新）**：pipeline/file-upload、datasource-plugins 列表、单节点执行、整条流水线运行（streaming/blocking）。

### 4.5 文件的上传

- `POST /files/upload`（multipart/form-data：`file`（二进制，文件名不能含 `/` `\`）+ `user`），响应 `{id, name, mime_type, size, extension, preview_url, source_url(签名下载 URL), created_by, ...}`。
- 大小限制（默认，自部署可环境变量调）：图片 10MB、音频 50MB、视频 100MB、其他 15MB；扩展名黑名单 `UPLOAD_FILE_EXTENSION_BLACKLIST`。
- 归属规则：文件属于上传时的 `user`，只有同 user 的后续请求能引用。
- `GET /files/{file_id}/preview`：仅当前应用内消息所属文件可下载。
- 之后以 `InputFileObject`（remote_url 或 local_file+upload_file_id）附加到 chat/completion/workflow 请求，或作为 workflow 文件型变量的值。
- Agent 应用接受文件引用但**不处理内容**（官方文档明示）。

---

## 五、面向 dify-ai 的开发铺垫

### 5.1 定位差异化

`external/dify-ai`（`koishi-plugin-dify-ai` v0.0.1，目前是空壳）应定位为**不依赖 ChatLuna 的独立 Koishi 插件**，直接面向 Dify Service API，把 Dify 的全部能力面（而不只是聊天文本流）暴露给 Koishi 用户。与 chatluna 适配器互补：

| 维度 | chatluna-dify-adapter | dify-ai（目标） |
|------|----------------------|------------------|
| 框架依赖 | ChatLuna（必须） | 无（可选联动） |
| 应用接入方式 | 手工配置 workflowName/Type | `/info` + `/parameters` 自动发现校验 |
| Workflow 输出 | ✕（读错字段） | text_chunk + workflow_finished.outputs |
| 知识库 | ✕ | 检索命令 + 管理命令 |
| 音频/TTS/反馈/建议/历史 | ✕ | 全支持 |
| 人工介入 | ✕ | 表单渲染为会话内交互 |

### 5.2 推荐架构

```
src/
  index.ts        # apply：注册 service、commands、i18n
  client.ts       # DifyClient：fetch 封装（Bearer、baseUrl 拼接、错误归一化）
  schemas.ts      # zod/类型：请求与全部 SSE 事件的判别式联合
  sse.ts          # SSE 解析器（含 event: ping 保活、100s 心跳约束、abort 支持）
  apps/           # 应用类型子模块：chat.ts / workflow.ts / completion.ts（各自的事件归约器）
  knowledge.ts    # datasets 全套操作 + retrieve
  files.ts        # 三源归一化上传管线（可移植自现适配器 utils）
  store.ts        # koishi database：会话映射、表单等待状态
  commands/       # dify.chat / dify.ask / dify.kb.* / dify.file ...
```

**数据库表建议**：
- `dify_conversation`: `channelId+userId(唯一) → {appKey别名, difyConversationId, difyUser, lastMessageId}`（对应适配器的 chatluna cache 方案，但按频道而非 ChatLuna 会话）
- `dify_pending_forms`: `form_token → {channelId, userId, actions, expireAt}`（人工介入）

### 5.3 关键设计决策

1. **user 映射**：建议默认 `koishi:{platform}:{userId}`（稳定、可读、天然唯一），群共享模式作可选项（对齐现适配器 group 路由的取舍，但把选择权给用户）。
2. **事件归约策略**：`message/agent_message → 文本流`；`text_chunk(from_variable_selector) → 工作流文本流`；`workflow_finished.outputs → 结构化输出`（可渲染 JSON/文件）；`agent_thought/agent_log/node_finished → 可选调试通道`（用 koishi session 分段消息或引用回复呈现）；`message_file → 直接下载转发`；`message_replace → 整体覆盖已发内容`（koishi 侧用消息编辑/撤回重发）；`usage → 附加引用消息`（token/耗时/引用溯源）。
3. **Workflow 输出的正确姿势**（修正适配器 bug）：流式渲染 `text_chunk`；`workflow_finished` 后若 `outputs` 含非文本（文件/对象），做结构化展示；`outputs` 中文件（image/file 类型 URL）直接作为 koishi 媒体消息发送。
4. **输入表单发现**：初始化时对配置的每个 app 调 `GET /info`（校验 key、拿 mode 自动定型）+ `GET /parameters`（拿 user_input_form），把"手填 workflowType"变成自动探测，并能为 `dify.ask` 动态生成参数语法。
5. **长任务与中止**：一律 `response_mode: "streaming"`（避开 blocking 100s 超时）；koishi 消息事件绑定 AbortController，提供"停止"指令 → `POST /chat-messages/{task_id}/stop`（记得带同一 user，否则静默无效）。
6. **知识库命令面**（示例）：
   - `dify.kb.search <库> <query>` → retrieve（暴露 top_k/score/search_method 选项）
   - `dify.kb.list / info / create / delete`
   - `dify.kb.doc.add-text <库> <名称>`（引用回复正文）、`dify.kb.doc.add-file`（附件）、`dify.kb.doc.status <batch>`（轮询索引）
   - `dify.kb.seg.*`（分段增删改查）
   - 权限：知识库密钥与 app 密钥分开配置；scoped key 只能访问所选库（列库 403 属预期，命令层要给友好提示）。
7. **文件命令**：`dify.upload`（附件 → /files/upload → 回显 id），聊天自动上传沿用三源归一化管线；文件型 workflow 变量放 `inputs`。
8. **人工介入**：`human_input_required` → 用 koishi `session.send` + 按钮/序号选择 → 提交 `POST /form/human_input/{form_token}` → `GET /workflow/{run_id}/events` 续流。
9. **TTS/语音**：`text-to-audio` 产出可作语音消息发送；`audio-to-text` 可把语音消息转文字再进对话（MP3/M4A/WAV/AMR/MPGA ≤30MB，QQ 语音常见 silk 格式需先转码——注意这是实现难点）。

### 5.4 风险与注意事项

- **100s Cloudflare 超时**只影响 blocking 模式，坚持 streaming 即可；但 SSE 也需处理长时间无数据的 `ping`。
- `user` 不一致引发的三类静默/404 行为（stop 静默、恢复 404、文件引用失败）——必须全链路同一 user。
- Workflow 无 conversation：频道内连续对话不要误传 conversation_id；每次执行的记忆要靠 `chatluna_history` 式的 inputs 约定或 Dify 侧变量。
- 文档创建是异步状态机，命令层必须轮询 `indexing-status` 并处理 error 态。
- 知识库密钥 403 的两种含义（key 越界 / 库关闭了"访问 API"开关）需区分提示。
- `update-by-file` 已废弃，统一用 update-by-text。
- 适配器把 `maxTokens` 设 1e11 的 hack 是 ChatLuna 框架约束所致，dify-ai 独立实现时无需继承。
- AGPL-3.0：若直接移植 chatluna-dify-adapter 的 utils 代码（三源文件归一化等），dify-ai 需保持 AGPL 兼容（该函数族逻辑简单，重写亦可规避）。

### 5.5 建议的发布节奏

- **P0（跑通主链路）**：DifyClient + SSE 解析 + chat-messages 全事件归约 + 会话映射表 + /info+/parameters 自动发现 + 文件上传（图片）
- **P1（补齐特色）**：workflows/run 正确流式 + outputs 渲染 + stop + 历史拉取 + 建议问题 + feedback + completion-messages + agent_thought/message_file 呈现
- **P2（管理面）**：知识库全套命令 + 检索命令 + 元数据过滤 + 文档异步索引轮询
- **P3（高阶）**：人工介入表单、TTS/语音、标注管理、workflow logs 面板

---

## 六、附录：端点速查表

完整 OpenAPI 规范已存于 `cache/dify-research/dify_openapi.json`（808KB，openapi 3.0.1，82 端点）。

**应用面**：`GET /info` · `GET /parameters` · `GET /meta` · `GET /site` · `POST /chat-messages` · `POST /chat-messages/{task_id}/stop` · `POST /completion-messages` · `POST /completion-messages/{task_id}/stop` · `POST /workflows/run` · `POST /workflows/{workflow_id}/run` · `POST /workflows/tasks/{task_id}/stop` · `GET /workflows/run/{id}` · `GET /workflow/{id}/events` · `GET /workflows/logs`

**会话面**：`GET /conversations` · `DELETE /conversations/{id}` · `POST /conversations/{id}/name` · `GET|PUT /conversations/{id}/variables[/var]` · `GET /messages` · `POST /messages/{id}/feedbacks` · `GET /messages/{id}/suggested` · `GET /app/feedbacks`

**文件/音频**：`POST /files/upload` · `GET /files/{id}/preview` · `POST /audio-to-text` · `POST /text-to-audio`

**人工介入**：`GET|POST /form/human_input/{form_token}`

**知识库**：`GET|POST /datasets` · `GET|PATCH|DELETE /datasets/{id}` · `POST /datasets/{id}/retrieve` · 文档：`POST .../document/create-by-text|create-by-file|update-by-text` · `GET .../documents` · `GET .../documents/{batch}/indexing-status` · `GET|PATCH|DELETE .../documents/{doc}` · `GET .../documents/{doc}/download` · `POST .../documents/download-zip` · `POST .../documents/status/{action}` · `POST .../documents/metadata` · 分段：`GET|POST .../segments` · `GET|POST|PATCH|DELETE .../segments/{seg}` · 子分段：`GET|POST .../segments/{seg}/child_chunks` · `PATCH|DELETE .../child_chunks/{id}` · 元数据：`GET|POST .../metadata` · `GET|POST .../metadata/built-in[/{action}]` · `PATCH|DELETE .../metadata/{id}` · 标签：`GET|POST|PATCH|DELETE /datasets/tags` · `POST /datasets/tags/binding|unbinding` · `GET /datasets/{id}/tags` · 流水线：`POST /datasets/pipeline/file-upload|run|datasource/nodes/{id}/run` · `GET /datasets/{id}/pipeline/datasource-plugins`

**其他**：`GET /end-users/{id}` · `GET /workspaces/current/models/model-types/{type}` · 标注：`GET|POST /apps/annotations` · `PUT|DELETE /apps/annotations/{id}` · `POST /apps/annotation-reply/{action}` · `GET /apps/annotation-reply/{action}/status/{job_id}`

---

*本报告基于 node_modules 内编译产物逆向阅读 + Dify 官方 OpenAPI 规范与中文指南文档（2026-09 抓取）交叉验证写成。插件源码引用对应 `node_modules/koishi-plugin-chatluna-dify-adapter/lib/index.mjs`（src 段约 19144–20154 行）。*
