/**
 * 反编译工作台主组件（jadx-gui 风格布局）。
 *
 * 布局：左侧可拖宽的侧栏（资源树 / 全局搜索双视图切换）+ 右侧多标签代码区
 * （顶部标题栏由 App 统一渲染）。
 *
 * 职责：
 * - 通过原生对话框 / Ctrl+O / 拖拽打开 `.abc` / `.hap` / `.hark` 文件；
 * - 监听标题栏菜单派发的全局事件（打开文件 / 保存 / 另存为 / 关闭项目）；
 * - 「保存 / 另存为」把当前项目与工作区快照写入 `.hark` 二进制工作区文件，
 *   打开 `.hark` 时校验完整性并恢复标签、视图与项目树展开现场；
 * - 管理编辑器标签（最多 12 个）并懒加载节点内容；
 * - 全局搜索（Ctrl+Shift+F）：多类别检索，结果点击后打开对应类并定位行；
 * - 编辑器内查找（Ctrl+F）：高亮全部匹配并支持上一个 / 下一个导航；
 * - 每个内容区提供 `.abc`（反汇编）/ `.ets`（ArkTS 还原）双视图，
 *   按需加载并缓存两份内容，支持把 `.ets` 导出为文件；
 * - 持久化侧栏宽度与侧栏视图选择；打开项目时同步设置页配置的 `ark_disasm` 路径。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { Download, FileCode2, FolderOpen, FolderTree, LoaderCircle, Search } from "lucide-react"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { Button, addToast } from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { cn } from "../../lib/utils"
import { getStoredItem } from "../../lib/store"
import {
  api,
  type NodeContent,
  type OpenProjectResult,
  type SavedWorkspace,
  type SearchHit,
  type TreeNode,
  type ViewKind,
} from "../../lib/api"
import { ProjectTree, type TreeCommand } from "./ProjectTree"
import { EditorTabs, type EditorTab } from "./EditorTabs"
import { CodeView } from "./CodeView"
import { ViewSwitcher } from "./ViewSwitcher"
import { SearchPanel } from "./SearchPanel"
import { EditorFindBar } from "./EditorFindBar"

/** 原生打开对话框的文件类型过滤器。 */
const FILE_FILTERS = [
  {
    name: "Ark 字节码 / 应用包 / 工作区",
    extensions: ["abc", "hap", "har", "app", "hark"],
  },
]

/** `.hark` 工作区文件的原生保存对话框过滤器。 */
const HARK_FILTERS = [{ name: "Hark 工作区", extensions: ["hark"] }]

interface WorkspaceProps {
  /** 项目树侧栏是否收起（状态由 App 持有并持久化，标题栏按钮切换）。 */
  isSidebarCollapsed: boolean
}

/** 单个标签的完整状态：标签信息 + 双视图内容缓存。 */
interface TabEntry {
  /** 标签基础信息。 */
  tab: EditorTab
  /** 项目树节点类型（决定是否显示视图切换器）。 */
  kind: TreeNode["kind"]
  /** 当前激活的视图，默认 `.abc`。 */
  view: ViewKind
  /** 已加载的各视图内容。 */
  contents: Partial<Record<ViewKind, NodeContent>>
  /** 各视图是否正在加载。 */
  loading: Partial<Record<ViewKind, boolean>>
  /** 各视图加载失败的错误信息。 */
  errors: Partial<Record<ViewKind, string>>
}

/** 同一时刻允许打开的最大标签数，超出时淘汰最早的标签。 */
const MAX_TABS = 12

/** 支持双视图切换的节点类型；资源节点只有一种内容。 */
const VIEWABLE_KINDS = new Set<TreeNode["kind"]>(["class", "method", "abc", "root", "package"])

/**
 * 在项目树中按 ID 深度优先查找节点；不存在时返回 `null`。
 * 用于恢复 `.hark` 会话时把快照中的节点 ID 映射回树节点。
 */
function findTreeNode(root: TreeNode, id: number): TreeNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findTreeNode(child, id)
    if (found) return found
  }
  return null
}

/** 读取设置页持久化的 `ark_disasm` 路径（未配置或解析失败时返回空串）。 */
async function readStoredToolPath(): Promise<string> {
  try {
    const raw = await getStoredItem("disassembler-path")
    if (!raw) return ""
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "string" ? parsed.trim() : ""
  } catch {
    return ""
  }
}

/**
 * 渲染整个工作台界面。
 *
 * 无项目时显示拖入提示与「打开文件 / 反编译器设置」入口；
 * 有项目时左侧渲染项目树，右侧按标签状态（加载中 / 出错 / 有内容）
 * 渲染对应视图。
 */
export function Workspace({ isSidebarCollapsed }: WorkspaceProps) {
  /** 项目树根节点；`null` 表示未打开项目 */
  const [tree, setTree] = useState<TreeNode | null>(null)
  /** 当前项目名（打开文件的文件名） */
  const [projectName, setProjectName] = useState<string | null>(null)
  /** 全局忙碌提示（如「正在反编译 …」）；`null` 表示空闲 */
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  /** 已打开的标签列表 */
  const [tabs, setTabs] = useState<TabEntry[]>([])
  /** 标签列表的最新快照（供回调同步读取，避免 updater 异步执行导致的旧值） */
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  /** 激活标签的 key */
  const [activeKey, setActiveKey] = useState<string | undefined>()
  /** 当前会话绑定的 `.hark` 工作区文件路径；`null` 表示尚未保存过 */
  const [harkPath, setHarkPath] = useState<string | null>(null)
  /** 激活标签 key 的最新快照（供回调同步读取） */
  const activeKeyRef = useRef<string | undefined>(activeKey)
  activeKeyRef.current = activeKey
  /** 项目树当前展开的节点 ID 列表（由 ProjectTree 回报，供保存快照） */
  const expandedIdsRef = useRef<number[]>([])
  /** 侧栏宽度（持久化） */
  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>("workspace-sidebar-width", 280)
  /** 是否正在拖拽调整侧栏宽度（拖拽期间禁用宽度过渡动画） */
  const [isResizing, setIsResizing] = useState(false)
  /** 下发给项目树的展开/折叠指令（携带递增 seq 保证重复指令生效） */
  const [treeCommand, setTreeCommand] = useState<TreeCommand | null>(null)
  const treeCommandSeq = useRef(0)
  /** 侧栏当前视图：资源树 / 全局搜索（持久化） */
  const [sidebarView, setSidebarView] = usePersistentState<"tree" | "search">("workspace-sidebar-view", "tree")
  /** 搜索面板聚焦信号：Ctrl+Shift+F 时递增 */
  const [searchFocusSeq, setSearchFocusSeq] = useState(0)
  /** 是否显示编辑器内查找条（Ctrl+F） */
  const [showFindBar, setShowFindBar] = useState(false)
  /** 查找条查询文本 */
  const [findQuery, setFindQuery] = useState("")
  /** 查找是否区分大小写 */
  const [findCaseSensitive, setFindCaseSensitive] = useState(false)
  /** 当前激活匹配序号（0-based） */
  const [activeMatch, setActiveMatch] = useState(0)
  /** 当前内容中的匹配总数（由 CodeView 上报） */
  const [findTotal, setFindTotal] = useState(0)
  /** 全局搜索结果点击后的行定位请求 */
  const [scrollTarget, setScrollTarget] = useState<{ nodeId: number; line: number; seq: number } | null>(null)
  const scrollTargetSeq = useRef(0)

  /** 全部展开项目树。 */
  const expandAll = () =>
    setTreeCommand({ type: "expand-all", seq: ++treeCommandSeq.current })
  /** 全部折叠项目树（仅保留根节点展开）。 */
  const collapseAll = () =>
    setTreeCommand({ type: "collapse-all", seq: ++treeCommandSeq.current })

  /** 打开侧栏全局搜索视图并聚焦输入框（Ctrl+Shift+F）。 */
  const openGlobalSearch = useCallback(() => {
    setSidebarView("search")
    setSearchFocusSeq(seq => seq + 1)
  }, [setSidebarView])

  // ---------- 内容加载 ----------

  /**
   * 加载某个标签指定视图的内容（已缓存或加载中时跳过）。
   * @param tabKey 标签 key
   * @param nodeId 节点 ID
   * @param view 视图类型
   */
  const loadView = useCallback((tabKey: string, nodeId: number, view: ViewKind) => {
    setTabs(prev => {
      const entry = prev.find(e => e.tab.key === tabKey)
      if (!entry || entry.contents[view] || entry.loading[view]) return prev
      return prev.map(e =>
        e.tab.key === tabKey ? { ...e, loading: { ...e.loading, [view]: true }, errors: { ...e.errors, [view]: undefined } } : e,
      )
    })

    void api.getContent(nodeId, view).then(
      content =>
        setTabs(prev =>
          prev.map(entry =>
            entry.tab.key === tabKey
              ? { ...entry, contents: { ...entry.contents, [view]: content }, loading: { ...entry.loading, [view]: false } }
              : entry,
          ),
        ),
      err =>
        setTabs(prev =>
          prev.map(entry =>
            entry.tab.key === tabKey
              ? { ...entry, loading: { ...entry.loading, [view]: false }, errors: { ...entry.errors, [view]: String(err) } }
              : entry,
          ),
        ),
    )
  }, [])

  // ---------- 打开文件 ----------

  /**
   * 打开指定路径的文件：调用后端反编译并重建项目树。
   * 打开 `.hark` 工作区时按会话快照恢复标签顺序、视图与激活标签。
   * 成功后重建标签列表；失败时以 toast 展示错误。
   * @param path 文件绝对路径
   */
  const openFile = useCallback(async (path: string) => {
    setBusyMessage(`正在打开 ${path.split(/[\\/]/).pop()} …`)
    try {
      const result: OpenProjectResult = await api.openProject(path)
      const t = result.tree
      setTree(t)
      setProjectName(t.name)
      // 新项目的节点 ID 会重新分配，旧的搜索行定位请求必须作废
      setScrollTarget(null)
      setShowFindBar(false)
      // 仅当打开的确实是 `.hark` 文件时才绑定会话路径，后续「保存」直接覆写
      const isHark = path.toLowerCase().endsWith(".hark")
      setHarkPath(isHark ? path : null)

      // 恢复 `.hark` 快照：按保存顺序重建标签并预加载各自视图
      const ws = result.session?.workspace
      if (isHark && ws && ws.tabs.length > 0) {
        const restored: TabEntry[] = []
        for (const saved of ws.tabs) {
          const node = findTreeNode(t, saved.nodeId)
          if (!node || restored.some(e => e.tab.nodeId === node.id)) continue
          restored.push({
            tab: { key: `node-${node.id}`, title: node.name, nodeId: node.id },
            kind: node.kind,
            view: saved.view === "ets" ? "ets" : "abc",
            contents: {},
            loading: {},
            errors: {},
          })
        }
        // 与手动打开一致：超过上限时保留最新的标签
        const capped = restored.length > MAX_TABS ? restored.slice(restored.length - MAX_TABS) : restored
        setTabs(capped)
        for (const entry of capped) loadView(entry.tab.key, entry.tab.nodeId, entry.view)
        const activeEntry =
          ws.activeNodeId != null ? capped.find(e => e.tab.nodeId === ws.activeNodeId) : undefined
        setActiveKey(activeEntry?.tab.key ?? capped[capped.length - 1]?.tab.key)
      } else {
        setTabs([])
        setActiveKey(undefined)
      }
      // 恢复侧边栏项目树的展开状态（快照中不存在的 ID 会被静默忽略）
      if (isHark && ws) {
        setTreeCommand({ type: "set-expanded", ids: ws.expandedNodeIds ?? [], seq: ++treeCommandSeq.current })
      }
      // 同步一次工具路径（读取设置页的持久化配置），便于后端立即校验/缓存
      void api.setDisassemblerPath((await readStoredToolPath()) || null)
    } catch (e) {
      addToast({ title: "打开失败", description: String(e), severity: "danger" })
    } finally {
      setBusyMessage(null)
    }
  }, [loadView])

  /** 弹出原生文件选择框并打开选中的文件。 */
  const pickAndOpen = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      filters: FILE_FILTERS,
    })
    if (typeof selected === "string") await openFile(selected)
  }, [openFile])

  // ---------- 保存 / 另存为（.hark）----------

  /** 接收项目树上报的最新展开节点 ID 列表。 */
  const handleExpandedChange = useCallback((ids: number[]) => {
    expandedIdsRef.current = ids
  }, [])

  /** 从当前标签状态整理出待保存的工作区快照。 */
  const buildWorkspaceSnapshot = useCallback((): SavedWorkspace => ({
    tabs: tabsRef.current.map(e => ({ nodeId: e.tab.nodeId, view: e.view })),
    activeNodeId:
      activeKeyRef.current != null
        ? tabsRef.current.find(e => e.tab.key === activeKeyRef.current)?.tab.nodeId ?? null
        : null,
    expandedNodeIds: expandedIdsRef.current,
  }), [])

  /**
   * 另存为新的 `.hark` 工作区文件。
   * 弹出原生保存对话框（默认名为当前项目名），成功后绑定该路径。
   */
  const saveProjectAs = useCallback(async () => {
    if (!tree) {
      addToast({ title: "无法保存", description: "尚未打开项目", severity: "warning" })
      return
    }
    const base = (projectName ?? "workspace").replace(/\.[^.]+$/, "") || "workspace"
    const selected = await saveFileDialog({
      defaultPath: `${base}.hark`,
      filters: HARK_FILTERS,
    })
    if (typeof selected !== "string") return
    try {
      await api.saveProjectHark(selected, buildWorkspaceSnapshot())
      setHarkPath(selected)
      addToast({ title: "已另存为工作区", description: selected, severity: "success" })
    } catch (e) {
      addToast({ title: "保存失败", description: String(e), severity: "danger" })
    }
  }, [tree, projectName, buildWorkspaceSnapshot])

  /**
   * 保存到当前绑定的 `.hark` 文件；尚未绑定过时自动转入「另存为」流程。
   */
  const saveProject = useCallback(async () => {
    if (!tree) {
      addToast({ title: "无法保存", description: "尚未打开项目", severity: "warning" })
      return
    }
    if (!harkPath) {
      await saveProjectAs()
      return
    }
    try {
      await api.saveProjectHark(harkPath, buildWorkspaceSnapshot())
      addToast({ title: "已保存工作区", description: harkPath, severity: "success" })
    } catch (e) {
      addToast({ title: "保存失败", description: String(e), severity: "danger" })
    }
  }, [tree, harkPath, saveProjectAs, buildWorkspaceSnapshot])

  // ---------- 全局事件 ----------

  useEffect(() => {
    /** 标题栏「文件 → 打开文件…」 */
    const onOpenFile = () => void pickAndOpen()
    /** 标题栏「文件 → 关闭项目」 */
    const onCloseProject = () => {
      setTree(null)
      setProjectName(null)
      setTabs([])
      setActiveKey(undefined)
      setHarkPath(null)
      setShowFindBar(false)
      setScrollTarget(null)
      void api.closeProject()
    }
    /** 标题栏「文件 → 保存」 */
    const onSaveProject = () => void saveProject()
    /** 标题栏「文件 → 另存为…」 */
    const onSaveProjectAs = () => void saveProjectAs()
    window.addEventListener("hark:open-file", onOpenFile)
    window.addEventListener("hark:close-project", onCloseProject)
    window.addEventListener("hark:save-project", onSaveProject)
    window.addEventListener("hark:save-project-as", onSaveProjectAs)
    return () => {
      window.removeEventListener("hark:open-file", onOpenFile)
      window.removeEventListener("hark:close-project", onCloseProject)
      window.removeEventListener("hark:save-project", onSaveProject)
      window.removeEventListener("hark:save-project-as", onSaveProjectAs)
    }
  }, [pickAndOpen, saveProject, saveProjectAs])

  // Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+Shift+S 另存为
  // Ctrl+Shift+F 全局搜索 / Ctrl+F 编辑器内查找
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      switch (e.key.toLowerCase()) {
        case "o":
          e.preventDefault()
          void pickAndOpen()
          break
        case "s":
          e.preventDefault()
          if (e.shiftKey) void saveProjectAs()
          else void saveProject()
          break
        case "f":
          e.preventDefault()
          if (e.shiftKey) {
            openGlobalSearch()
          } else if (tabsRef.current.length > 0) {
            setShowFindBar(true)
          }
          break
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [pickAndOpen, saveProject, saveProjectAs, openGlobalSearch])

  // 拖拽文件进窗口直接打开（仅 Tauri 环境）
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent(event => {
        if (event.payload.type === "drop") {
          const path = event.payload.paths[0]
          if (path) void openFile(path)
        }
      })
      .then(stop => (unlisten = stop))
    return () => unlisten?.()
  }, [openFile])

  // ---------- 标签操作 ----------

  /**
   * 打开一个节点对应的标签（已存在时仅激活），并异步加载其内容。
   * @param node 被点击的项目树节点
   */
  const openNode = useCallback(
    (node: TreeNode) => {
      const key = `node-${node.id}`
      setTabs(prev => {
        if (prev.some(entry => entry.tab.key === key)) return prev
        const entry: TabEntry = {
          tab: { key, title: node.name, nodeId: node.id },
          kind: node.kind,
          view: "abc",
          contents: {},
          loading: {},
          errors: {},
        }
        const next = [...prev, entry]
        return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
      })
      setActiveKey(key)
      loadView(key, node.id, "abc")
    },
    [loadView],
  )

  /**
   * 切换某个标签的内容视图（首次切换时触发懒加载）。
   * @param tabKey 标签 key
   * @param view 目标视图
   */
  const switchView = useCallback(
    (tabKey: string, view: ViewKind) => {
      setTabs(prev => prev.map(entry => (entry.tab.key === tabKey ? { ...entry, view } : entry)))
      setActiveKey(tabKey)
      const target = tabsRef.current.find(entry => entry.tab.key === tabKey)
      if (target && !target.contents[view] && !target.loading[view]) {
        loadView(tabKey, target.tab.nodeId, view)
      }
    },
    [loadView],
  )

  /**
   * 全局搜索命中点击：打开对应类 / 资源节点；
   * 带行号时同时下发滚动定位请求（内容就绪后由 CodeView 执行）。
   */
  const openSearchHit = useCallback(
    (hit: SearchHit) => {
      if (!tree) return
      const node = findTreeNode(tree, hit.classNodeId)
      if (!node) return
      openNode(node)
      setScrollTarget(hit.line > 0 ? { nodeId: node.id, line: hit.line, seq: ++scrollTargetSeq.current } : null)
    },
    [tree, openNode],
  )

  /** 编辑器内查找：按方向切换当前激活匹配（循环）。 */
  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (findTotal <= 0) return
      setActiveMatch(prev => ((prev + dir) % findTotal + findTotal) % findTotal)
    },
    [findTotal],
  )

  /** 查找条查询变化：重置当前匹配序号。 */
  const changeFindQuery = useCallback((value: string) => {
    setFindQuery(value)
    setActiveMatch(0)
  }, [])

  // 切换标签时重置编辑器内查找的当前匹配序号
  useEffect(() => {
    setActiveMatch(0)
  }, [activeKey])

  /** 把当前激活标签的 `.ets` 视图导出为文件。 */
  const exportActiveEts = useCallback(async () => {
    const entry = tabs.find(e => e.tab.key === activeKey)
    const content = entry?.contents.ets
    if (!entry || !content) return
    const base = content.title.split(".").pop() ?? "output"
    const safeName = base.replace(/[\\/:*?"<>|]/g, "_") || "output"
    const selected = await saveFileDialog({
      defaultPath: `${safeName}.ets`,
      filters: [{ name: "ArkTS", extensions: ["ets"] }],
    })
    if (typeof selected !== "string") return
    try {
      await api.exportNodeEts(entry.tab.nodeId, selected)
      addToast({ title: "导出成功", description: selected, severity: "success" })
    } catch (e) {
      addToast({ title: "导出失败", description: String(e), severity: "danger" })
    }
  }, [tabs, activeKey])

  /**
   * 关闭指定标签；若关闭的是激活标签，则激活相邻的标签。
   * @param key 要关闭的标签 key
   */
  const closeTab = (key: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(entry => entry.tab.key === key)
      const next = prev.filter(entry => entry.tab.key !== key)
      if (activeKey === key) {
        const fallback = next[Math.min(idx, next.length - 1)]
        setActiveKey(fallback?.tab.key)
      }
      return next
    })
  }

  /** 当前激活的标签状态。 */
  const activeTab = tabs.find(entry => entry.tab.key === activeKey)
  /** 激活标签当前视图的内容状态 */
  const activeContent = activeTab?.contents[activeTab.view]
  const activeLoading = activeTab?.loading[activeTab.view]
  const activeError = activeTab?.errors[activeTab.view]

  // ---------- 侧栏拖宽 ----------

  /** 开始拖动侧栏分隔条：捕获指针并进入列调整状态（禁用过渡动画）。 */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    setIsResizing(true)
  }
  /** 拖动中：将侧栏宽度限制在 200~520px。 */
  const doResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return
    const width = Math.min(520, Math.max(200, e.clientX))
    setSidebarWidth(width)
  }
  /** 结束拖动：释放指针并恢复光标 / 文本选择状态。 */
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    setIsResizing(false)
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* 左侧项目树面板 */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden border-r border-default-200/80 bg-chrome",
            !isResizing && "transition-[width] duration-200",
          )}
          style={{ width: isSidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-default-200/70 pl-2 pr-3">
            {/* 视图切换：资源树 / 搜索 */}
            <div className="flex items-center gap-0.5 rounded-md bg-default-100/60 p-0.5">
              {(
                [
                  { id: "tree", label: "资源树", icon: FolderTree },
                  { id: "search", label: "搜索", icon: Search },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSidebarView(id)}
                  className={cn(
                    "flex h-[22px] items-center gap-1 rounded-[5px] px-2 text-[11.5px] font-medium transition-colors",
                    sidebarView === id
                      ? "bg-background text-foreground shadow-sm shadow-black/[0.06]"
                      : "text-default-500 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              {tree && sidebarView === "tree" && (
                <>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label="全部展开"
                    title="全部展开"
                    onPress={expandAll}
                    className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  >
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label="全部折叠"
                    title="全部折叠"
                    onPress={collapseAll}
                    className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  >
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="打开文件"
                onPress={() => void pickAndOpen()}
                className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {sidebarView === "tree" ? (
            <div className="min-h-0 flex-1 overflow-auto py-2 scrollbar-thin">
              {tree ? (
                <ProjectTree
                  tree={tree}
                  activeNodeId={activeTab?.tab.nodeId}
                  onOpenNode={openNode}
                  command={treeCommand}
                  onExpandedChange={handleExpandedChange}
                />
              ) : (
                <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-default-400">
                  尚未打开项目
                  <br />
                  点击右上角图标或按 Ctrl+O
                </p>
              )}
            </div>
          ) : (
            <SearchPanel hasProject={!!tree} onOpenHit={openSearchHit} focusSeq={searchFocusSeq} />
          )}
          {/* 侧栏拖宽分隔条（收起时隐藏） */}
          {!isSidebarCollapsed && (
            <div
              role="separator"
              aria-label="调整宽度"
              className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
              onPointerDown={startResize}
              onPointerMove={doResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          )}
        </aside>

        {/* 右侧代码区 */}
        <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-default-200/60 bg-background">
          {tabs.length > 0 ? (
            <EditorTabs
              tabs={tabs.map(entry => entry.tab)}
              activeKey={activeKey}
              onSelect={setActiveKey}
              onClose={closeTab}
            />
          ) : (
            <div className="flex h-[38px] shrink-0 items-center border-b border-default-200/80 bg-chrome px-4 text-[12.5px] text-default-400">
              {projectName ?? "Hark"}
            </div>
          )}

          {/* 内容标题栏：标题 + 双视图切换 + 导出 */}
          {(busyMessage || activeTab) && (
            <div className="flex h-[34px] shrink-0 items-center justify-between gap-2 border-b border-default-200/50 bg-chrome/40 px-4">
              <span className="truncate text-[11px] text-default-400">
                {busyMessage ? busyMessage : activeContent?.title ?? ""}
              </span>
              {!busyMessage && activeTab && VIEWABLE_KINDS.has(activeTab.kind) && (
                <div className="flex items-center gap-1.5">
                  <ViewSwitcher
                    value={activeTab.view}
                    onChange={view => activeTab && switchView(activeTab.tab.key, view)}
                  />
                  {activeTab.view === "ets" && (
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      aria-label="导出 .ets"
                      title="导出 .ets"
                      isDisabled={!activeContent}
                      onPress={() => void exportActiveEts()}
                      className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {busyMessage ? (
            <EmptyState
              icon={<LoaderCircle className="h-10 w-10 animate-spin text-primary/70" />}
              text={busyMessage}
            />
          ) : activeLoading ? (
            <EmptyState
              icon={
                activeTab?.view === "ets" ? (
                  <LoaderCircle className="h-8 w-8 animate-spin text-primary/70" />
                ) : (
                  <LoaderCircle className="h-8 w-8 animate-spin text-primary/70" />
                )
              }
              text={activeTab?.view === "ets" ? "正在还原 ArkTS…" : "正在加载内容…"}
            />
          ) : activeError ? (
            <EmptyState icon={<FileCode2 className="h-10 w-10 text-default-300" />} text={activeError} />
          ) : activeContent ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <CodeView
                content={activeContent.body}
                language={activeContent.language}
                findQuery={showFindBar ? findQuery : ""}
                findCaseSensitive={findCaseSensitive}
                activeMatchIndex={showFindBar && findTotal > 0 ? activeMatch : -1}
                onFindStats={setFindTotal}
                scrollToLine={
                  scrollTarget && scrollTarget.nodeId === activeTab.tab.nodeId
                    ? { line: scrollTarget.line, seq: scrollTarget.seq }
                    : null
                }
              />
              {showFindBar && (
                <EditorFindBar
                  query={findQuery}
                  onQueryChange={changeFindQuery}
                  caseSensitive={findCaseSensitive}
                  onCaseSensitiveChange={setFindCaseSensitive}
                  current={activeMatch}
                  total={findTotal}
                  onNext={() => stepMatch(1)}
                  onPrev={() => stepMatch(-1)}
                  onClose={() => setShowFindBar(false)}
                />
              )}
            </div>
          ) : (
            <EmptyState
              icon={<FileCode2 className="h-12 w-12 text-default-300" />}
              text={
                projectName
                  ? "从左侧选择一个类或方法查看反编译结果"
                  : "将 .abc / .hap / .har 文件拖入窗口，或按 Ctrl+O 打开"
              }
              action={
                !projectName && (
                  <Button color="primary" variant="solid" size="sm" onPress={() => void pickAndOpen()}>
                    打开文件…
                  </Button>
                )
              }
            />
          )}
        </main>
      </div>
  )
}

/**
 * 居中空状态占位视图（未打开项目 / 加载中 / 出错等场景复用）。
 * @param props.icon 顶部图标
 * @param props.text 说明文字
 * @param props.text.action 可选的操作按钮区域
 */
function EmptyState({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      {icon}
      <p className="text-sm text-default-400">{text}</p>
      {action}
    </div>
  )
}
