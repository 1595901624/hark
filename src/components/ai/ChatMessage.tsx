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
      <div className="prose prose-sm dark:prose-invert max-w-none break-words text-[13px] leading-relaxed [&_pre]:overflow-hidden [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-lg [&_pre]:bg-default-200/60 [&_pre]:p-3 [&_pre]:text-[12px] dark:[&_pre]:bg-black/30 [&_code]:rounded [&_code]:bg-default-200/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] [&_code]:break-all dark:[&_code]:bg-white/10 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-all [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:border [&_th]:border-default-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:border [&_td]:border-default-200 [&_td]:px-2 [&_td]:py-1 [&_td]:break-words [&_img]:max-w-full">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "…"}</ReactMarkdown>
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageInner)
