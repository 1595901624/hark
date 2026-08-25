import { X } from "lucide-react"
import { cn } from "../../lib/utils"

export interface EditorTab {
  key: string
  title: string
  nodeId: number
}

interface EditorTabsProps {
  tabs: EditorTab[]
  activeKey?: string
  onSelect: (key: string) => void
  onClose: (key: string) => void
}

export function EditorTabs({ tabs, activeKey, onSelect, onClose }: EditorTabsProps) {
  return (
    <div className="flex h-[38px] shrink-0 items-stretch overflow-x-auto border-b border-default-200/80 bg-chrome scrollbar-hide">
      {tabs.map(tab => {
        const active = tab.key === activeKey
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(tab.key)}
            onKeyDown={e => (e.key === "Enter" || e.key === " ") && onSelect(tab.key)}
            className={cn(
              "group flex max-w-[220px] min-w-[120px] cursor-pointer items-center gap-1.5 border-r border-default-200/70 px-3 text-[12.5px] transition-colors select-none",
              active
                ? "bg-background font-medium text-foreground"
                : "text-default-500 hover:bg-black/[0.03] hover:text-foreground dark:hover:bg-white/[0.04]",
              active && "border-b-2 border-b-primary pb-0",
            )}
          >
            <span className="truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`关闭 ${tab.title}`}
              onClick={e => {
                e.stopPropagation()
                onClose(tab.key)
              }}
              className="ml-auto rounded p-0.5 text-default-400 opacity-0 transition-opacity hover:bg-black/[0.07] hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/[0.09]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
