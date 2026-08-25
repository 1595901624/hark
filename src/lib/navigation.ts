import type { LucideIcon } from "lucide-react"
import { Code2, FileCode2, Shield, Wand2, ArrowRightLeft, FileText, Lock } from "lucide-react"

export type ToolId = "home" | "encoder" | "crypto" | "classical" | "formatters" | "generators" | "converter" | "others" | "settings"

export interface NavChild {
  id: string
  tabId: string
  label: string
}

export interface NavGroup {
  id: ToolId
  label: string
  icon: LucideIcon
  gradient: string
  iconColor: string
  children: NavChild[]
}

export const navGroups: NavGroup[] = [
  {
    id: "encoder",
    label: "编码器",
    icon: Code2,
    gradient: "from-purple-500/20 to-pink-500/20",
    iconColor: "text-purple-600 dark:text-purple-400",
    children: [
      { id: "base64", tabId: "base64", label: "Base64" },
      { id: "base32", tabId: "base32", label: "Base32" },
      { id: "hex", tabId: "hex", label: "Hex" },
      { id: "url", tabId: "url", label: "URL" },
      { id: "jwt", tabId: "jwt", label: "JWT" },
    ],
  },
  {
    id: "crypto",
    label: "加密",
    icon: Shield,
    gradient: "from-blue-500/20 to-indigo-500/20",
    iconColor: "text-blue-600 dark:text-blue-400",
    children: [
      { id: "md5", tabId: "md5", label: "MD5" },
      { id: "sha", tabId: "sha", label: "SHA" },
      { id: "aes", tabId: "aes", label: "AES" },
      { id: "rsa", tabId: "rsa", label: "RSA" },
      { id: "sm2", tabId: "sm2", label: "SM2" },
      { id: "sm3", tabId: "sm3", label: "SM3" },
      { id: "sm4", tabId: "sm4", label: "SM4" },
    ],
  },
  {
    id: "classical",
    label: "古典密码",
    icon: Lock,
    gradient: "from-amber-500/20 to-orange-500/20",
    iconColor: "text-amber-600 dark:text-amber-400",
    children: [
      { id: "caesar", tabId: "caesar", label: "凯撒密码" },
      { id: "morse", tabId: "morse", label: "摩斯密码" },
      { id: "bacon", tabId: "bacon", label: "培根密码" },
    ],
  },
  {
    id: "formatters",
    label: "格式化",
    icon: FileCode2,
    gradient: "from-emerald-500/20 to-teal-500/20",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    children: [
      { id: "json", tabId: "json", label: "JSON" },
      { id: "xml", tabId: "xml", label: "XML" },
      { id: "css", tabId: "css", label: "CSS" },
      { id: "sql", tabId: "sql", label: "SQL" },
    ],
  },
  {
    id: "generators",
    label: "生成器",
    icon: Wand2,
    gradient: "from-rose-500/20 to-pink-500/20",
    iconColor: "text-rose-600 dark:text-rose-400",
    children: [
      { id: "uuid", tabId: "uuid", label: "UUID" },
    ],
  },
  {
    id: "converter",
    label: "转换器",
    icon: ArrowRightLeft,
    gradient: "from-cyan-500/20 to-blue-500/20",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    children: [
      { id: "json-xml", tabId: "json-xml", label: "JSON / XML" },
      { id: "json-yaml", tabId: "json-yaml", label: "JSON / YAML" },
      { id: "timestamp", tabId: "timestamp", label: "时间戳" },
      { id: "subnet", tabId: "subnet", label: "子网计算" },
    ],
  },
  {
    id: "others",
    label: "其他",
    icon: FileText,
    gradient: "from-slate-500/20 to-gray-500/20",
    iconColor: "text-slate-600 dark:text-slate-400",
    children: [
      { id: "regex", tabId: "regex", label: "正则表达式" },
      { id: "qr", tabId: "qr", label: "二维码" },
    ],
  },
]

export function findGroup(toolId: ToolId): NavGroup | undefined {
  return navGroups.find(group => group.id === toolId)
}

export function findChild(toolId: ToolId, tabId?: string): NavChild | undefined {
  const group = findGroup(toolId)
  if (!group) return undefined
  if (tabId) return group.children.find(child => child.tabId === tabId)
  return group.children[0]
}
