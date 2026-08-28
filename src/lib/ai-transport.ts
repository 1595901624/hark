/**
 * 自定义 ChatTransport：在进程内调用 `streamText` 并返回 UI 消息流。
 *
 * 不经过 HTTP，直接在 webview JS 中调用 LLM API（通过 Tauri fetch 绕过 CORS）。
 * 适用于 Tauri 桌面应用等无后端 API 端点的单进程场景。
 */
import { streamText, toUIMessageStream, convertToModelMessages, type UIMessage, type UIMessageChunk, type ChatTransport } from "ai"
import { createProvider } from "./ai-provider"
import type { AiConfig } from "./ai-config"

/** 系统提示词（可选，由调用方通过 setSystemPrompt 注入）。 */
let systemPrompt: string | undefined

/** 设置下一次对话使用的系统提示词。 */
export function setSystemPrompt(prompt: string | undefined) {
  systemPrompt = prompt
}

/**
 * 创建自定义 ChatTransport 实例。
 *
 * 每次 `sendMessages` 调用：
 * 1. 将 UI 消息转为模型消息；
 * 2. 调用 `streamText` 发起流式对话；
 * 3. 通过 `toUIMessageStream` 转换为 `ReadableStream<UIMessageChunk>`。
 */
export function createChatTransport(config: AiConfig): ChatTransport<UIMessage> {
  const provider = createProvider(config)
  const model = provider.chat(config.model)

  return {
    async sendMessages({ messages, abortSignal }) {
      const modelMessages = await convertToModelMessages(messages as UIMessage[])
      const result = streamText({
        model,
        system: systemPrompt,
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
