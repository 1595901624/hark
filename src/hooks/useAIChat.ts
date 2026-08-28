/**
 * useAIChat：封装 Vercel AI SDK 的 `useChat`，集成 AI 配置加载与上下文注入。
 *
 * - 从 Tauri Store 加载 AI 配置；
 * - 配置就绪时创建自定义 ChatTransport；
 * - 暴露 `setContext` 供工作台注入当前代码上下文（自动转为系统提示词）。
 */
import { useMemo } from "react"
import { useChat } from "@ai-sdk/react"
import { createChatTransport, setSystemPrompt } from "../lib/ai-transport"
import { loadAiConfig, isConfigReady, type AiConfig } from "../lib/ai-config"
import { useEffect, useState } from "react"
import type { ViewKind } from "../lib/api"

/** AI 对话上下文：当前激活标签的代码信息。 */
export interface ChatContext {
  projectName: string
  activeNodeName: string
  activeView: ViewKind
  codeContent: string
  projectTreeSummary?: string
}

/** 组装系统提示词。 */
function buildSystemPrompt(context: ChatContext): string {
  const parts: string[] = [
    "你是鸿蒙 (HarmonyOS) Ark 字节码反编译分析专家。用户正在使用 Hark 反编译工具分析应用。",
    `当前打开的项目：「${context.projectName}」，正在查看节点：${context.activeNodeName}（${context.activeView} 视图）。`,
  ]
  if (context.projectTreeSummary) {
    parts.push(`项目结构摘要：\n${context.projectTreeSummary}`)
  }
  if (context.codeContent) {
    const truncated = context.codeContent.length > 6000
      ? context.codeContent.slice(0, 6000) + "\n…（内容已截断）"
      : context.codeContent
    parts.push(`当前代码内容：\n\`\`\`\n${truncated}\n\`\`\``)
  }
  parts.push("请基于以上上下文回答用户的问题。如果用户的问题与当前代码无关，可以忽略上下文直接回答。")
  return parts.join("\n\n")
}

export function useAIChat() {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [context, setContext] = useState<ChatContext | null>(null)

  useEffect(() => {
    void loadAiConfig().then(cfg => {
      setConfig(cfg)
      setConfigLoaded(true)
    })
  }, [])

  // 设置页保存配置后自动重载
  useEffect(() => {
    const reload = () => void loadAiConfig().then(setConfig)
    window.addEventListener("hark:ai-config-saved", reload)
    return () => window.removeEventListener("hark:ai-config-saved", reload)
  }, [])

  useEffect(() => {
    setSystemPrompt(context ? buildSystemPrompt(context) : undefined)
  }, [context])

  const transport = useMemo(() => {
    if (!config || !isConfigReady(config)) return undefined
    return createChatTransport(config)
  }, [config])

  const chat = useChat({ transport })

  return {
    ...chat,
    config,
    configLoaded,
    configReady: config !== null && isConfigReady(config),
    context,
    setContext,
    reloadConfig: async () => {
      const cfg = await loadAiConfig()
      setConfig(cfg)
    },
  }
}
