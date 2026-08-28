/**
 * 自定义 ChatTransport：在进程内调用 `streamText` 并返回 UI 消息流。
 *
 * 不经过 HTTP，直接在 webview JS 中调用 LLM API（通过 Tauri fetch 绕过 CORS）。
 * 适用于 Tauri 桌面应用等无后端 API 端点的单进程场景。
 */
import { streamText, toUIMessageStream, convertToModelMessages, type UIMessage, type UIMessageChunk } from "ai"
import { createProvider, type ProviderConfig } from "./ai-provider"

/** Provider 创建 + 模型 + 系统提示词 + 温度配置。 */
export interface TransportConfig extends ProviderConfig {
  model: string
  temperature: number
}

/**
 * 创建自定义 ChatTransport 实例。
 *
 * 每次 `sendMessages` 调用：
 * 1. 将 UI 消息转为模型消息；
 * 2. 调用 `streamText` 发起流式对话；
 * 3. 通过 `toUIMessageStream` 转换为 `ReadableStream<UIMessageChunk>`。
 *
 * @param config 供应商/模型/温度配置
 * @param systemPrompt 可选系统提示词（每次调用时读取最新值）
 */
export function createChatTransport(config: TransportConfig, getSystemPrompt: () => string | undefined) {
  const provider = createProvider(config)
  const model = provider.chat(config.model)

  return {
    async sendMessages({ messages, abortSignal }: { messages: UIMessage[]; abortSignal?: AbortSignal }) {
      const modelMessages = await convertToModelMessages(messages)
      const result = streamText({
        model,
        system: getSystemPrompt(),
        messages: modelMessages,
        temperature: config.temperature,
        abortSignal,
      })
      return toUIMessageStream({ stream: result.stream }) as ReadableStream<UIMessageChunk>
    },
    async reconnectToStream() {
      return null
    },
  }
}
