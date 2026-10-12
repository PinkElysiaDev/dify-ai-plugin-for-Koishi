# koishi-plugin-dify-ai

在 Koishi 中接入 Dify 应用（Chatbot / Agent / Chatflow / Workflow / 文本生成）：消息触发后按规则调用 Dify，回答发回群聊或私聊。

## 特性

- **8 种触发条件**：关键词开头 / 包含关键词 / @ 机器人 / @ 指定用户 / 引用机器人 / 引用指定用户 / 定时摘要（Cron 或固定间隔，把消息池内积攒的群消息合并请求一次，无消息则跳过）/ 消息密度（池内消息达到阈值即触发；两种触发共用消息池，谁先触发谁清空），同一规则多条件任一命中即触发
- **多应用多规则**：规则按优先级匹配，按平台 / Bot / 群聊 / 频道 / 用户限定作用域
- **会话绑定**：按群聊 / 用户 / 频道 / 全局粒度续接 Dify 会话，`dify.conv.reset` 可重置
- **变量系统**：把会话字段、历史消息、触发元信息映射为 Dify inputs
- **文件上传**：消息中的图片 / 语音 / 附件自动上传并随请求发送
- **回复行为可调**：元素解析、引用触发消息、超长分段、文件上传开关

全部配置在 Koishi 控制台的插件配置页完成（应用配置 / 触发规则 / 回复行为 / 运行参数四组），保存即生效。

## 快速上手

1. 安装并启用插件（需要数据库服务）
2. 控制台打开「插件配置 → dify-ai」，在**应用配置**里添加应用（API 地址形如 `https://api.dify.ai/v1`，App Key 在 Dify 应用的「访问 API」页获取；应用类型默认自动探测）
3. 在**触发规则**里添加规则：选应用、加条件、按需限定作用域与变量映射
4. 在群里发一条命中条件的消息即可

koishi.yml 等价示例：

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
        - { source: session, field: query, key: content }
        - { source: session, field: chat_history, key: history, limit: 0 }
        - { source: meta, field: scene, key: triggerType }
  parseElements: false
  quoteTrigger: true
  maxSegmentLength: 0
  uploadFiles: true
  requestTimeout: 300000
  historyLimit: 20
  sendErrors: false
```

## 命令

| 命令 | 权限 | 说明 |
|---|---|---|
| `dify.conv.reset` | 3 | 重置当前频道的 Dify 会话绑定（下次触发新建会话） |

## 文档

- [架构设计文档](docs/architecture.md)：模块结构、触发判定顺序、会话绑定编码、Dify API 请求与响应结构、消息链路

## 许可

MIT
