import { useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FunctionSquare,
  Package,
} from "lucide-react"
import { cn } from "../../lib/utils"
import type { NodeKind, TreeNode } from "../../lib/api"

interface ProjectTreeProps {
  tree: TreeNode
  activeNodeId?: number
  onOpenNode: (node: TreeNode) => void
}

export function ProjectTree({ tree, activeNodeId, onOpenNode }: ProjectTreeProps) {
  // auto-expand root and its abc children
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const initial = new Set<number>([tree.id])
    tree.children.forEach(child => child.kind === "abc" && initial.add(child.id))
    return initial
  })

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map(node => {
      const hasChildren = node.children.length > 0
      const isOpen = expanded.has(node.id)
      const selectable = node.kind === "class" || node.kind === "method" || node.kind === "abc"
      return (
        <div key={node.id}>
          <button
            type="button"
            className={cn(
              "group flex h-[26px] w-full items-center gap-1 rounded-md px-1.5 text-left text-[12.5px] leading-none transition-colors",
              node.id === activeNodeId
                ? "bg-primary/10 font-medium text-foreground"
                : "text-default-600 hover:bg-black/[0.045] hover:text-foreground dark:text-default-400 dark:hover:bg-white/[0.055]",
            )}
            style={{ paddingLeft: depth * 14 + 6 }}
            onClick={() => {
              if (hasChildren) toggle(node.id)
              if (selectable) onOpenNode(node)
            }}
            title={node.detail ? `${node.name} · ${node.detail}` : node.name}
          >
            {hasChildren ? (
              isOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-default-400" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-default-400" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <NodeIcon kind={node.kind} open={isOpen} />
            <span className="truncate">{node.name}</span>
          </button>
          {hasChildren && isOpen && renderNodes(node.children, depth + 1)}
        </div>
      )
    })

  return <div className="space-y-px">{renderNodes(tree.children.length ? [tree] : [], 0)}</div>
}

function NodeIcon({ kind, open }: { kind: NodeKind; open: boolean }) {
  const cls = "h-3.5 w-3.5 shrink-0"
  switch (kind) {
    case "root":
    case "abc":
      return <FileCode2 className={cn(cls, "text-primary")} />
    case "package":
    case "resource_dir":
      return open ? (
        <FolderOpen className={cn(cls, "text-default-400")} />
      ) : (
        <Folder className={cn(cls, "text-default-400")} />
      )
    case "class":
      return <Package className={cn(cls, "text-emerald-500")} />
    case "method":
      return <FunctionSquare className={cn(cls, "text-violet-500")} />
    default:
      return <FileText className={cn(cls, "text-default-400")} />
  }
}
