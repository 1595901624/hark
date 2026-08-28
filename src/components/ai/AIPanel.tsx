/**
 * AI Agent 右侧面板：可折叠、可拖宽，集成 useAIChat 实现流式对话。
 *
 * 布局：顶部标题栏 + 消息列表（滚动）+ 快捷操作 + 输入框。
 * 无配置时显示配置引导；配置就绪后自动创建 transport。
 */
import { useEffect, useRef } from "react"
import { Bot, PanelRightClose, Settings, LoaderCircle, AlertCircle } from "lucide-react"
import { useAIChat, type ChatContext } from "../../hooks/useAIChat"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"
import { QuickActions } from "./QuickActions"
import { Button } from "../ui/base-ui"

interface AIPanelProps {
  isOpen: boolean
  onClose: () => void
  onOpenSettings: () => void
  context: ChatContext | null
}

export function AIPanel({ isOpen, onClose, onOpenSettings, context }: AIPanelProps) {
  const ai = useAIChat()

  // 同步外部上下文到 hook
  useEffect(() => {
    ai.setContext(context)
  }, [context]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [ai.messages])

  if (!isOpen) return null

  const isStreaming = ai.status === "streaming" || ai.status === "submitted"

  return (
    <aside className="flex min-h-0 w-full flex-col border-l border-default-200/80 bg-background">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-default-200/70 px-3">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-primary" />
          <span className="text-[12.5px] font-medium text-foreground">AI 助手</span>
          {ai.configReady && ai.config && (
            <span className="rounded bg-default-100 px-1.5 py-0.5 text-[10px] text-default-400 dark:bg-white/5">
              {ai.config.model}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="AI 设置"
            title="AI 设置"
            onPress={onOpenSettings}
            className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="关闭面板"
            title="关闭面板"
            onPress={onClose}
            className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 上下文提示 */}
      {context && ai.configReady && (
        <div className="shrink-0 border-b border-default-200/50 bg-primary/5 px-3 py-1.5 text-[11px] text-default-400">
          <span className="text-primary/70">当前上下文：</span>
          {context.activeNodeName} ({context.activeView})
        </div>
      )}

      {/* 未配置提示 */}
      {!ai.configReady ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Bot className="h-10 w-10 text-default-300" />
          <p className="text-sm text-default-400">
            {ai.configLoaded ? "尚未配置 AI 模型" : "正在加载配置…"}
          </p>
          {ai.configLoaded && (
            <Button color="primary" size="sm" onPress={onOpenSettings}>
              前往设置
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* 消息列表 */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {ai.messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                <Bot className="h-8 w-8 text-default-300" />
                <p className="text-xs text-default-400">
                  向 AI 提问关于当前代码的问题，或使用下方快捷操作。
                </p>
              </div>
            ) : (
              ai.messages.map(msg => <ChatMessage key={msg.id} message={msg} />)
            )}
            {isStreaming && (
              <div className="flex items-center gap-1.5 px-4 py-2 text-[12px] text-default-400">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                正在生成…
              </div>
            )}
            {ai.error && (
              <div className="mx-3 my-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{String(ai.error)}</span>
              </div>
            )}
          </div>

          {/* 快捷操作 */}
          {ai.messages.length === 0 && (
            <QuickActions
              onAction={prompt => ai.sendMessage({ text: prompt })}
              disabled={isStreaming}
            />
          )}

          {/* 输入框 */}
          <ChatInput
            onSend={text => ai.sendMessage({ text })}
            disabled={isStreaming}
          />
        </>
      )}
    </aside>
  )
}
