/**
 * useAIChat：封装 Vercel AI SDK 的 `useChat`，集成 Profile 管理、
 * 会话历史持久化、上下文注入与流式终止。
 *
 * - 从 Tauri Store 加载 Profile 列表与激活 Profile；
 * - 配置就绪时创建自定义 ChatTransport；
 * - 暴露 `setContext` 供工作台注入当前代码上下文（自动转为系统提示词）；
 * - 支持新建对话、切换对话、删除对话、终止流式生成；
 * - 流式完成后自动持久化会话。
 */
import { useMemo, useRef, useCallback, useEffect, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { createChatTransport, type TransportConfig } from "../lib/ai-transport"
import {
  loadProfiles, loadActiveProfile, saveActiveProfileId,
  isProfileReady, updateProfile, type AiProfile,
} from "../lib/ai-profiles"
import {
  loadConversationIndex, loadConversation, saveConversation,
  createConversation, deleteConversation, renameConversation,
  generateTitle, type ConversationMeta,
} from "../lib/ai-history"
import type { UIMessage } from "ai"
import type { ViewKind } from "../lib/api"

/** AI 对话上下文：当前激活标签的代码信息。 */
export interface ChatContext {
  projectName: string
  /** 项目文件绝对路径（用作会话历史关联键）。 */
  projectPath: string
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

export function useAIChat(context: ChatContext | null) {
  // ---- Profile 状态 ----
  const [profiles, setProfiles] = useState<AiProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<AiProfile | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)

  // ---- 会话状态 ----
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [showConversationList, setShowConversationList] = useState(false)

  // ---- 系统提示词（通过 ref 传递给 transport，避免重建 transport） ----
  const systemPromptRef = useRef<string | undefined>(undefined)

  // 上下文变化时更新系统提示词
  useEffect(() => {
    systemPromptRef.current = context ? buildSystemPrompt(context) : undefined
  }, [context])

  // ---- 加载 Profiles ----
  const reloadProfiles = useCallback(async () => {
    const list = await loadProfiles()
    setProfiles(list)
    const active = await loadActiveProfile()
    setActiveProfile(active)
    setConfigLoaded(true)
  }, [])

  useEffect(() => {
    void reloadProfiles()
  }, [reloadProfiles])

  // 设置页保存配置后自动重载
  useEffect(() => {
    const reload = () => void reloadProfiles()
    window.addEventListener("hark:ai-config-saved", reload)
    return () => window.removeEventListener("hark:ai-config-saved", reload)
  }, [reloadProfiles])

  // ---- 加载会话列表（项目变化时） ----
  const reloadConversations = useCallback(async (projectKey: string) => {
    if (!projectKey) return
    const list = await loadConversationIndex(projectKey)
    setConversations(list)
  }, [])



  // ---- Transport 构建（依赖 activeProfile） ----
  const configReady = activeProfile !== null && isProfileReady(activeProfile)

  const transport = useMemo(() => {
    if (!activeProfile || !isProfileReady(activeProfile)) return undefined
    const tc: TransportConfig = {
      baseURL: activeProfile.baseURL,
      apiKey: activeProfile.apiKey,
      model: activeProfile.model,
      temperature: activeProfile.temperature,
    }
    return createChatTransport(tc, () => systemPromptRef.current)
  }, [activeProfile])

  const chat = useChat({
    transport,
    onError: (error) => {
      console.error("[AI Chat]", error)
    },
  })
  const setMessagesRef = useRef(chat.setMessages)
  setMessagesRef.current = chat.setMessages
  const clearErrorRef = useRef(chat.clearError)
  clearErrorRef.current = chat.clearError

  // ---- 项目变化时重载会话列表并清空当前对话 ----
  useEffect(() => {
    if (context?.projectPath) {
      void reloadConversations(context.projectPath)
    } else {
      setConversations([])
    }
    // 切换项目时清空当前活跃对话，避免旧项目消息残留
    setMessagesRef.current([])
    clearErrorRef.current()
    setActiveConversationId(null)
    setShowConversationList(false)
  }, [context?.projectPath, reloadConversations])

  // ---- 会话持久化 ----
  const activeConversationIdRef = useRef<string | null>(null)
  activeConversationIdRef.current = activeConversationId
  const contextRef = useRef<ChatContext | null>(context)
  contextRef.current = context
  const activeProfileRef = useRef<AiProfile | null>(activeProfile)
  activeProfileRef.current = activeProfile
  const savingRef = useRef(false)

  /** 持久化当前会话。 */
  const persistCurrentConversation = useCallback(async () => {
    if (savingRef.current) return
    const ctx = contextRef.current
    if (!ctx?.projectPath) return
    const messages = chat.messages
    if (messages.length === 0) return

    savingRef.current = true
    try {
      const convId = activeConversationIdRef.current
      const now = Date.now()
      const title = generateTitle(messages)

      if (convId) {
        // 更新已有会话
        const existing = await loadConversation(convId)
        if (existing) {
          existing.messages = messages
          existing.title = title
          existing.updatedAt = now
          existing.messageCount = messages.length
          await saveConversation(existing)
        } else {
          // 会话不存在（可能被删除），创建新的
          await createConversation(ctx.projectPath, messages, activeProfileRef.current?.id)
        }
      } else {
        // 创建新会话
        const conv = await createConversation(ctx.projectPath, messages, activeProfileRef.current?.id)
        setActiveConversationId(conv.id)
      }

      // 刷新会话列表
      void reloadConversations(ctx.projectPath)
    } finally {
      savingRef.current = false
    }
  }, [chat.messages, reloadConversations])

  // 流式完成后自动保存（status 从 streaming → ready）
  const prevStatusRef = useRef<string>(chat.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    const curr = chat.status
    prevStatusRef.current = curr
    if (prev === "streaming" && curr === "ready") {
      void persistCurrentConversation()
    }
  }, [chat.status, persistCurrentConversation])

  // ---- 关闭窗口/软件时保存当前对话 ----
  const persistRef = useRef(persistCurrentConversation)
  persistRef.current = persistCurrentConversation
  useEffect(() => {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    if (!isTauri) return
    const win = getCurrentWindow()
    const unlisten = win.onCloseRequested(async (event) => {
      event.preventDefault()
      try {
        await persistRef.current()
      } catch { /* ignore */ }
      await win.destroy()
    })
    return () => { void unlisten.then(fn => fn()) }
  }, [])

  // ---- 新建对话 ----
  const startNewConversation = useCallback(() => {
    // 先保存当前对话
    void persistCurrentConversation()
    chat.setMessages([])
    clearErrorRef.current()
    setActiveConversationId(null)
    setShowConversationList(false)
  }, [chat, persistCurrentConversation])

  // ---- 切换对话 ----
  const switchConversation = useCallback(async (id: string) => {
    // 先保存当前对话
    void persistCurrentConversation()
    const conv = await loadConversation(id)
    if (!conv) return
    chat.setMessages(conv.messages as UIMessage[])
    clearErrorRef.current()
    setActiveConversationId(id)
    setShowConversationList(false)
  }, [chat, persistCurrentConversation])

  // ---- 删除对话 ----
  const removeConversation = useCallback(async (id: string) => {
    await deleteConversation(id)
    if (activeConversationIdRef.current === id) {
      chat.setMessages([])
      clearErrorRef.current()
      setActiveConversationId(null)
    }
    if (contextRef.current?.projectPath) {
      void reloadConversations(contextRef.current.projectPath)
    }
  }, [chat, reloadConversations])

  // ---- 重命名对话 ----
  const renameConv = useCallback(async (id: string, title: string) => {
    await renameConversation(id, title)
    if (contextRef.current?.projectPath) {
      void reloadConversations(contextRef.current.projectPath)
    }
  }, [reloadConversations])

  // ---- 切换 Profile ----
  const switchProfile = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId)
    if (!profile) return
    setActiveProfile(profile)
    await saveActiveProfileId(profileId)
  }, [profiles])

  // ---- 切换模型（可跨 Profile） ----
  const switchModel = useCallback(async (profileId: string, model: string) => {
    const profile = profiles.find(p => p.id === profileId)
    if (!profile) return

    // 更新激活 Profile（如果跨 Profile）
    if (profile.id !== activeProfile?.id) {
      setActiveProfile(profile)
      await saveActiveProfileId(profileId)
    }

    // 更新当前模型
    const updated = { ...profile, model }
    setActiveProfile(updated)

    // 持久化：若模型不在列表中则添加
    if (!profile.models.includes(model)) {
      const newModels = [...profile.models, model]
      await updateProfile(profileId, { model, models: newModels })
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, model, models: newModels } : p
      ))
    } else {
      await updateProfile(profileId, { model })
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, model } : p
      ))
    }
  }, [profiles, activeProfile])

  // ---- 终止流式 ----
  const stop = useCallback(() => {
    chat.stop()
  }, [chat])

  // ---- 重试：清除错误后，移除最后一条失败的 AI 消息并重发上一条用户消息 ----
  const retry = useCallback(() => {
    clearErrorRef.current()
    const msgs = chat.messages
    // 找到最后一条用户消息的文本
    let lastUserText: string | undefined
    let lastUserIndex = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        lastUserText = msgs[i].parts
          .map(p => (p.type === "text" ? p.text : ""))
          .join("")
          .trim()
        lastUserIndex = i
        break
      }
    }
    if (!lastUserText) return
    // 移除从最后一条用户消息开始的所有消息（含失败的 AI 回复），再重发
    setMessagesRef.current(msgs.slice(0, lastUserIndex))
    chat.sendMessage({ text: lastUserText })
  }, [chat])

  return {
    // chat 状态
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    status: chat.status,
    error: chat.error,
    clearError: chat.clearError,
    regenerate: chat.regenerate,
    retry,
    stop,

    // profile
    profiles,
    activeProfile,
    configLoaded,
    configReady,
    switchProfile,
    switchModel,

    // 会话管理
    conversations,
    activeConversationId,
    showConversationList,
    setShowConversationList,
    startNewConversation,
    switchConversation,
    removeConversation,
    renameConversation: renameConv,

    // 持久化
    persistCurrentConversation,
  }
}
