import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api } from "@/lib/api"

/**
 * 更新日志视图：在标准 Markdown 渲染基础上，支持引用随应用分发的资源文件。
 *
 * 资源引用约定：
 * - 图片：`![alt](asset:filename.png)` —— 通过后端读取并以 data URL 内联渲染。
 * - JSON / info 文件：以围栏代码块 ` ```asset:json filename.json ` 或 ` ```asset:info filename.info `
 *   形式引用，渲染为带语法高亮的代码块；加载中显示占位，失败显示错误。
 *
 * 文件均从 `resources/changelog/` 读取，不支持「定位」。
 */

/** `asset:` 协议前缀。 */
const ASSET_PROTOCOL = "asset:"
/** 代码块语言前缀，用于标识资源引用块。 */
const ASSET_LANG_PREFIX = "asset:"

/** 图片资源缓存：文件名 → data URL。 */
const imageCache = new Map<string, string>()
/** 文本资源缓存：文件名 → 原文。 */
const textCache = new Map<string, string>()

/** 判断图片 URL 是否为 `asset:` 协议引用。 */
function isAssetUrl(src: string | undefined): boolean {
  return !!src && src.startsWith(ASSET_PROTOCOL)
}

/** 从 `asset:filename` 中提取文件名。 */
function extractAssetName(src: string): string {
  return src.slice(ASSET_PROTOCOL.length)
}

/** 判断代码块语言是否为资源引用（`asset:json` / `asset:info` 等）。 */
function isAssetLang(lang: string | undefined): boolean {
  return !!lang && lang.startsWith(ASSET_LANG_PREFIX)
}

/** 从 `asset:json` 中提取资源类型（`json` / `info`）。 */
function extractAssetType(lang: string): string {
  return lang.slice(ASSET_LANG_PREFIX.length)
}

/** 加载图片资源（带缓存）。 */
async function loadImage(name: string): Promise<string> {
  const cached = imageCache.get(name)
  if (cached !== undefined) return cached
  const asset = await api.readChangelogAsset(name)
  if (asset.kind !== "image") throw new Error("资源不是图片类型")
  imageCache.set(name, asset.data_url)
  return asset.data_url
}

/** 加载文本资源（带缓存）。 */
async function loadText(name: string): Promise<string> {
  const cached = textCache.get(name)
  if (cached !== undefined) return cached
  const asset = await api.readChangelogAsset(name)
  if (asset.kind !== "text") throw new Error("资源不是文本类型")
  textCache.set(name, asset.text)
  return asset.text
}

/** JSON / info 文件的语法高亮渲染器（轻量逐行实现）。 */
function highlightJsonLike(text: string, lang: string): React.ReactNode {
  const lines = text.split("\n")
  return lines.map((line, i) => (
    <div key={i} className="whitespace-pre">
      {highlightJsonLine(line, lang)}
      {"\n"}
    </div>
  ))
}

/** JSON / info 单行高亮。 */
function highlightJsonLine(line: string, _lang: string): React.ReactNode {
  if (!line) return " "
  const parts: React.ReactNode[] = []
  let rest = line
  let key = 0
  while (rest.length > 0) {
    const wsMatch = rest.match(/^\s+/)
    if (wsMatch) {
      parts.push(<span key={key++}>{wsMatch[0]}</span>)
      rest = rest.slice(wsMatch.length)
      continue
    }
    if (rest[0] === '"') {
      const end = findStringEnd(rest)
      const str = rest.slice(0, end)
      const after = rest.slice(end)
      const afterTrimmed = after.match(/^\s*/)?.[0] ?? ""
      const nextChar = after.slice(afterTrimmed.length)[0]
      if (nextChar === ":") {
        parts.push(
          <span key={key++} className="text-sky-600 dark:text-sky-400">
            {str}
          </span>,
        )
      } else {
        parts.push(
          <span key={key++} className="text-amber-600 dark:text-amber-400">
            {str}
          </span>,
        )
      }
      rest = after
      continue
    }
    const tokenMatch = rest.match(/^[^\s"',:{}[\]]+/)
    if (!tokenMatch) {
      parts.push(<span key={key++}>{rest[0]}</span>)
      rest = rest.slice(1)
      continue
    }
    const token = tokenMatch[0]
    if (token === "true" || token === "false" || token === "null") {
      parts.push(
        <span key={key++} className="text-violet-600 dark:text-violet-400">
          {token}
        </span>,
      )
    } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) {
      parts.push(
        <span key={key++} className="text-orange-600 dark:text-orange-400">
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

/** 计算字符串字面量的结束下标（闭区间后一位）。 */
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

/** 图片节点：加载 `asset:` 资源后以 data URL 渲染。 */
function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = useMemo(() => extractAssetName(src), [src])
  useEffect(() => {
    let cancelled = false
    setError(null)
    void loadImage(name).then(
      data => !cancelled && setUrl(data),
      err => !cancelled && setError(String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [name])
  if (error) {
    return (
      <span className="inline-block rounded-md bg-danger-100 px-2 py-1 text-xs text-danger-600 dark:bg-danger-500/20 dark:text-danger-400">
        图片加载失败：{name}
      </span>
    )
  }
  if (!url) {
    return (
      <span className="inline-block animate-pulse rounded-md bg-default-200/60 px-2 py-1 text-xs text-default-400 dark:bg-default-200/20">
        加载图片 {name}…
      </span>
    )
  }
  return <img src={url} alt={alt} />
}

/** 资源引用代码块：加载 JSON / info 文件并渲染高亮内容。 */
function AssetCodeBlock({ lang, filename }: { lang: string; filename: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setError(null)
    void loadText(filename).then(
      text => !cancelled && setContent(text),
      err => !cancelled && setError(String(err)),
    )
    return () => {
      cancelled = true
    }
  }, [filename])
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-default-200/80 bg-default-200/40 dark:border-default-200/40 dark:bg-black/30">
      <div className="flex items-center justify-between border-b border-default-200/60 bg-chrome px-3 py-1.5 text-[11px] text-default-500">
        <span className="font-mono">{filename}</span>
        <span className="uppercase tracking-wide opacity-60">{extractAssetType(lang)}</span>
      </div>
      <pre className="overflow-auto px-3 py-2 text-[12px] leading-relaxed">
        {error ? (
          <span className="text-danger-600 dark:text-danger-400">加载失败：{error}</span>
        ) : content === null ? (
          <span className="text-default-400">加载中…</span>
        ) : (
          <code className="font-mono">{highlightJsonLike(content, lang)}</code>
        )}
      </pre>
    </div>
  )
}

/** 自定义 `img` 渲染：拦截 `asset:` 协议。 */
function ImgRenderer(props: ComponentPropsWithoutRef<"img">) {
  const { src, alt } = props
  if (src && isAssetUrl(src)) {
    return <AssetImage src={src} alt={alt ?? ""} />
  }
  return <img {...props} />
}

/** 自定义 `code` 渲染：拦截围栏代码块的 `asset:` 语言标记。 */
function CodeRenderer(props: ComponentPropsWithoutRef<"code"> & { className?: string }) {
  const { className, children } = props
  const lang = /language-(.+)/.exec(className || "")?.[1]
  if (lang && isAssetLang(lang)) {
    const filename = String(children).trim()
    return <AssetCodeBlock lang={lang} filename={filename} />
  }
  return <code {...props} />
}

/** 自定义 `pre` 渲染：资源引用块不包裹 `<pre>`（由 `AssetCodeBlock` 自行布局）。 */
function PreRenderer(props: ComponentPropsWithoutRef<"pre">) {
  const child = props.children as React.ReactElement<{ className?: string; children?: React.ReactNode }>
  const childClassName = child?.props?.className
  const lang = /language-(.+)/.exec(childClassName || "")?.[1]
  if (lang && isAssetLang(lang)) {
    return <>{props.children}</>
  }
  return <pre {...props} />
}

/** 更新日志视图组件。 */
export function ChangelogView({ content }: { content: string }) {
  return (
    <div className="ai-markdown min-h-0 flex-1 overflow-auto p-6 scrollbar-thin">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ImgRenderer,
          code: CodeRenderer as never,
          pre: PreRenderer,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
