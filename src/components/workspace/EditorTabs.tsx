/**
 * 编辑器多标签栏。
 *
 * 展示已打开的内容标签，支持：
 * - 点击切换、键盘选择（Enter / Space）与悬停显示的关闭按钮；
 * - 标签超出宽度时：鼠标滚轮横向滚动 + 两端的箭头按钮滚动；
 * - 激活标签自动滚入可视区域。
 *
 * 标签数量上限由父组件（Workspace）控制。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
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

/** 两端箭头按钮单次滚动的距离（像素）。 */
const SCROLL_STEP = 160

/**
 * 渲染横向标签栏。
 *
 * 激活标签使用背景色 + 底部主色条标识；非激活标签悬停时显示关闭按钮。
 * 内容区滚动条隐藏，通过滚轮 / 箭头按钮横向滚动。
 */
export function EditorTabs({ tabs, activeKey, onSelect, onClose }: EditorTabsProps) {
  /** 横向滚动容器 */
  const containerRef = useRef<HTMLDivElement>(null)
  /** 各标签元素引用，用于把激活标签滚入可视区 */
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /** 是否可以向左 / 向右继续滚动（决定箭头按钮显隐） */
  const [canScroll, setCanScroll] = useState({ left: false, right: false })

  /** 根据当前 scrollLeft / scrollWidth 刷新箭头按钮显隐状态。 */
  const updateScrollState = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setCanScroll({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < el.scrollWidth - el.clientWidth - 1,
    })
  }, [])

  // 监听滚动与尺寸变化，刷新箭头按钮显隐
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    updateScrollState()
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    el.addEventListener("scroll", updateScrollState)
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", updateScrollState)
    }
  }, [updateScrollState, tabs.length])

  // 将鼠标纵向滚轮转换为横向滚动（滚动条已隐藏，默认滚轮无法滚动）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY + e.deltaX
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // 激活标签变化时自动滚入可视区域
  useEffect(() => {
    if (!activeKey) return
    const el = containerRef.current
    const item = itemRefs.current.get(activeKey)
    if (!el || !item) return
    const left = item.offsetLeft - el.scrollLeft
    const right = left + item.offsetWidth
    if (left < 0) {
      el.scrollLeft += left
    } else if (right > el.clientWidth) {
      el.scrollLeft += right - el.clientWidth
    }
  }, [activeKey, tabs.length])

  /** 点击端部箭头按钮：向指定方向平滑滚动。 */
  const scrollByStep = (dir: number) => {
    containerRef.current?.scrollBy({ left: dir * SCROLL_STEP, behavior: "smooth" })
  }

  return (
    <div className="flex h-[38px] shrink-0 items-stretch border-b border-default-200/80 bg-chrome">
      {canScroll.left && (
        <button
          type="button"
          aria-label="向左滚动标签"
          onClick={() => scrollByStep(-1)}
          className="flex w-6 shrink-0 items-center justify-center text-default-400 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.07]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      )}

      <div
        ref={containerRef}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-hide"
      >
        {tabs.map(tab => {
          const active = tab.key === activeKey
          return (
            <div
              key={tab.key}
              ref={el => {
                if (el) itemRefs.current.set(tab.key, el)
                else itemRefs.current.delete(tab.key)
              }}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => onSelect(tab.key)}
              onKeyDown={e => (e.key === "Enter" || e.key === " ") && onSelect(tab.key)}
              className={cn(
                "group flex max-w-[220px] min-w-[120px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-default-200/70 px-3 text-[12.5px] transition-colors select-none",
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

      {canScroll.right && (
        <button
          type="button"
          aria-label="向右滚动标签"
          onClick={() => scrollByStep(1)}
          className="flex w-6 shrink-0 items-center justify-center text-default-400 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.07]"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
