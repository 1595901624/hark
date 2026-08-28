/**
 * AI Agent 右侧面板：可折叠、可拖宽，接收外部 useAIChat 状态实现流式对话。
 *
 * 布局：顶部标题栏 + 消息列表（滚动）+ 快捷操作 + 输入框。
 * 无配置时显示配置引导；配置就绪后自动创建 transport。
 *
 * 面板始终挂载（由父组件控制 width），关闭时 width:0 + overflow-hidden，
 * 保证对话历史与流式输出在折叠/展开时不丢失。
 */
import { useEffect, useRef } from "react"
import { Bot, PanelRightClose, Settings, LoaderCircle, AlertCircle } from "lucide-react"
import type { ChatContext } from "../../hooks/useAIChat"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"
import { QuickActions } from "./QuickActions"
import { Button } from "../ui/base-ui"

/** useAIChat 返回值的子集（避免导入整个 hook 类型）。 */
interface AIPanelProps {
  onClose: () => void
  onOpenSettings: () => void
  context: ChatContext | null
  messages: import("ai").UIMessage[]
  sendMessage: (msg: { text: string }) => void
  status: string
  error: Error | undefined
  configReady: boolean
  configLoaded: boolean
  config: import("../../lib/ai-config").AiConfig | null
}

export function AIPanel({
  onClose,
  onOpenSettings,
  context,
  messages,
  sendMessage,
  status,
  error,
  configReady,
  configLoaded,
  config,
}: AIPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const isStreaming = status === "streaming" || status === "submitted"

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-default-200/70 px-3">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-primary" />
          <span className="text-[12.5px] font-medium text-foreground">AI 助手</span>
          {configReady && config && (
            <span className="rounded bg-default-100 px-1.5 py-0.5 text-[10px] text-default-400 dark:bg-white/5">
              {config.model}
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
      {context && configReady && (
        <div className="shrink-0 border-b border-default-200/50 bg-primary/5 px-3 py-1.5 text-[11px] text-default-400">
          <span className="text-primary/70">当前上下文：</span>
          {context.activeNodeName} ({context.activeView})
        </div>
      )}

      {/* 未配置提示 */}
      {!configReady ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Bot className="h-10 w-10 text-default-300" />
          <p className="text-sm text-default-400">
            {configLoaded ? "尚未配置 AI 模型" : "正在加载配置…"}
          </p>
          {configLoaded && (
            <Button color="primary" size="sm" onPress={onOpenSettings}>
              前往设置
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* 消息列表 */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
                <Bot className="h-8 w-8 text-default-300" />
                <p className="text-xs text-default-400">
                  向 AI 提问关于当前代码的问题，或使用下方快捷操作。
                </p>
              </div>
            ) : (
              messages.map(msg => <ChatMessage key={msg.id} message={msg} />)
            )}
            {isStreaming && (
              <div className="flex items-center gap-1.5 px-4 py-2 text-[12px] text-default-400">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                正在生成…
              </div>
            )}
            {error && (
              <div className="mx-3 my-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{String(error)}</span>
              </div>
            )}
          </div>

          {/* 快捷操作 */}
          {messages.length === 0 && (
            <QuickActions
              onAction={prompt => sendMessage({ text: prompt })}
              disabled={isStreaming}
            />
          )}

          {/* 输入框 */}
          <ChatInput
            onSend={text => sendMessage({ text })}
            disabled={isStreaming}
          />
        </>
      )}
    </aside>
  )
}
