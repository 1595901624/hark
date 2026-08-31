/**
 * 单条聊天消息渲染：用户消息纯文本气泡，AI 消息全宽 Markdown 渲染。
 * 底部附带复制按钮（所有消息）与重试按钮（仅 AI 消息）。
 */
import { memo, useState, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Copy, Check, RotateCw } from "lucide-react"
import type { UIMessage } from "ai"
import { cn } from "../../lib/utils"

interface ChatMessageProps {
  message: UIMessage
  onRetry?: () => void
  retryDisabled?: boolean
}

function ChatMessageInner({ message, onRetry, retryDisabled }: ChatMessageProps) {
  const isUser = message.role === "user"
  const text = message.parts
    .map(part => {
      if (part.type === "text") return part.text
      return ""
    })
    .join("")

  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }, [text])

  const actionBtnClass =
    "flex h-6 w-6 items-center justify-center rounded-md text-default-400 transition-colors hover:bg-default-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"

  if (isUser) {
    return (
      <div className="flex flex-row-reverse px-3 py-3">
        <div className="max-w-[85%]">
          <div className="rounded-xl bg-primary/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
            <p className="whitespace-pre-wrap break-words">{text}</p>
          </div>
          <div className="mt-1 flex justify-end">
            <button type="button" onClick={handleCopy} className={actionBtnClass} title="复制">
              {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 px-3 py-3">
      <div className="ai-markdown break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "…"}</ReactMarkdown>
      </div>
      <div className="mt-1 flex items-center gap-0.5">
        <button type="button" onClick={handleCopy} className={actionBtnClass} title="复制">
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retryDisabled}
            className={cn(actionBtnClass, "disabled:cursor-not-allowed disabled:opacity-40")}
            title="重新生成"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageInner)
