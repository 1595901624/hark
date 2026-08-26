/**
 * 内容视图切换器：文件内容区顶部的小分段控件。
 *
 * 两个子标签：
 * - `.abc`：pandasm 反汇编文本（默认选中）；
 * - `.ets`：字节码还原的 ArkTS 源码。
 */
import { cn } from "../../lib/utils"
import type { ViewKind } from "../../lib/api"

/** {@linkcode ViewSwitcher} 的组件属性。 */
interface ViewSwitcherProps {
  /** 当前激活的视图。 */
  value: ViewKind
  /** 切换视图时触发。 */
  onChange: (view: ViewKind) => void
  /** 附加类名。 */
  className?: string
}

/** 视图顺序与展示名。 */
const VIEWS: { key: ViewKind; label: string; title: string }[] = [
  { key: "abc", label: ".abc", title: "反汇编文本" },
  { key: "ets", label: ".ets", title: "ArkTS 还原" },
]

/**
 * 渲染分段式视图切换器，选中项使用背景色浮起。
 */
export function ViewSwitcher({ value, onChange, className }: ViewSwitcherProps) {
  return (
    <div
      role="tablist"
      aria-label="切换内容视图"
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.07]",
        className,
      )}
    >
      {VIEWS.map(view => {
        const active = view.key === value
        return (
          <button
            key={view.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={view.title}
            onClick={() => onChange(view.key)}
            className={cn(
              "rounded px-2 py-[3px] font-mono text-[11px] leading-none transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-default-500 hover:text-foreground",
            )}
          >
            {view.label}
          </button>
        )
      })}
    </div>
  )
}
