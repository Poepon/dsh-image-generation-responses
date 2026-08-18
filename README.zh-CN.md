# dsh-image-generation-responses

[English](./README.md)

这是一个 DeepSeek Harness Cordis 插件，通过 Responses API 提供图片工具：`generate_image`（经 `image_generation` 工具的文生图与图生图编辑）和 `analyze_image`（经普通视觉 completion 的图片理解）。生成结果会保存为 DSH 持久化 attachment，并由随包提供的 Web Client 视图直接渲染在对话中。

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
generate_image(prompt, images?, input_fidelity?, size?, quality?, background?, format?)
```

返回值包含持久化 attachment 引用、模型名、生成参数、实际使用的 `action`，以及服务端提供的调用 ID。模型侧内容由一段注明 attachment id 的文字摘要，以及**仅在对话模型声明支持图片输入时**才携带的 `image` ContentBlock 组成（每次调用根据会话请求头中的路由，通过 `llm.resolveModelInfo` 判定）。不支持图片输入的模型只会收到纯文本结果——pi-ai 等适配器在工具结果含模型无法读取的图片时会以 `UNSUPPORTED_CONTENT` 中止整轮。无论哪种情况，Web UI 都通过 presentation meta 正常渲染图片。

### 图生图（图片编辑）

传入 `images`（当前对话中已有图片的 attachment id）即切换为编辑模式，而非从零生成。此时 `prompt` 表示编辑指令。

```text
generate_image(prompt: "改成夜景", images: ["att_..."], input_fidelity: "high")
```

wire 层的变化：工具条目的 `action` 变为 `"edit"`（而非 `"generate"`），可选携带 `input_fidelity`；`input` 由字符串变为消息数组，内含一个 `input_text` 块和每张参考图对应的 `input_image` 块。不传 `images` 时，请求与原本的文生图形状完全一致。

需要注意的约束：

- 每次调用最多 8 张参考图。
- id 必须在当前会话自己的日志中可见。参考图字节通过 `attachments.readImage` 读回，而该方法会用存储对象校验完整引用（媒体类型、字节长度、原始宽高），因此仅有 id 无法读取 attachment，编辑范围也被限制在该会话本就能看到的图片内。
- `input_fidelity` 仅在编辑时有效，不带 `images` 传入会被拒绝。上游支持 `gpt-image-1`/`gpt-image-1.5` 及更新模型，不支持 `gpt-image-1-mini`。
- 无法解析的 id 会在解析密钥、发起服务商请求之前直接失败。

## 图片理解

```text
analyze_image(question, images) → answer
```

`analyze_image` 通过同一个 Responses 端点把对话中的图片交给视觉模型，用自然语言回答问题——描述内容、读取文字、对比、查看细节。它补全了 生成 → 检查 → 编辑 的闭环：纯文本对话模型可以把 `generate_image` 返回的 attachment id 交给它「看」，再根据文字回答发起更准确的编辑。

- 与生成共用 endpoint、凭据和引用解析；模型默认取 `responseModel`，可用 `visionModel` 覆盖。
- wire 调用是普通 completion（`input_text` + `input_image` 块，不带 `tools`），解析沿用同一套严格封装。
- 结果是纯文本，对任何对话路由都安全，不需要能力门控。

## 保存与对话渲染

Host half 严格解码 base64 后调用 `attachments.saveImage()`。DSH 会验证图片并保存到 attachment backend，不会自动在工作区生成普通 `.png` 文件。

Client half 在 `tool.call.toolview` 中注册 `generate_image` 专用视图，通过 conversation 服务取得当前 session 授权的 attachment URL，再使用 DSH `ImageGallery` 渲染，支持加载失败重试和原图预览。

## 会话图片侧栏

Client half 还提供会话图片侧栏：当前会话的全部持久化图片组成一条垂直居中的竖条，位于对话列旁边。

没有菜单栏或侧边栏按钮。上下文中有图片时侧栏自动出现，没有图片时完全不渲染。缩略图上限 120px，即对话历史中 240px `single` 尺寸的一半，按最新优先排序并按 attachment id 去重。

点击缩略图打开原图预览。侧栏通过 `document.body` portal 渲染并叠在预览之上，因此预览打开时侧栏依然可见可点：点击另一张缩略图会直接切换预览，无需先关闭。这个 portal 是必需的——`shell.overlay` 层自身在 `z-index: 20` 形成层叠上下文，否则侧栏会被压在预览的 `z-index: 1000` 之下。

侧栏只收集模型返回的图片——assistant 输出块和工具结果（包括内容块被裁剪时使用的 presentation meta 回退）；用户上传、steering 消息和 context 注入的图片会被刻意排除。它是使用命名空间 id 的可叠加 `shell.overlay` list 条目，不会替换任何随 DSH 发布的浮层 UI，且仅在挂载期间订阅当前会话的对话快照。它会测量侧边栏列宽，使其在侧边栏收起与拖动改变宽度时始终贴合对话列。

## 多语言

Web Client 的全部用户可见文案——工具行、图片侧栏、画廊与原图预览——都通过 shell 的 locale 服务本地化（`zh` 与 `en`，跟随当前语言及设置中的语言切换；locale 缺席时回退英文）。模型面文本（工具描述、结果摘要、错误消息）刻意保持英文。

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

React、React DOM 与 `@deepseek-ai/dsh-client-ui-attachment` 标记为 optional npm peer，是因为受支持的 DSH Web Shell 会将它们作为平台 seed module 提供；不支持脱离 DSH Shell 单独加载这个 Client half。

本插件引用的 DSH 宿主平台包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-llm`）声明为非 optional 的 npm peer——绝不放进 `dependencies`，避免安装时在插件目录嵌套副本遮蔽宿主自身版本。它们同时镜像在 `devDependencies` 中，供本地开发与 CI 跑测试。

安全问题请查看 [SECURITY.md](./SECURITY.md)，贡献流程请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)，维护者发布清单请查看 [RELEASING.md](./RELEASING.md)。

## 许可证

[MIT](./LICENSE) © Poepon 及贡献者。
