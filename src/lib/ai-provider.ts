/**
 * AI Provider 工厂：根据配置创建 OpenAI 兼容的 provider 实例。
 *
 * 使用 `@ai-sdk/openai` 的 `createOpenAI`，传入自定义 `baseURL` 与
 * Tauri 原生 `fetch`（绕过浏览器 CORS 限制）。
 */
import { createOpenAI } from "@ai-sdk/openai"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import type { AiConfig } from "./ai-config"

/**
 * 根据配置创建 OpenAI 兼容 provider。
 *
 * `tauriFetch` 将 HTTP 请求路由到 Rust 后端的 reqwest，不受 webview
 * CORS / CSP 限制，API Key 也不会暴露在浏览器网络面板中。
 */
export function createProvider(config: AiConfig) {
  return createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey || "ollama",
    fetch: tauriFetch as unknown as typeof fetch,
  })
}
