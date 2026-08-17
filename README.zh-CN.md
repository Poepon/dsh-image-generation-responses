# dsh-image-generation-responses

[English](./README.md)

这是一个 DeepSeek Harness Cordis 插件，通过 Responses API 的 `image_generation` 工具注册 `generate_image`。生成结果会保存为 DSH 持久化 attachment，并由随包提供的 Web Client 视图直接渲染在对话中。

## 支持的接口契约

本插件支持明确的 OpenAI 风格契约，并不声称兼容所有“OpenAI 兼容”服务：

- `POST {baseURL}/responses`
- `Authorization: Bearer <credential>`
- Responses API `image_generation` 工具
- 非流式 JSON 响应及 base64 图片结果

目前不支持 Azure 风格的 `api-version` query、`api-key` header、自定义 header、远程图片 URL 或旧的 `/images/generations` 接口。

## 环境要求

- Node.js 20.3 或更高版本
- 与 `0.1.0-rc.6` 兼容的 DeepSeek Harness 包
- 支持 Responses 生图工具的模型与服务端
- DSH `tools`、`credentials`、`attachments` 服务
- 对话内渲染需要标准 DSH Web Client 包

## 安装

在包含 `cordis.patch.yml` 的 DSH Web profile 中安装：

```bash
npm install dsh-image-generation-responses
```

在 profile patch 中挂载：

```yaml
- insert:
    - id: image-generation-responses
      name: dsh-image-generation-responses
      config:
        baseURL: https://api.openai.com/v1
        apiKeyEnv: OPENAI_API_KEY
        responseModel: gpt-5.6-sol
        imageModel: gpt-image-2
        size: 1024x1024
        quality: medium
        background: opaque
        format: png
        timeoutMs: 120000
        maxResponseBytes: 33554432
```

API Key 应通过 DSH credentials 服务或环境变量提供。不要把真实密钥写入 `cordis.patch.yml`，也不要提交到 Git。

首次安装后需要重启当前 DSH 进程并刷新网页。DSH 在进程启动时发现包的 Client half；包被发现后，后续 `lib/client.js` 修改可在对应 watcher 可用时走 Client HMR。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | 受信任的部署级 API Base，插件追加 `/responses`；query 和 fragment 会被移除。 |
| `apiKeyEnv` | `OPENAI_API_KEY` | 每次调用时通过 credentials 服务解析的凭据引用。 |
| `responseModel` | `gpt-5.6-sol` | Responses 请求的顶层模型；兼容服务通常需要覆盖。 |
| `imageModel` | `gpt-image-2` | `image_generation` 工具中的模型。 |
| `size` | `1024x1024` | `1024x1024`、`1024x1536`、`1536x1024` 或 `auto`。 |
| `quality` | `medium` | `low`、`medium`、`high` 或 `auto`。 |
| `background` | `opaque` | `opaque`、`transparent` 或 `auto`。 |
| `format` | `png` | `png`、`jpeg` 或 `webp`；透明背景与 JPEG 组合会被拒绝。 |
| `timeoutMs` | `120000` | 请求与工具的协作式超时。 |
| `maxResponseBytes` | `33554432` | JSON 响应体和解码图片的大小上限。 |

`baseURL` 必须由部署管理员控制，不能来自用户或模型输入。可信本地开发端点可以使用 HTTP，生产环境应使用 HTTPS。

## 工具

```text
generate_image(prompt, size?, quality?, background?, format?)
```

返回值包含持久化 attachment 引用、模型名、生成参数，以及服务端提供的调用 ID。模型侧内容由文字摘要和 `image` ContentBlock 组成。

## 保存与对话渲染

Host half 严格解码 base64 后调用 `attachments.saveImage()`。DSH 会验证图片并保存到 attachment backend，不会自动在工作区生成普通 `.png` 文件。

Client half 在 `tool.call.toolview` 中注册 `generate_image` 专用视图，通过 conversation 服务取得当前 session 授权的 attachment URL，再使用 DSH `ImageGallery` 渲染，支持加载失败重试和原图预览。

## 错误与限制

错误使用稳定的 `ImageGenerationError.code`，包括 `MISSING_CREDENTIAL`、`HTTP_ERROR`、`TIMEOUT`、`BAD_BASE64`、`OVERSIZED`、`REFUSED` 和 `MISSING_OUTPUT`。响应与图片大小有明确上限；远程图片 URL 和 HTTP redirect 会被拒绝。

提示词和生成图片会发送给配置的服务商处理，请在使用前确认其数据与内容政策。

## 开发

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

测试使用模拟 transport 和极小 fixture，不需要真实密钥，也不会发起付费生图请求。

`lib/client.js` 直接以 DSH 可分发的 browser module-loader 最终格式维护，不存在未提交的生成产物或隐藏转换步骤；修改时必须保持 `window.__ModuleLoader__.load({ id, factory })` 契约与平台 seed module 边界。

React 与 `@deepseek-ai/dsh-client-ui-attachment` 标记为 optional npm peer，是因为受支持的 DSH Web Shell 会将它们作为平台 seed module 提供；不支持脱离 DSH Shell 单独加载这个 Client half。

安全问题请查看 [SECURITY.md](./SECURITY.md)，贡献流程请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)，维护者发布清单请查看 [RELEASING.md](./RELEASING.md)。

## 许可证

[MIT](./LICENSE) © Poepon 及贡献者。
