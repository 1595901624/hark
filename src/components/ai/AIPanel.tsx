/**
 * AI Agent 右侧面板：可折叠、可拖宽，接收外部 useAIChat 状态实现流式对话。
 *
 * 布局：顶部标题栏（含新建对话、历史、Profile 选择、设置、关闭）
 *      + 消息列表（滚动）+ 快捷操作 + 输入框。
 * 历史列表为内嵌覆盖层，点击历史按钮在消息区域展开。
 */
import { useEffect, useRef } from "react"
import {
  Bot, PanelRightClose, Settings, LoaderCircle, AlertCircle,
  Plus, History, Square, ArrowLeft,
} from "lucide-react"
import type { ChatContext } from "../../hooks/useAIChat"
import type { AiProfile } from "../../lib/ai-profiles"
import type { ConversationMeta } from "../../lib/ai-history"
import { ChatMessage } from "./ChatMessage"
import { ChatInput } from "./ChatInput"
import { QuickActions } from "./QuickActions"
import { ProfileSelector } from "./ProfileSelector"
import { ConversationList } from "./ConversationList"
import { Button } from "../ui/base-ui"
import type { UIMessage } from "ai"

/** useAIChat 返回值的子集。 */
interface AIPanelProps {
  onClose: () => void
  onOpenSettings: () => void
  context: ChatContext | null
  messages: UIMessage[]
  sendMessage: (msg: { text: string }) => void
  status: string
  error: Error | undefined
  configReady: boolean
  configLoaded: boolean

  // Profile
  profiles: AiProfile[]
  activeProfile: AiProfile | null
  onSwitchProfile: (id: string) => void

  // 会话管理
  conversations: ConversationMeta[]
  activeConversationId: string | null
  showConversationList: boolean
  onShowConversationList: (show: boolean) => void
  onNewConversation: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void

  // 终止
  onStop: () => void
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
  profiles,
  activeProfile,
  onSwitchProfile,
  conversations,
  activeConversationId,
  showConversationList,
  onShowConversationList,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onStop,
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
        <div className="flex min-w-0 items-center gap-1.5">
          {showConversationList ? (
            <button
              type="button"
              onClick={() => onShowConversationList(false)}
              className="rounded p-0.5 text-default-400 hover:bg-default-100 hover:text-foreground"
              title="返回对话"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          {configReady && !showConversationList && (
            <ProfileSelector
              profiles={profiles}
              activeProfile={activeProfile}
              onSelect={onSwitchProfile}
            />
          )}
          {showConversationList && (
            <span className="text-[12.5px] font-medium text-foreground">历史对话</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {configReady && !showConversationList && (
            <>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="新建对话"
                title="新建对话"
                onPress={onNewConversation}
                className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="历史对话"
                title="历史对话"
                onPress={() => onShowConversationList(!showConversationList)}
                className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <History className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
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

      {/* 历史对话列表覆盖层 */}
      {showConversationList && configReady ? (
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
          onRename={onRenameConversation}
        />
      ) : (
        <>
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
                  <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-default-400">
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                    正在生成…
                    <button
                      type="button"
                      onClick={onStop}
                      className="ml-1 flex items-center gap-1 rounded-md border border-default-200 px-2 py-0.5 text-[11px] text-default-500 transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Square className="h-2.5 w-2.5 fill-current" />
                      停止
                    </button>
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
                isStreaming={isStreaming}
                onStop={onStop}
              />
            </>
          )}
        </>
      )}
    </aside>
  )
}
