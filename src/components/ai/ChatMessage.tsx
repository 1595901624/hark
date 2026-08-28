/**
 * 单条聊天消息渲染：用户消息纯文本，AI 消息 Markdown 渲染（含代码块高亮）。
 */
import ReactMarkdown from "react-markdown"
import { cn } from "../../lib/utils"
import type { UIMessage } from "ai"

interface ChatMessageProps {
  message: UIMessage
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user"
  const text = message.parts
    .map(part => {
      if (part.type === "text") return part.text
      return ""
    })
    .join("")

  return (
    <div className={cn("flex gap-2.5 px-3 py-3", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-1",
          isUser ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed",
            isUser
              ? "bg-primary/10 text-foreground"
              : "bg-default-100 text-foreground dark:bg-white/5",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-default-200/60 [&_pre]:p-3 [&_pre]:text-[12px] dark:[&_pre]:bg-black/30 [&_code]:rounded [&_code]:bg-default-200/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px] dark:[&_code]:bg-white/10 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
              <ReactMarkdown>{text || "…"}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
