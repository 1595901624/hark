/**
 * 项目树组件。
 *
 * 以 jadx 风格的层级树展示反编译结果：项目根 -> `.abc` 单元 -> 包 ->
 * 类 -> 方法。目录/包节点点击展开折叠；类、方法、`.abc` 单元节点
 * 点击时同时触发 {@linkcode ProjectTreeProps.onOpenNode} 打开内容标签。
 */
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

/** {@linkcode ProjectTree} 的组件属性。 */
interface ProjectTreeProps {
  /** 项目树根节点。 */
  tree: TreeNode
  /** 当前激活（在编辑器中打开）的节点 ID，用于高亮；可为空。 */
  activeNodeId?: number
  /** 用户点击可打开节点（类 / 方法 / `.abc` 单元）时触发。 */
  onOpenNode: (node: TreeNode) => void
}

/**
 * 渲染整棵项目树。
 *
 * 初始展开根节点与其下的 `.abc` 单元；展开状态在组件内部维护。
 */
export function ProjectTree({ tree, activeNodeId, onOpenNode }: ProjectTreeProps) {
  /** 处于展开状态的节点 ID 集合 */
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const initial = new Set<number>([tree.id])
    tree.children.forEach(child => child.kind === "abc" && initial.add(child.id))
    return initial
  })

  /** 切换某节点的展开/折叠状态。 */
  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * 递归渲染一层节点。
   * @param nodes 当前层级的节点列表
   * @param depth 层级深度（用于缩进）
   */
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
              "group flex h-[26px] w-max min-w-full items-center gap-1 rounded-md px-1.5 text-left text-[12.5px] leading-none whitespace-nowrap transition-colors",
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
            <span className="whitespace-nowrap">{node.name}</span>
          </button>
          {hasChildren && isOpen && renderNodes(node.children, depth + 1)}
        </div>
      )
    })

  return <div className="space-y-px">{renderNodes(tree.children.length ? [tree] : [], 0)}</div>
}

/**
 * 按节点类型渲染对应图标。
 * @param kind 节点类型
 * @param open 目录类节点是否处于展开状态（决定使用打开/闭合图标）
 */
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
