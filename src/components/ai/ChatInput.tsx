/**
 * 聊天输入框：多行文本 + Ctrl+Enter 发送 + Shift+Enter 换行。
 * 流式生成时发送按钮变为停止按钮。
 */
import { useRef, useState } from "react"
import { Send, Square } from "lucide-react"
import { cn } from "../../lib/utils"

interface ChatInputProps {
  onSend: (text: string) => void
  disabled?: boolean
  isStreaming?: boolean
  onStop?: () => void
}

export function ChatInput({ onSend, disabled, isStreaming, onStop }: ChatInputProps) {
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue("")
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto"
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
  }

  return (
    <div className="border-t border-default-200/70 bg-chrome/40 p-3">
      <div className="flex items-end gap-2 rounded-xl border border-default-200 bg-background p-2 focus-within:border-primary/40">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="输入消息，Ctrl+Enter 发送…"
          className={cn(
            "max-h-40 min-h-[28px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-foreground outline-none placeholder:text-default-300",
            "scrollbar-thin",
          )}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              "bg-danger text-danger-foreground hover:bg-danger/90",
            )}
            title="停止生成"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              disabled || !value.trim()
                ? "bg-default-100 text-default-300"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
