# Claude Dynamic Proxy

本项目是一个本地 Claude 兼容动态代理，用来把 Claude 风格请求转发到多个 OpenAI-compatible 或 Anthropic-compatible Provider，并根据真实聊天探针延迟自动选择更快的可用源。

默认本地地址：

```text
http://127.0.0.1:8088
```

## 快速启动

```powershell
bun install
bun run start
```

在当前机器上推荐使用：

```powershell
cd C:\Users\longlei\claude-dynamic-proxy
bun run start
```

启动后打开：

```text
http://127.0.0.1:8088/
```

## 功能清单

- 本地 Claude-compatible API 代理
- 支持 `POST /v1/messages`
- 支持 `GET /v1/models`
- 支持 OpenAI-compatible Provider，默认路径为 `/v1/chat/completions`
- 支持 Anthropic-compatible Provider，默认路径为 `/v1/messages`
- 支持 OpenAI SSE 流式响应转换为 Claude SSE 格式
- 支持动态路由模式：`manual`、`session`、`fastest`、`fallback`
- 支持按真实轻量聊天探针选择最快 Provider
- 自动健康检测，不只检测 `/v1/models`
- 启动后自动检测 Provider 可用性和真实聊天延迟
- 支持按配置间隔定时检测
- 支持一键测试所有 Provider
- 支持单个 Provider 手动测试
- Provider 卡片按可用性和延迟自动排序
- 支持隐藏不可用 Provider
- 支持查看当前模型会路由到哪个 Provider
- 支持右上角 `+ 添加` 手动新增单个 Provider
- 支持独立的 `批量导入` 功能，粘贴文本后自动识别 URL 和 `sk-...` key
- Provider 信息持久化保存到本地 `config.local.json`
- `config.local.json` 被 `.gitignore` 忽略，避免 API key 上传到 GitHub
- 支持基础上下文裁剪策略
- 支持上游失败时 fallback 到其他可用 Provider

## 页面功能

首页提供一个本地管理面板：

- Provider 卡片
- 可用 / 异常 / 检测中状态
- URL、Path、Key、Models 信息
- 真实聊天延迟
- 最近检测时间
- 单个测试按钮
- 一键测试按钮
- 隐藏不可用开关
- 手动添加 Provider 弹窗
- 批量导入文本识别弹窗
- 通用配置展示

## API 接口

```text
POST /v1/messages              Claude-compatible 聊天入口
GET  /v1/models                模型列表
GET  /health                   服务健康状态
GET  /providers                Provider 配置和指标
GET  /health-checks            Provider 自动检测结果
GET  /route-preview/:model     查看指定模型当前会选哪个 Provider
POST /providers/add            手动新增 Provider
POST /providers/import-text    从文本识别并批量导入 Provider
POST /providers/test-all       一键测试所有 Provider
POST /providers/:id/test       测试单个 Provider
```

## 客户端配置

在 Claude-compatible 客户端里这样填：

```text
Base URL: http://127.0.0.1:8088
API Key: 任意值，例如 sk-local
Model: claude-opus-4-1 或 claude-sonnet-4
```

实际会通过 `modelAliases` 映射到配置里的真实模型。

## 配置文件

复制示例配置：

```powershell
copy config.example.json config.local.json
```

然后编辑：

```text
config.local.json
```

OpenAI-compatible Provider 示例：

```json
{
  "id": "my-openai",
  "name": "My OpenAI Compatible",
  "type": "openai",
  "baseUrl": "https://api.example.com",
  "path": "/v1/chat/completions",
  "apiKey": "sk-xxxxx",
  "models": ["gpt-5.5"],
  "enabled": true,
  "priority": 10
}
```

Anthropic-compatible Provider 示例：

```json
{
  "id": "my-anthropic",
  "name": "My Anthropic Compatible",
  "type": "anthropic",
  "baseUrl": "https://api.example.com",
  "path": "/v1/messages",
  "apiKey": "sk-xxxxx",
  "models": ["claude-opus-4-1"],
  "enabled": true,
  "priority": 20
}
```

## 路由模式

```text
manual    固定使用 defaultProvider
session   每个会话第一次选择最快 Provider，后续固定
fastest   每次请求都选择当前最快可用 Provider
fallback  从 defaultProvider 开始，失败后切换备用 Provider
```

当前更适合多账号动态代理的模式：

```json
{
  "routing": {
    "mode": "fastest",
    "fallback": true,
    "healthCheckIntervalMs": 30000,
    "requestTimeoutMs": 20000
  }
}
```

## 上下文切换说明

代理本身不保存隐藏会话状态。Claude 客户端通常每次请求都会发送完整 `messages` 历史，所以切换 Provider 不一定丢上下文。

可能受影响的情况：

- 目标 Provider 上下文长度更短
- 不同模型对 system / tool / image / reasoning 字段支持不同
- Provider 侧 prompt cache 不共享
- 已经开始流式输出后不会中途切换 Provider

如果更重视上下文稳定性，可以使用 `session` 模式；如果更重视速度，可以使用 `fastest` 模式。

## 安全说明

`config.local.json` 存放本地账号和 API key，已在 `.gitignore` 中排除，不会提交到 GitHub。

批量文本识别功能在本机完成，只通过本地接口解析 URL 和 `sk-...` key，不会把文本发送到第三方识别服务。
