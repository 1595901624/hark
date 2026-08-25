/**
 * 编辑器多标签栏。
 *
 * 展示已打开的内容标签，支持点击切换、键盘选择（Enter / Space）
 * 与悬停显示的关闭按钮。标签数量由父组件（Workspace）控制上限。
 */
import { X } from "lucide-react"
import { cn } from "../../lib/utils"

/** 单个编辑器标签的数据。 */
export interface EditorTab {
  /** 标签唯一键（`node-<id>` 形式）。 */
  key: string
  /** 标签标题（节点名）。 */
  title: string
  /** 对应的项目树节点 ID。 */
  nodeId: number
}

/** {@linkcode EditorTabs} 的组件属性。 */
interface EditorTabsProps {
  /** 当前打开的全部标签。 */
  tabs: EditorTab[]
  /** 激活标签的 key；未选中任何标签时为 `undefined`。 */
  activeKey?: string
  /** 点击 / 键盘选中某个标签时触发。 */
  onSelect: (key: string) => void
  /** 点击标签关闭按钮时触发（不会冒泡为选中）。 */
  onClose: (key: string) => void
}

/**
 * 渲染横向标签栏。
 *
 * 激活标签使用背景色 + 底部主色条标识；非激活标签悬停时显示关闭按钮。
 */
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
