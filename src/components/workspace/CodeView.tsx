import { useMemo } from "react"

interface CodeViewProps {
  content: string
  language: string
}

const ASM_KEYWORDS = new Set([
  ".record",
  ".function",
  ".field",
  ".source_file",
  ".access_flags",
])

export function CodeView({ content, language }: CodeViewProps) {
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

function highlightAsm(line: string) {
  if (!line) return " "
  const trimmed = line.trim()

  // comment lines
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return <span className="text-default-400 italic">{line}</span>
  }

  const parts = []
  let rest = line
  let key = 0

  while (rest.length > 0) {
    const wsMatch = rest.match(/^\s+/)
    if (wsMatch) {
      parts.push(<span key={key++}>{wsMatch[0]}</span>)
      rest = rest.slice(wsMatch[0].length)
      continue
    }

    // string literal
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

    // comment to end of line
    if (rest[0] === ";") {
      parts.push(
        <span key={key++} className="text-default-400 italic">
          {rest}
        </span>,
      )
      rest = ""
      continue
    }

    // word token
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
