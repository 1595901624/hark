/**
 * 编辑器内查找条（Ctrl+F）：浮于代码区右上角。
 *
 * 提供查询输入、n/m 匹配计数、上一个 / 下一个导航与关闭按钮；
 * Enter / Shift+Enter 切换匹配，Esc 关闭。
 */
import { useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, CaseSensitive, X } from "lucide-react"
import { cn } from "../../lib/utils"

/** {@linkcode EditorFindBar} 的组件属性。 */
interface EditorFindBarProps {
  /** 当前查询文本。 */
  query: string
  /** 查询文本变化回调。 */
  onQueryChange: (value: string) => void
  /** 是否区分大小写。 */
  caseSensitive: boolean
  /** 大小写开关回调。 */
  onCaseSensitiveChange: (value: boolean) => void
  /** 当前匹配序号（0-based；-1 表示无）。 */
  current: number
  /** 匹配总数。 */
  total: number
  /** 跳到下一个匹配。 */
  onNext: () => void
  /** 跳到上一个匹配。 */
  onPrev: () => void
  /** 关闭查找条。 */
  onClose: () => void
}

/**
 * 渲染编辑器查找条。
 *
 * 挂载时自动聚焦输入框并全选已有内容，便于直接输入覆盖。
 */
export function EditorFindBar({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  current,
  total,
  onNext,
  onPrev,
  onClose,
}: EditorFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.select()
  }, [])

  return (
    <div className="absolute right-4 top-2 z-20 flex h-9 items-center gap-1 rounded-lg border border-default-200/80 bg-chrome px-2 shadow-lg shadow-black/10">
      <input
        ref={inputRef}
        type="text"
        value={query}
        spellCheck={false}
        placeholder="查找…"
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === "Escape") {
            e.preventDefault()
            onClose()
          }
        }}
        className={cn(
          "h-7 w-44 rounded-md border border-transparent bg-background px-2 text-[12.5px] outline-none transition-colors",
          "placeholder:text-default-400 focus:border-primary/60",
        )}
      />
      <span className="min-w-[46px] text-center text-[11.5px] tabular-nums text-default-500">
        {total > 0 ? `${current + 1}/${total}` : query ? "无结果" : ""}
      </span>
      <button
        type="button"
        aria-label="区分大小写"
        title="区分大小写"
        disabled={!query}
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40",
          caseSensitive
            ? "bg-primary/15 text-primary"
            : "text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]",
        )}
      >
        <CaseSensitive className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="上一个"
        title="上一个 (Shift+Enter)"
        disabled={total === 0}
        onClick={onPrev}
        className="flex h-6 w-6 items-center justify-center rounded-md text-default-500 transition-colors hover:bg-black/[0.05] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/[0.07]"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="下一个"
        title="下一个 (Enter)"
        disabled={total === 0}
        onClick={onNext}
        className="flex h-6 w-6 items-center justify-center rounded-md text-default-500 transition-colors hover:bg-black/[0.05] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/[0.07]"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="关闭查找"
        title="关闭 (Esc)"
        onClick={onClose}
        className="flex h-6 w-6 items-center justify-center rounded-md text-default-500 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
