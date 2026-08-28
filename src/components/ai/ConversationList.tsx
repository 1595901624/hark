/**
 * 对话历史列表：内嵌在 AI 面板内，按时间倒序展示当前项目的所有会话。
 */
import { useState } from "react"
import { Trash2, Pencil, Check, X, MessageSquare } from "lucide-react"
import { cn } from "../../lib/utils"
import type { ConversationMeta } from "../../lib/ai-history"

interface ConversationListProps {
  conversations: ConversationMeta[]
  activeConversationId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

export function ConversationList({
  conversations,
  activeConversationId,
  onSelect,
  onDelete,
  onRename,
}: ConversationListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const startEdit = (id: string, currentTitle: string) => {
    setEditingId(id)
    setEditValue(currentTitle)
  }

  const confirmEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageSquare className="h-6 w-6 text-default-300" />
        <p className="text-xs text-default-400">暂无历史对话</p>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="px-2 py-2">
        <div className="mb-1.5 px-1.5 text-[10px] font-medium uppercase tracking-wide text-default-300">
          历史对话
        </div>
        {conversations.map(conv => (
          <div
            key={conv.id}
            className={cn(
              "group mb-0.5 flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
              activeConversationId === conv.id
                ? "bg-primary/10"
                : "hover:bg-default-100 dark:hover:bg-white/5",
            )}
          >
            {editingId === conv.id ? (
              <div className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") confirmEdit()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                  className="min-w-0 flex-1 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-xs text-foreground outline-none"
                />
                <button
                  type="button"
                  onClick={confirmEdit}
                  className="shrink-0 rounded p-0.5 text-success hover:bg-success/10"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="shrink-0 rounded p-0.5 text-default-400 hover:bg-default-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onSelect(conv.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className={cn(
                    "truncate text-xs",
                    activeConversationId === conv.id ? "font-medium text-primary" : "text-default-500",
                  )}>
                    {conv.title}
                  </div>
                  <div className="text-[10px] text-default-300">
                    {new Date(conv.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {conv.messageCount} 条
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); startEdit(conv.id, conv.title) }}
                    className="rounded p-1 text-default-400 hover:bg-default-200 hover:text-foreground"
                    title="重命名"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(conv.id) }}
                    className="rounded p-1 text-default-400 hover:bg-danger/10 hover:text-danger"
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
