/**
 * 聊天输入框：多行文本 + Ctrl+Enter 发送 + Shift+Enter 换行。
 * 流式生成时发送按钮变为停止按钮。
 * 内置快捷操作折叠菜单（解释代码 / 总结项目 / 检测敏感 API），常驻可用。
 */
import { useRef, useState, useEffect } from "react"
import { Send, Square, Sparkles } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"

export interface QuickActionItem {
  label: string
  prompt: string
  icon: LucideIcon
}

interface ChatInputProps {
  onSend: (text: string) => void
  disabled?: boolean
  isStreaming?: boolean
  onStop?: () => void
  quickActions?: QuickActionItem[]
}

export function ChatInput({ onSend, disabled, isStreaming, onStop, quickActions }: ChatInputProps) {
  const [value, setValue] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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

  const handleQuickAction = (prompt: string) => {
    setMenuOpen(false)
    if (!disabled) onSend(prompt)
  }

  // 点击菜单外部关闭
  useEffect(() => {
    if (!menuOpen) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handle)
    return () => document.removeEventListener("mousedown", handle)
  }, [menuOpen])

  return (
    <div className="relative border-t border-default-200/70 bg-chrome/40 p-3">
      {/* 快捷操作折叠菜单 */}
      {menuOpen && quickActions && quickActions.length > 0 && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-3 mb-2 w-48 rounded-xl border border-default-200 bg-background p-1 shadow-lg"
        >
          {quickActions.map(({ label, prompt, icon: Icon }) => (
            <button
              key={label}
              type="button"
              disabled={disabled}
              onClick={() => handleQuickAction(prompt)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-default-600 transition-colors hover:bg-default-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon className="h-3.5 w-3.5 text-default-400" />
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-xl border border-default-200 bg-background p-2 focus-within:border-primary/40">
        {quickActions && quickActions.length > 0 && (
          <button
            type="button"
            onClick={() => setMenuOpen(open => !open)}
            disabled={disabled}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              menuOpen
                ? "bg-primary/10 text-primary"
                : "text-default-400 hover:bg-default-100 hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
            title="快捷操作"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </button>
        )}
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
