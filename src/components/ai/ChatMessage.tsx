/**
 * 单条聊天消息渲染：用户消息纯文本气泡，AI 消息全宽 Markdown 渲染。
 */
import { memo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { UIMessage } from "ai"

interface ChatMessageProps {
  message: UIMessage
}

function ChatMessageInner({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const text = message.parts
    .map(part => {
      if (part.type === "text") return part.text
      return ""
    })
    .join("")

  if (isUser) {
    return (
      <div className="flex flex-row-reverse px-3 py-3">
        <div className="max-w-[85%] rounded-xl bg-primary/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 px-3 py-3">
      <div className="ai-markdown break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "…"}</ReactMarkdown>
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageInner)
