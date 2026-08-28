/**
 * AI 对话历史持久化：按项目路径关联，支持多会话 CRUD。
 *
 * 存储策略（Tauri Store KV）：
 * - `ai-conv-index`：所有会话的元数据索引 ConversationMeta[]
 * - `ai-conv-{id}`：单个完整会话（含 messages）
 *
 * 分拆存储避免单个 JSON 过大，列表加载只需读 index。
 */
import { getStoredItem, setStoredItem, removeStoredItem } from "./store"
import type { UIMessage } from "ai"

/** 会话元数据（列表索引中使用）。 */
export interface ConversationMeta {
  id: string
  /** 项目文件路径（关联键）。 */
  projectKey: string
  /** 会话标题（取首条用户消息前 30 字）。 */
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** 完整会话（含消息列表）。 */
export interface Conversation extends ConversationMeta {
  messages: UIMessage[]
  /** 创建时使用的 Profile ID。 */
  profileId?: string
}

/** Tauri Store 中存储会话索引的键名。 */
const CONV_INDEX_KEY = "ai-conv-index"
/** 单个会话的键名前缀。 */
const CONV_KEY_PREFIX = "ai-conv-"

/** 生成唯一 ID。 */
function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 生成会话标题：取首条用户消息前 30 字。 */
export function generateTitle(messages: UIMessage[]): string {
  const firstUserMsg = messages.find(m => m.role === "user")
  if (!firstUserMsg) return "新对话"
  const text = firstUserMsg.parts
    .map(p => (p.type === "text" ? p.text : ""))
    .join("")
    .trim()
  if (!text) return "新对话"
  return text.length > 30 ? text.slice(0, 30) + "…" : text
}

/** 加载会话索引（全量），可按 projectKey 过滤。 */
export async function loadConversationIndex(projectKey?: string): Promise<ConversationMeta[]> {
  try {
    const raw = await getStoredItem(CONV_INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ConversationMeta[]
    if (!Array.isArray(parsed)) return []
    const sorted = parsed.sort((a, b) => b.updatedAt - a.updatedAt)
    if (projectKey) {
      return sorted.filter(c => c.projectKey === projectKey)
    }
    return sorted
  } catch {
    return []
  }
}

/** 加载单个完整会话。 */
export async function loadConversation(id: string): Promise<Conversation | null> {
  try {
    const raw = await getStoredItem(`${CONV_KEY_PREFIX}${id}`)
    if (!raw) return null
    return JSON.parse(raw) as Conversation
  } catch {
    return null
  }
}

/** 保存会话（同时更新索引）。 */
export async function saveConversation(conv: Conversation): Promise<void> {
  // 保存完整会话
  await setStoredItem(`${CONV_KEY_PREFIX}${conv.id}`, JSON.stringify(conv))

  // 更新索引
  const index = await loadConversationIndex()
  const meta: ConversationMeta = {
    id: conv.id,
    projectKey: conv.projectKey,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messageCount,
  }
  const idx = index.findIndex(c => c.id === conv.id)
  if (idx >= 0) {
    index[idx] = meta
  } else {
    index.push(meta)
  }
  await setStoredItem(CONV_INDEX_KEY, JSON.stringify(index))
}

/** 创建新会话。 */
export async function createConversation(
  projectKey: string,
  messages: UIMessage[] = [],
  profileId?: string,
): Promise<Conversation> {
  const now = Date.now()
  const conv: Conversation = {
    id: genId(),
    projectKey,
    title: generateTitle(messages),
    createdAt: now,
    updatedAt: now,
    messageCount: messages.length,
    messages,
    profileId,
  }
  await saveConversation(conv)
  return conv
}

/** 删除会话。 */
export async function deleteConversation(id: string): Promise<void> {
  await removeStoredItem(`${CONV_KEY_PREFIX}${id}`)
  const index = await loadConversationIndex()
  const filtered = index.filter(c => c.id !== id)
  await setStoredItem(CONV_INDEX_KEY, JSON.stringify(filtered))
}

/** 重命名会话。 */
export async function renameConversation(id: string, title: string): Promise<void> {
  const conv = await loadConversation(id)
  if (!conv) return
  conv.title = title
  await saveConversation(conv)
}

/** 删除某项目的所有会话。 */
export async function deleteConversationsByProject(projectKey: string): Promise<void> {
  const index = await loadConversationIndex(projectKey)
  for (const meta of index) {
    await removeStoredItem(`${CONV_KEY_PREFIX}${meta.id}`)
  }
  const allIndex = await loadConversationIndex()
  const filtered = allIndex.filter(c => c.projectKey !== projectKey)
  await setStoredItem(CONV_INDEX_KEY, JSON.stringify(filtered))
}
