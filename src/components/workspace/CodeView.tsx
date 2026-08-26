/**
 * 代码视图：带行号与简易语法高亮的只读文本渲染器。
 *
 * - `language === "asm"`：针对 pandasm 反汇编文本做轻量逐词高亮
 *   （指令伪指令、标签、寄存器、数字、字符串字面量与注释）；
 * - `language === "ts"`：针对还原的 ArkTS/TypeScript 做关键字 /
 *   字符串 / 数字 / 注释 / 装饰器高亮；
 * - 其他语言纯文本渲染。
 *
 * 另外支持编辑器内查找叠加层：传入 `findQuery` 后高亮全部匹配，
 * `activeMatchIndex` 指定的当前匹配使用强调样式并自动滚动到可见区域；
 * `scrollToLine` 用于全局搜索结果点击后的行定位跳转。
 */
import { useEffect, useMemo, useRef } from "react"
import type { ReactNode } from "react"

/** {@linkcode CodeView} 的组件属性。 */
interface CodeViewProps {
  /** 要渲染的正文文本。 */
  content: string
  /** 语言标记：`asm` / `ts` 启用对应高亮，其他值按纯文本渲染。 */
  language: string
  /** 编辑器内查找的查询文本；为空时禁用查找叠加层。 */
  findQuery?: string
  /** 查找是否区分大小写。 */
  findCaseSensitive?: boolean
  /** 当前激活匹配的全局扁平序号（未激活传 -1）。 */
  activeMatchIndex?: number
  /** 匹配总数变化时上报（供查找条显示 n/m）。 */
  onFindStats?: (total: number) => void
  /** 行定位请求；`seq` 变化即触发滚动。 */
  scrollToLine?: { line: number; seq: number } | null
}

/** 视为伪指令关键字高亮的行首 token。 */
const ASM_KEYWORDS = new Set([
  ".record",
  ".function",
  ".field",
  ".source_file",
  ".access_flags",
])

/** 单个匹配在当前匹配样式 / 普通匹配样式间的类名。 */
const MARK_ACTIVE = "rounded-[2px] bg-warning/60 text-foreground"
const MARK_IDLE = "rounded-[2px] bg-warning/25 text-foreground"

/**
 * 在单行文本中查找查询的全部出现区间（字符下标，前闭后开）。
 * @param hay 行文本
 * @param needle 查询文本（空串返回空）
 * @param caseSensitive 是否区分大小写
 */
export function findRanges(
  hay: string,
  needle: string,
  caseSensitive: boolean,
): [number, number][] {
  if (!needle) return []
  const h = caseSensitive ? hay : hay.toLowerCase()
  const n = caseSensitive ? needle : needle.toLowerCase()
  const out: [number, number][] = []
  let i = 0
  while ((i = h.indexOf(n, i)) !== -1) {
    out.push([i, i + n.length])
    i += n.length
  }
  return out
}

/**
 * 渲染带行号栏的代码区域。
 *
 * 行号栏使用 `sticky` 定位，横向滚动时保持可见。
 */
export function CodeView({
  content,
  language,
  findQuery = "",
  findCaseSensitive = false,
  activeMatchIndex = -1,
  onFindStats,
  scrollToLine = null,
}: CodeViewProps) {
  /** 按行拆分后的正文（依赖缓存，避免每次渲染重复拆分） */
  const lines = useMemo(() => content.split("\n"), [content])
  const isAsm = language === "asm"
  const isTs = language === "ts"

  const containerRef = useRef<HTMLDivElement>(null)

  /** 每行匹配区间列表 + 每行首个匹配的全局扁平序号（前缀和）。 */
  const { matchesByLine, lineOffsets, totalMatches } = useMemo(() => {
    const matchesByLine: [number, number][][] = []
    const lineOffsets: number[] = []
    let total = 0
    for (const line of lines) {
      lineOffsets.push(total)
      const ranges = findRanges(line, findQuery, findCaseSensitive)
      matchesByLine.push(ranges)
      total += ranges.length
    }
    return { matchesByLine, lineOffsets, totalMatches: total }
  }, [lines, findQuery, findCaseSensitive])

  // 匹配总数变化时上报给查找条
  useEffect(() => {
    onFindStats?.(totalMatches)
  }, [totalMatches, onFindStats])

  /** 当前激活匹配所在行（用于滚动与样式强调）。 */
  const activeLine = useMemo(() => {
    if (activeMatchIndex < 0 || activeMatchIndex >= totalMatches) return -1
    let acc = 0
    for (let li = 0; li < matchesByLine.length; li++) {
      const count = matchesByLine[li].length
      if (activeMatchIndex < acc + count) return li
      acc += count
    }
    return -1
  }, [activeMatchIndex, matchesByLine, totalMatches])

  // 当前行定位请求：滚动目标行至视口中央
  useEffect(() => {
    if (!scrollToLine || scrollToLine.line <= 0) return
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-line="${scrollToLine.line}"]`,
    )
    el?.scrollIntoView({ block: "center" })
  }, [scrollToLine])

  // 激活匹配变化：保持当前匹配可见
  useEffect(() => {
    if (activeLine < 0) return
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-line="${activeLine + 1}"]`,
    )
    el?.scrollIntoView({ block: "center" })
  }, [activeLine])

  /**
   * 渲染单行：先按查找匹配切分，非匹配段走常规语法高亮，
   * 匹配段以 `<mark>` 覆盖（当前匹配用强调样式）。
   * @param line 单行文本
   * @param ranges 该行的匹配区间列表
   * @param lineFlatBase 该行首个匹配的全局扁平序号
   */
  const renderLine = (line: string, ranges: [number, number][], lineFlatBase: number) => {
    const highlight = (text: string) =>
      isAsm ? highlightAsm(text) : isTs ? highlightTs(text) : text || " "
    if (ranges.length === 0) return highlight(line)
    const nodes: ReactNode[] = []
    let cursor = 0
    let key = 0
    for (let mi = 0; mi < ranges.length; mi++) {
      const [s, e] = ranges[mi]
      if (s > cursor) nodes.push(<span key={key++}>{highlight(line.slice(cursor, s))}</span>)
      const isActive = activeMatchIndex === lineFlatBase + mi
      nodes.push(
        <mark key={key++} className={isActive ? MARK_ACTIVE : MARK_IDLE}>
          {line.slice(s, e) || " "}
        </mark>,
      )
      cursor = e
    }
    if (cursor < line.length) nodes.push(<span key={key++}>{highlight(line.slice(cursor))}</span>)
    return nodes
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 overflow-auto bg-background font-mono text-[12.5px] leading-[20px]"
    >
      <div className="sticky left-0 z-10 shrink-0 select-none border-r border-default-200/60 bg-default-50 px-3 py-3 text-right text-default-300 dark:text-default-400 dark:bg-default-50/50">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 px-4 py-3 whitespace-pre text-foreground dark:text-zinc-100">
        {lines.map((line, i) => (
          <div key={i} data-line={i + 1} className="min-h-[20px]">
            {renderLine(line, matchesByLine[i], lineOffsets[i])}
          </div>
        ))}
      </pre>
    </div>
  )
}

/**
 * 对单行汇编文本做逐词高亮，返回 React 节点数组。
 *
 * 识别顺序：注释行 -> 空白 -> 字符串字面量 -> 行内注释 -> 词 token
 * （伪指令 / 标签 / 寄存器 / 数字 / 其他 `.` 指令 / 普通文本）。
 * @param line 单行文本
 */
function highlightAsm(line: string) {
  if (!line) return " "
  const trimmed = line.trim()

  // 整行注释
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return <span className="text-default-400 italic">{line}</span>
  }

  const parts = []
  let rest = line
  let key = 0

  while (rest.length > 0) {
    // 空白原样保留
    const wsMatch = rest.match(/^\s+/)
    if (wsMatch) {
      parts.push(<span key={key++}>{wsMatch[0]}</span>)
      rest = rest.slice(wsMatch[0].length)
      continue
    }

    // 字符串字面量（支持反斜杠转义）
    if (rest[0] === '"') {
      const end = findStringEnd(rest)
      parts.push(
        <span key={key++} className="text-amber-600 dark:text-amber-400">
          {rest.slice(0, end)}
        </span>,
      )
      rest = rest.slice(end)
      continue
    }

    // 行内注释：剩余内容全部按注释渲染
    if (rest[0] === ";") {
      parts.push(
        <span key={key++} className="text-default-400 italic">
          {rest}
        </span>,
      )
      rest = ""
      continue
    }

    // 普通词 token
    const tokenMatch = rest.match(/^[^\s"]+/)
    if (!tokenMatch) break
    const token = tokenMatch[0]

    if (ASM_KEYWORDS.has(token)) {
      parts.push(
        <span key={key++} className="font-semibold text-primary">
          {token}
        </span>,
      )
    } else if (token.endsWith(":")) {
      parts.push(
        <span key={key++} className="text-sky-600 dark:text-sky-400">
          {token}
        </span>,
      )
    } else if (/^v\d+$/.test(token)) {
      parts.push(
        <span key={key++} className="text-emerald-600 dark:text-emerald-400">
          {token}
        </span>,
      )
    } else if (/^-?0x[0-9a-fA-F]+$/.test(token) || /^-?\d+(\.\d+)?$/.test(token)) {
      parts.push(
        <span key={key++} className="text-orange-600 dark:text-orange-400">
          {token}
        </span>,
      )
    } else if (token.startsWith(".")) {
      parts.push(
        <span key={key++} className="text-primary/80">
          {token}
        </span>,
      )
    } else {
      parts.push(<span key={key++}>{token}</span>)
    }
    rest = rest.slice(token.length)
  }

  return parts
}

/**
 * 计算字符串字面量（含开头的双引号）的结束下标（闭区间后一位）。
 * 支持反斜杠转义；未找到结束引号时返回字符串长度。
 * @param s 以 `"` 开头的字符串
 */
function findStringEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++
      continue
    }
    if (s[i] === '"') return i + 1
  }
  return s.length
}

// ---------- ArkTS / TypeScript 高亮 ----------

/** 视为关键字高亮的 TS 词表。 */
const TS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "constructor", "continue", "declare", "default", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "from", "function", "get",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "number", "object", "of", "private", "protected", "public", "readonly", "return",
  "set", "static", "string", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "unknown", "var", "void", "while", "never",
])

/**
 * 对单行 TS 文本做逐词高亮，返回 React 节点数组。
 *
 * 识别顺序：注释 -> 字符串 -> 模板串 -> 装饰器 -> 词 token
 * （关键字 / 数字 / 大写开头的类型）。
 * @param line 单行文本
 */
function highlightTs(line: string) {
  if (!line) return " "
  const trimmed = line.trim()

  // 整行块注释（单行内闭合的 /* */ 或未闭合的 /*）
  const blockStart = trimmed.startsWith("/*")
  if (blockStart) {
    return <span className="text-default-400 italic">{line}</span>
  }

  const parts = []
  let rest = line
  let key = 0

  while (rest.length > 0) {
    // 空白原样保留
    const wsMatch = rest.match(/^\s+/)
    if (wsMatch) {
      parts.push(<span key={key++}>{wsMatch[0]}</span>)
      rest = rest.slice(wsMatch[0].length)
      continue
    }

    // 行注释：剩余内容全部按注释渲染
    if (rest.startsWith("//")) {
      parts.push(
        <span key={key++} className="text-default-400 italic">
          {rest}
        </span>,
      )
      break
    }

    // 字符串字面量（双引号 / 单引号 / 模板串，支持反斜杠转义）
    if (rest[0] === '"' || rest[0] === "'" || rest[0] === "`") {
      const end = findStringEnd(rest)
      parts.push(
        <span key={key++} className="text-amber-600 dark:text-amber-400">
          {rest.slice(0, end)}
        </span>,
      )
      rest = rest.slice(end)
      continue
    }

    // 装饰器
    if (rest[0] === "@") {
      const m = rest.match(/^@[\w$]+/)
      if (m) {
        parts.push(
          <span key={key++} className="text-violet-600 dark:text-violet-400">
            {m[0]}
          </span>,
        )
        rest = rest.slice(m[0].length)
        continue
      }
    }

    // 词 token
    const tokenMatch = rest.match(/^[\w$.]+/)
    if (!tokenMatch) {
      parts.push(<span key={key++}>{rest[0]}</span>)
      rest = rest.slice(1)
      continue
    }
    const token = tokenMatch[0]

    if (TS_KEYWORDS.has(token)) {
      parts.push(
        <span key={key++} className="font-medium text-primary">
          {token}
        </span>,
      )
    } else if (/^\d+(\.\d+)?$/.test(token) || /^0[xX][\da-fA-F]+$/.test(token)) {
      parts.push(
        <span key={key++} className="text-orange-600 dark:text-orange-400">
          {token}
        </span>,
      )
    } else if (/^[A-Z]/.test(token)) {
      parts.push(
        <span key={key++} className="text-sky-600 dark:text-sky-400">
          {token}
        </span>,
      )
    } else {
      parts.push(<span key={key++}>{token}</span>)
    }
    rest = rest.slice(token.length)
  }

  return parts
}
