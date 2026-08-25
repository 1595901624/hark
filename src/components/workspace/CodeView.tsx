/**
 * 代码视图：带行号与简易语法高亮的只读文本渲染器。
 *
 * 针对 pandasm 反汇编文本（`language === "asm"`）做轻量逐词高亮：
 * 指令伪指令（`.record` / `.function` 等）、标签、寄存器（`vN`）、
 * 数字（十进制 / 十六进制）、字符串字面量与注释；其他语言纯文本渲染。
 */
import { useMemo } from "react"

/** {@linkcode CodeView} 的组件属性。 */
interface CodeViewProps {
  /** 要渲染的正文文本。 */
  content: string
  /** 语言标记：`asm` 启用汇编高亮，其他值按纯文本渲染。 */
  language: string
}

/** 视为伪指令关键字高亮的行首 token。 */
const ASM_KEYWORDS = new Set([
  ".record",
  ".function",
  ".field",
  ".source_file",
  ".access_flags",
])

/**
 * 渲染带行号栏的代码区域。
 *
 * 行号栏使用 `sticky` 定位，横向滚动时保持可见。
 */
export function CodeView({ content, language }: CodeViewProps) {
  /** 按行拆分后的正文（依赖缓存，避免每次渲染重复拆分） */
  const lines = useMemo(() => content.split("\n"), [content])
  const isAsm = language === "asm"

  return (
    <div className="flex min-h-0 flex-1 overflow-auto bg-background font-mono text-[12.5px] leading-[20px]">
      <div className="sticky left-0 z-10 shrink-0 select-none border-r border-default-200/60 bg-default-50 px-3 py-3 text-right text-default-300 dark:bg-default-50/50">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 px-4 py-3 whitespace-pre text-foreground">
        {lines.map((line, i) => (
          <div key={i} className="min-h-[20px]">
            {isAsm ? highlightAsm(line) : line || " "}
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
