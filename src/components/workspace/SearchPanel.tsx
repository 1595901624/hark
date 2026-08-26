/**
 * 全局搜索面板（左侧栏「搜索」视图，jadx 风格）。
 *
 * - 查询输入（300ms 防抖自动搜索，Enter 立即执行）；
 * - 类别多选：类 / 方法 / 字段 / 字符串 / 代码 / 资源，可任意组合，
 *   同一行命中多个类别时聚合为一条并标注全部类别徽章；
 * - 匹配选项：大小写敏感、正则表达式；
 * - 结果按类分组展示，点击子项跳转到对应类的反汇编视图并定位行；
 * - 搜索选项与类别选择持久化到本地。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  LoaderCircle,
  Regex,
  Search,
} from "lucide-react"
import { cn } from "../../lib/utils"
import { usePersistentState } from "../../hooks/usePersistentState"
import { api, type SearchCategory, type SearchHit, type SearchResponse } from "../../lib/api"

/** {@linkcode SearchPanel} 的组件属性。 */
interface SearchPanelProps {
  /** 是否已打开项目（未打开时禁用搜索）。 */
  hasProject: boolean
  /** 点击命中项回调：打开节点并定位行。 */
  onOpenHit: (hit: SearchHit) => void
  /** 聚焦信号；`seq` 变化时聚焦输入框（Ctrl+Shift+F 触发）。 */
  focusSeq?: number
}

/** 类别的中文标签与展示顺序。 */
const CATEGORY_LABELS: Record<SearchCategory, string> = {
  class: "类",
  method: "方法",
  field: "字段",
  string: "字符串",
  code: "代码",
  resource: "资源",
}

/** 类别固定展示顺序（多选 chip 与结果徽章共用）。 */
const CATEGORY_ORDER: SearchCategory[] = [
  "class",
  "method",
  "field",
  "string",
  "code",
  "resource",
]

/** 默认启用的搜索类别。 */
const DEFAULT_CATEGORIES: SearchCategory[] = ["class", "method", "string", "code"]

/** 单个类别的结果分组。 */
interface HitGroup {
  /** 分组键：类节点 ID 或资源节点 ID。 */
  key: number
  /** 分组标题：类展示名或资源路径。 */
  title: string
  /** 所属单元名（资源分组为空）。 */
  unitName: string
  /** 组内命中列表（保持后端顺序）。 */
  hits: SearchHit[]
}

/** 把扁平命中列表按节点分组（保持树序）。 */
function groupHits(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<number, HitGroup>()
  for (const hit of hits) {
    let g = groups.get(hit.classNodeId)
    if (!g) {
      g = { key: hit.classNodeId, title: hit.classDisplayName, unitName: hit.unitName, hits: [] }
      groups.set(hit.classNodeId, g)
    }
    g.hits.push(hit)
  }
  return [...groups.values()]
}

/**
 * 渲染全局搜索面板。
 *
 * 未打开项目时整体禁用并提示；有查询词时防抖触发后端搜索，
 * 展示分组结果、截断提示与耗时统计。
 */
export function SearchPanel({ hasProject, onOpenHit, focusSeq }: SearchPanelProps) {
  /** 输入框草稿值（未提交） */
  const [draft, setDraft] = useState("")
  /** 最近一次实际提交的查询 */
  const [query, setQuery] = useState("")
  /** 启用的类别集合（持久化） */
  const [categories, setCategories] = usePersistentState<SearchCategory[]>(
    "search-categories",
    DEFAULT_CATEGORIES,
  )
  /** 是否区分大小写（持久化） */
  const [caseSensitive, setCaseSensitive] = usePersistentState<boolean>("search-case-sensitive", false)
  /** 是否正则模式（持久化） */
  const [isRegex, setIsRegex] = usePersistentState<boolean>("search-is-regex", false)

  /** 搜索进行中标记 */
  const [searching, setSearching] = useState(false)
  /** 最近一次成功响应 */
  const [response, setResponse] = useState<SearchResponse | null>(null)
  /** 搜索错误信息 */
  const [error, setError] = useState<string | null>(null)
  /** 折叠的分组节点 ID 集合 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  /** 请求代次：丢弃过期响应 */
  const requestSeq = useRef(0)
  /** 防抖定时器 */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ctrl+Shift+F 聚焦信号
  useEffect(() => {
    if (focusSeq != null) inputRef.current?.focus()
  }, [focusSeq])

  /**
   * 执行一次搜索；空查询直接清空结果。
   * @param q 提交的查询文本
   */
  const runSearch = (q: string, cats: SearchCategory[], cs: boolean, re: boolean) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = q.trim()
    setQuery(trimmed)
    setError(null)
    if (!trimmed || cats.length === 0) {
      requestSeq.current++
      setSearching(false)
      setResponse(null)
      return
    }
    const seq = ++requestSeq.current
    setSearching(true)
    api
      .searchProject({
        query: trimmed,
        categories: cats,
        caseSensitive: cs,
        isRegex: re,
        maxResults: 1000,
      })
      .then(resp => {
        if (seq !== requestSeq.current || resp.cancelled) return
        setResponse(resp)
        setCollapsed(new Set())
      })
      .catch(err => {
        if (seq !== requestSeq.current) return
        setResponse(null)
        setError(String(err))
      })
      .finally(() => {
        if (seq === requestSeq.current) setSearching(false)
      })
  }

  // 输入防抖：300ms 后自动提交
  const handleDraftChange = (value: string) => {
    setDraft(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(value, categories, caseSensitive, isRegex), 300)
  }

  // 选项变化：已有查询时立即重搜
  useEffect(() => {
    if (query) runSearch(query, categories, caseSensitive, isRegex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, caseSensitive, isRegex])

  /** 切换某个类别的启用状态。 */
  const toggleCategory = (cat: SearchCategory) => {
    setCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : CATEGORY_ORDER.filter(c => prev.includes(c) || c === cat),
    )
  }

  const groups = useMemo(() => groupHits(response?.hits ?? []), [response])
  /** 分组内含类名命中的组头需要高亮标题 */
  const totalFiles = groups.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 查询输入 */}
      <div className="shrink-0 px-3 pb-2 pt-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-default-400" />
          <input
            ref={inputRef}
            type="text"
            value={draft}
            spellCheck={false}
            disabled={!hasProject}
            placeholder={hasProject ? "搜索类、方法、代码…" : "请先打开项目"}
            onChange={e => handleDraftChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault()
                runSearch(draft, categories, caseSensitive, isRegex)
              } else if (e.key === "Escape") {
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className={cn(
              "h-8 w-full rounded-md border border-default-200/80 bg-background pl-8 pr-8 text-[12.5px] outline-none transition-colors",
              "placeholder:text-default-400 focus:border-primary/60",
              "disabled:cursor-not-allowed disabled:bg-default-50 disabled:text-default-400",
            )}
          />
          {searching && (
            <LoaderCircle className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-primary" />
          )}
        </div>
      </div>

      {/* 类别多选 */}
      <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
        {CATEGORY_ORDER.map(cat => {
          const active = categories.includes(cat)
          return (
            <button
              key={cat}
              type="button"
              disabled={!hasProject}
              onClick={() => toggleCategory(cat)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] leading-none transition-colors disabled:pointer-events-none disabled:opacity-50",
                active
                  ? "bg-primary/15 font-medium text-primary"
                  : "bg-default-100/70 text-default-500 hover:bg-default-200/70 hover:text-default-600",
              )}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          )
        })}
      </div>

      {/* 匹配选项 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-default-200/50 px-3 pb-2">
        <OptionToggle
          active={caseSensitive}
          disabled={!hasProject}
          title="区分大小写"
          onPress={() => setCaseSensitive(!caseSensitive)}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
          <span>Aa</span>
        </OptionToggle>
        <OptionToggle
          active={isRegex}
          disabled={!hasProject}
          title="正则表达式"
          onPress={() => setIsRegex(!isRegex)}
        >
          <Regex className="h-3.5 w-3.5" />
          <span>.*</span>
        </OptionToggle>
        <span className="ml-auto truncate pl-2 text-[11px] text-default-400">
          {statsText(response, searching, error, totalFiles)}
        </span>
      </div>

      {/* 结果区 */}
      <div className="min-h-0 flex-1 overflow-auto py-1 scrollbar-thin">
        {!hasProject ? (
          <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-default-400">
            打开项目后即可全局搜索
          </p>
        ) : error ? (
          <p className="px-4 py-4 text-[12px] leading-relaxed text-danger">{error}</p>
        ) : query && !searching && groups.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-default-400">无匹配结果</p>
        ) : groups.length > 0 ? (
          <>
            {response?.truncated && (
              <p className="mx-3 mb-1 rounded-md bg-warning/10 px-2 py-1 text-[11px] text-warning-foreground/90 dark:text-warning">
                结果过多，仅显示前 {response.totalMatches} 条
              </p>
            )}
            {groups.map(group => {
              const isCollapsed = collapsed.has(group.key)
              const isResource = group.unitName === ""
              return (
                <div key={group.key}>
                  {/* 组头：类名 / 资源路径 + 命中数 */}
                  <button
                    type="button"
                    className={cn(
                      "group flex h-[26px] w-max min-w-full items-center gap-1 rounded-md px-1.5 pr-3 text-left text-[12px] whitespace-nowrap transition-colors",
                      "text-default-600 hover:bg-black/[0.045] dark:text-default-400 dark:hover:bg-white/[0.055]",
                    )}
                    onClick={() =>
                      setCollapsed(prev => {
                        const next = new Set(prev)
                        if (next.has(group.key)) next.delete(group.key)
                        else next.add(group.key)
                        return next
                      })
                    }
                    title={`${group.title}${group.unitName ? ` · ${group.unitName}` : ""}`}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-default-400" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-default-400" />
                    )}
                    {isResource ? (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-default-400" />
                    ) : (
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-default-400" />
                    )}
                    <span className="font-medium text-foreground">{group.title}</span>
                    {group.unitName && (
                      <span className="text-[11px] text-default-400">{group.unitName}</span>
                    )}
                    <span className="ml-auto rounded-full bg-default-100/80 px-1.5 py-0.5 text-[10.5px] tabular-nums text-default-500">
                      {group.hits.length}
                    </span>
                  </button>
                  {!isCollapsed &&
                    group.hits.map((hit, i) => (
                      <button
                        key={`${group.key}-${i}`}
                        type="button"
                        className="group flex w-full items-start gap-2 rounded-md py-0.5 pl-7 pr-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        onClick={() => onOpenHit(hit)}
                        title={hit.line > 0 ? `第 ${hit.line} 行` : undefined}
                      >
                        {hit.line > 0 ? (
                          <>
                            <span className="w-9 shrink-0 pt-px text-right text-[11px] tabular-nums text-default-400">
                              {hit.line}
                            </span>
                            <code className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[18px] text-default-600 dark:text-default-400">
                              {renderHighlighted(hit.text, hit.matchRanges)}
                            </code>
                          </>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] text-default-500">
                            名称匹配
                          </span>
                        )}
                        <span className="mt-px flex shrink-0 gap-0.5">
                          {hit.categories.map(cat => (
                            <span
                              key={cat}
                              className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] leading-[14px] text-primary"
                            >
                              {CATEGORY_LABELS[cat]}
                            </span>
                          ))}
                        </span>
                      </button>
                    ))}
                </div>
              )
            })}
          </>
        ) : (
          <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-default-400">
            输入关键字开始搜索
            <br />
            支持类名 / 方法名 / 字段 / 字符串 / 代码
          </p>
        )}
      </div>
    </div>
  )
}

/** 结果区右上角的统计文案。 */
function statsText(response: SearchResponse | null, searching: boolean, error: string | null, files: number) {
  if (error) return ""
  if (!response || searching) return ""
  return `${response.totalMatches} 处 · ${files} 个文件 · ${response.elapsedMs} ms`
}

/** 用高亮区间渲染命中文本。 */
function renderHighlighted(text: string, ranges: [number, number][]) {
  if (!ranges || ranges.length === 0) return text
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const [s, e] of ranges) {
    if (s >= text.length) break
    if (s > cursor) nodes.push(<span key={key++}>{text.slice(cursor, s)}</span>)
    nodes.push(
      <mark key={key++} className="rounded-[2px] bg-warning/30 text-foreground">
        {text.slice(s, Math.min(e, text.length))}
      </mark>,
    )
    cursor = Math.min(e, text.length)
  }
  if (cursor < text.length) nodes.push(<span key={key++}>{text.slice(cursor)}</span>)
  return nodes
}

/** 小型开关按钮（Aa / .* 等）。 */
function OptionToggle({
  active,
  disabled,
  title,
  onPress,
  children,
}: {
  active: boolean
  disabled?: boolean
  title: string
  onPress: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onPress}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        active
          ? "bg-primary/15 text-primary"
          : "text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]",
      )}
    >
      {children}
    </button>
  )
}
