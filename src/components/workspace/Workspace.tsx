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
 *   按需加载并缓存两份内容，支持把反汇编导出为 `.pa`、
 *   把 ArkTS 还原结果导出为 `.ets` 文件；
 * - 「文件 → 导出」把项目内全部原始 `.abc` 字节码与全部单元反汇编
 *   （`.pa`）批量导出到所选目录；
 * - 持久化侧栏宽度与侧栏视图选择；打开项目时同步设置页配置的 `ark_disasm` 路径。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getVersion } from "@tauri-apps/api/app"
import { ChangelogView } from "./ChangelogView"
import { Crosshair, Download, FileCode2, FolderOpen, FolderTree, LoaderCircle, Search, TriangleAlert } from "lucide-react"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { Button, addToast } from "../ui/base-ui"
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { cn } from "../../lib/utils"
import { getCachedStoredItem, getStoredItem } from "../../lib/store"
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
import { AIChatContainer } from "../ai/AIChatContainer"

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
  /** AI 面板是否展开。 */
  isAIPanelOpen: boolean
  /** 打开 AI 设置页。 */
  onOpenAISettings: () => void
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

/** 更新日志特殊标签的固定 key（不对应项目树节点）。 */
const CHANGELOG_TAB_KEY = "changelog"

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

/** `summarizeTree` 的体量约束，避免系统提示词过大。 */
const TREE_SUMMARY_MAX_DEPTH = 3
const TREE_SUMMARY_MAX_NODES = 200

/** 把项目树序列化为带缩进的文本摘要，受深度/节点数上限约束。 */
function summarizeTree(root: TreeNode): string {
  const lines: string[] = []
  let nodeCount = 0
  let truncated = false

  const walk = (node: TreeNode, depth: number): void => {
    if (truncated) return
    if (depth > TREE_SUMMARY_MAX_DEPTH) return
    if (nodeCount >= TREE_SUMMARY_MAX_NODES) {
      truncated = true
      return
    }
    nodeCount++
    const indent = "  ".repeat(depth)
    const detail = node.detail ? ` (${node.detail})` : ""
    lines.push(`${indent}${node.name} [${node.kind}]${detail}`)
    for (const child of node.children) {
      walk(child, depth + 1)
    }
  }

  walk(root, 0)
  if (truncated) {
    lines.push("…（已截断，仅展示部分结构）")
  }
  return lines.join("\n")
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

/** 读取设置页持久化的默认文件打开模式（未加载时回退 `.abc`）。 */
function readDefaultOpenView(): ViewKind {
  const cached = getCachedStoredItem("default-open-view")
  if (cached === undefined || cached === null) return "abc"
  try {
    return JSON.parse(cached) === "ets" ? "ets" : "abc"
  } catch {
    return "abc"
  }
}

/** 读取设置页持久化的「点击方法时在新页面打开」配置（未加载时回退 `false`）。 */
function readOpenMethodInNewTab(): boolean {
  const cached = getCachedStoredItem("open-method-in-new-tab")
  if (cached === undefined || cached === null) return false
  try {
    return JSON.parse(cached) === true
  } catch {
    return false
  }
}

/**
 * 渲染整个工作台界面。
 *
 * 无项目时显示拖入提示与「打开文件 / 反编译器设置」入口；
 * 有项目时左侧渲染项目树，右侧按标签状态（加载中 / 出错 / 有内容）
 * 渲染对应视图。
 */
export function Workspace({ isSidebarCollapsed, isAIPanelOpen, onOpenAISettings }: WorkspaceProps) {
  /** 项目树根节点；`null` 表示未打开项目 */
  const [tree, setTree] = useState<TreeNode | null>(null)
  /** 当前项目名（打开文件的文件名） */
  const [projectName, setProjectName] = useState<string | null>(null)
  /** 当前项目文件绝对路径（用作 AI 会话历史关联键） */
  const [projectPath, setProjectPath] = useState<string | null>(null)
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
  /** 是否正在打开项目（回调中同步判断，避免重复打开） */
  const openingRef = useRef(false)
  /** 打开代次计数器：确保旧打开的 finally 不会干扰新打开的状态 */
  const openSeqRef = useRef(0)
  /** 用户在打开过程中又选择了新文件时暂存的路径，等待确认 */
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null)
  /** AI 面板宽度（持久化） */
  const [aiPanelWidth, setAiPanelWidth] = usePersistentState<number>("ai-panel-width", 380)
  /** AI 面板拖宽状态 */
  const [isAIResizing, setIsAIResizing] = useState(false)
  /** 更新日志标签是否打开 */
  const [changelogOpen, setChangelogOpen] = useState(false)
  /** 更新日志 Markdown 内容（加载完成后缓存） */
  const [changelogContent, setChangelogContent] = useState<string | null>(null)
  /** 更新日志是否正在加载 */
  const [changelogLoading, setChangelogLoading] = useState(false)
  /** 上次查看更新日志的应用版本号（持久化，用于判断新版本首次打开） */
  const [lastViewedChangelogVersion, setLastViewedChangelogVersion] = usePersistentState<string>(
    "last-viewed-changelog-version",
    "",
  )

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

  /** 打开更新日志标签页（内容未加载时自动拉取），并激活该标签。 */
  const openChangelog = useCallback(() => {
    setChangelogOpen(true)
    setActiveKey(CHANGELOG_TAB_KEY)
    if (changelogContent === null && !changelogLoading) {
      setChangelogLoading(true)
      void api.readChangelog().then(
        content => {
          setChangelogContent(content)
          setChangelogLoading(false)
        },
        err => {
          setChangelogContent(`读取更新日志失败：${String(err)}`)
          setChangelogLoading(false)
        },
      )
    }
  }, [changelogContent, changelogLoading])

  /** 关闭更新日志标签页，激活回退到最近的项目标签。 */
  const closeChangelog = useCallback(() => {
    setChangelogOpen(false)
    if (activeKeyRef.current === CHANGELOG_TAB_KEY) {
      const fallback = tabsRef.current[tabsRef.current.length - 1]
      setActiveKey(fallback?.tab.key)
    }
  }, [])

  // 确保默认打开模式与方法打开方式已加载到缓存，供 openNode 同步读取
  useEffect(() => {
    void getStoredItem("default-open-view")
    void getStoredItem("open-method-in-new-tab")
  }, [])

  // 新版本首次打开时自动展示更新日志（仅 Tauri 环境）
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return
    void getVersion().then(version => {
      if (version && version !== lastViewedChangelogVersion) {
        setLastViewedChangelogVersion(version)
        openChangelog()
      }
    })
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    // 正在打开时暂存路径，由确认对话框决定是否终止当前并打开新的
    if (openingRef.current) {
      setPendingOpenPath(path)
      return
    }
    openingRef.current = true
    const mySeq = ++openSeqRef.current
    setBusyMessage(`正在打开 ${path.split(/[\\/]/).pop()} …`)
    try {
      const result: OpenProjectResult = await api.openProject(path)
      const t = result.tree
      setTree(t)
      setProjectName(t.name)
      setProjectPath(path)
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
      // 被新打开取代的旧任务：静默忽略，不干扰新任务的 UI
      if (openSeqRef.current !== mySeq) return
      // 被用户取消：静默忽略
      if (String(e) === "cancelled") return
      addToast({ title: "打开失败", description: String(e), severity: "danger" })
    } finally {
      // 仅当仍是最新任务时才重置状态
      if (openSeqRef.current === mySeq) {
        openingRef.current = false
        setBusyMessage(null)
      }
    }
  }, [loadView])

  /** 用户确认终止当前打开并打开新文件。 */
  const confirmReplaceOpen = useCallback(async () => {
    const path = pendingOpenPath
    setPendingOpenPath(null)
    if (!path) return
    await api.cancelOpenProject()
    openingRef.current = false
    void openFile(path)
  }, [pendingOpenPath, openFile])

  /** 用户取消替换，继续等待当前打开完成。 */
  const cancelReplaceOpen = useCallback(() => {
    setPendingOpenPath(null)
  }, [])

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

  /**
   * 项目级导出的通用流程：校验项目 → 选择目录 → 调用后端 → toast。
   */
  const runProjectExport = useCallback(
    async (
      invoke: (dir: string) => Promise<string[]>,
      successTitle: (count: number) => string,
    ) => {
      if (!tree) {
        addToast({ title: "无法导出", description: "尚未打开项目", severity: "warning" })
        return
      }
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
        title: "选择导出目录",
      })
      if (typeof selected !== "string") return
      try {
        const files = await invoke(selected)
        addToast({ title: successTitle(files.length), description: selected, severity: "success" })
      } catch (e) {
        addToast({ title: "导出失败", description: String(e), severity: "danger" })
      }
    },
    [tree],
  )

  /** 导出项目内全部原始 `.abc` 字节码。 */
  const exportProjectAbc = useCallback(
    () =>
      runProjectExport(
        (dir) => api.exportProjectAbc(dir),
        (n) => `已导出 ${n} 个 abc 文件`,
      ),
    [runProjectExport],
  )

  /** 导出项目全部单元的反汇编文本（`.pa`）。 */
  const exportProjectPa = useCallback(
    () =>
      runProjectExport(
        (dir) => api.exportProjectPa(dir),
        (n) => `已导出 ${n} 个 .pa 文件`,
      ),
    [runProjectExport],
  )

  // ---------- 全局事件 ----------

  useEffect(() => {
    /** 标题栏「文件 → 打开文件…」 */
    const onOpenFile = () => void pickAndOpen()
    /** 标题栏「文件 → 关闭项目」 */
    const onCloseProject = () => {
      setTree(null)
      setProjectName(null)
      setProjectPath(null)
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
    /** 标题栏「文件 → 导出 → ABC 字节码…」 */
    const onExportProjectAbc = () => void exportProjectAbc()
    /** 标题栏「文件 → 导出 → 反汇编 (.pa)…」 */
    const onExportProjectPa = () => void exportProjectPa()
    /** 标题栏「帮助 → 更新日志」 */
    const onOpenChangelog = () => openChangelog()
    window.addEventListener("hark:open-file", onOpenFile)
    window.addEventListener("hark:close-project", onCloseProject)
    window.addEventListener("hark:save-project", onSaveProject)
    window.addEventListener("hark:save-project-as", onSaveProjectAs)
    window.addEventListener("hark:export-project-abc", onExportProjectAbc)
    window.addEventListener("hark:export-project-pa", onExportProjectPa)
    window.addEventListener("hark:open-changelog", onOpenChangelog)
    return () => {
      window.removeEventListener("hark:open-file", onOpenFile)
      window.removeEventListener("hark:close-project", onCloseProject)
      window.removeEventListener("hark:save-project", onSaveProject)
      window.removeEventListener("hark:save-project-as", onSaveProjectAs)
      window.removeEventListener("hark:export-project-abc", onExportProjectAbc)
      window.removeEventListener("hark:export-project-pa", onExportProjectPa)
      window.removeEventListener("hark:open-changelog", onOpenChangelog)
    }
  }, [pickAndOpen, saveProject, saveProjectAs, exportProjectAbc, exportProjectPa, openChangelog])

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
          } else if (tabsRef.current.length > 0 && activeKeyRef.current !== CHANGELOG_TAB_KEY) {
            setShowFindBar(true)
          }
          break
        case "a":
          if (e.shiftKey) {
            e.preventDefault()
            window.dispatchEvent(new Event("hark:toggle-ai-panel"))
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
  const openNodeInTab = useCallback(
    (node: TreeNode) => {
      const key = `node-${node.id}`
      const view: ViewKind = VIEWABLE_KINDS.has(node.kind) ? readDefaultOpenView() : "abc"
      setTabs(prev => {
        if (prev.some(entry => entry.tab.key === key)) return prev
        const entry: TabEntry = {
          tab: { key, title: node.name, nodeId: node.id },
          kind: node.kind,
          view,
          contents: {},
          loading: {},
          errors: {},
        }
        const next = [...prev, entry]
        return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
      })
      setActiveKey(key)
      loadView(key, node.id, view)
    },
    [loadView],
  )

  /**
   * 点击方法时导航到所属类并滚动到方法声明处（类似 IDE 的 Structure）。
   * 定位失败时回退到独立打开方法标签。
   * @param node 方法节点
   */
  const navigateToMethodInClass = useCallback(
    async (node: TreeNode) => {
      if (!tree) { openNodeInTab(node); return }
      try {
        const loc = await api.methodLocation(node.id)
        const classNode = findTreeNode(tree, loc.class_node_id)
        if (!classNode) { openNodeInTab(node); return }
        // 确定目标视图：已打开的类标签用其当前视图，否则用默认视图
        const existing = tabsRef.current.find(e => e.tab.nodeId === classNode.id)
        const view: ViewKind = existing?.view ?? readDefaultOpenView()
        openNodeInTab(classNode)
        const line = view === "abc" ? loc.abc_line : loc.ets_line
        if (line > 0) {
          setScrollTarget({ nodeId: classNode.id, line, seq: ++scrollTargetSeq.current })
        }
      } catch {
        openNodeInTab(node)
      }
    },
    [tree, openNodeInTab],
  )

  /**
   * 节点点击分发器：方法节点根据设置决定是新开标签还是跳转到所属类；
   * 其他节点直接打开标签。
   * @param node 被点击的项目树节点
   */
  const openNode = useCallback(
    (node: TreeNode) => {
      if (node.kind === "method" && !readOpenMethodInNewTab()) {
        void navigateToMethodInClass(node)
      } else {
        openNodeInTab(node)
      }
    },
    [navigateToMethodInClass, openNodeInTab],
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

  /** 把当前激活标签的反汇编文本（abc 视图）导出为 `.pa` 文件。 */
  const exportActivePa = useCallback(async () => {
    const entry = tabs.find(e => e.tab.key === activeKey)
    const content = entry?.contents.abc
    if (!entry || !content) return
    const base = content.title.split("/").pop() ?? "output"
    const safeName = base.replace(/[\\/:*?"<>|]/g, "_") || "output"
    const selected = await saveFileDialog({
      defaultPath: `${safeName}.pa`,
      filters: [{ name: "pandasm 反汇编", extensions: ["pa"] }],
    })
    if (typeof selected !== "string") return
    try {
      await api.exportNodePa(entry.tab.nodeId, selected)
      addToast({ title: "导出成功", description: selected, severity: "success" })
    } catch (e) {
      addToast({ title: "导出失败", description: String(e), severity: "danger" })
    }
  }, [tabs, activeKey])

  /** 把当前激活标签的图片资源导出为原始文件。 */
  const exportActiveImage = useCallback(async () => {
    const entry = tabs.find(e => e.tab.key === activeKey)
    const content = entry?.contents.abc
    if (!entry || !content) return
    const base = content.title.split("/").pop() ?? "image"
    const safeName = base.replace(/[\\/:*?"<>|]/g, "_") || "image"
    const selected = await saveFileDialog({
      defaultPath: `${safeName}`,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    })
    if (typeof selected !== "string") return
    try {
      await api.exportNodeImage(entry.tab.nodeId, selected)
      addToast({ title: "导出成功", description: selected, severity: "success" })
    } catch (e) {
      addToast({ title: "导出失败", description: String(e), severity: "danger" })
    }
  }, [tabs, activeKey])

  /** 把当前激活标签的文本资源（.json / .info）导出为原始文件。 */
  const exportActiveResource = useCallback(async () => {
    const entry = tabs.find(e => e.tab.key === activeKey)
    const content = entry?.contents.abc
    if (!entry || !content) return
    const base = content.title.split("/").pop() ?? "resource"
    const safeName = base.replace(/[\\/:*?"<>|]/g, "_") || "resource"
    const selected = await saveFileDialog({
      defaultPath: `${safeName}`,
      filters: [{ name: "JSON / Info", extensions: ["json", "info"] }],
    })
    if (typeof selected !== "string") return
    try {
      await api.exportNodeResource(entry.tab.nodeId, selected)
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
    if (key === CHANGELOG_TAB_KEY) {
      closeChangelog()
      return
    }
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

  /** 关闭除指定标签外的所有标签。 */
  const closeOtherTabs = (key: string) => {
    if (key === CHANGELOG_TAB_KEY) {
      setTabs([])
      setActiveKey(CHANGELOG_TAB_KEY)
      return
    }
    setTabs(prev => prev.filter(entry => entry.tab.key === key))
    setChangelogOpen(false)
    setActiveKey(key)
  }

  /** 关闭所有标签。 */
  const closeAllTabs = () => {
    setTabs([])
    setChangelogOpen(false)
    setActiveKey(undefined)
  }

  /** 当前激活的标签状态。 */
  const activeTab = tabs.find(entry => entry.tab.key === activeKey)

  /** 定位到当前激活标签对应的项目树节点（展开祖先并滚动到可视区）。 */
  const revealActiveNode = useCallback(() => {
    if (!tree || !activeTab) return
    setTreeCommand({ type: "reveal-node", nodeId: activeTab.tab.nodeId, seq: ++treeCommandSeq.current })
  }, [tree, activeTab])

  /** 激活标签当前视图的内容状态 */
  const activeContent = activeTab?.contents[activeTab.view]
  const activeLoading = activeTab?.loading[activeTab.view]
  const activeError = activeTab?.errors[activeTab.view]

  /** 项目结构摘要：把当前项目树序列化为文本，供 AI 上下文使用。 */
  const projectTreeSummary = useMemo(
    () => (tree ? summarizeTree(tree) : undefined),
    [tree],
  )

  /** AI 对话上下文：当前激活标签的代码信息 + 项目结构摘要（memoized 避免渲染循环）。 */
  const aiContext = useMemo(
    () => projectPath
      ? {
          projectName: projectName ?? "",
          projectPath,
          activeNodeName: activeTab?.tab.title ?? "",
          activeView: activeTab?.view ?? "abc" as ViewKind,
          codeContent: activeContent?.body ?? "",
          projectTreeSummary,
        }
      : null,
    [activeTab, activeContent, projectName, projectPath, projectTreeSummary],
  )

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

  // ---------- AI 面板拖宽 ----------

  /** 开始拖动 AI 面板分隔条。 */
  const startAIResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    setIsAIResizing(true)
  }
  /** 拖动中：将 AI 面板宽度限制在 280~600px（从右侧算）。 */
  const doAIResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isAIResizing) return
    const width = Math.min(600, Math.max(280, window.innerWidth - e.clientX))
    setAiPanelWidth(width)
  }
  /** 结束拖动。 */
  const endAIResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isAIResizing) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    setIsAIResizing(false)
  }

  return (
    <>
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
                    aria-label="定位当前文件"
                    title="定位当前文件"
                    isDisabled={!activeTab}
                    onPress={revealActiveNode}
                    className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                  </Button>
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
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label="打开文件"
                    title="打开文件"
                    onPress={() => void pickAndOpen()}
                    className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
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
          {tabs.length > 0 || changelogOpen ? (
            <EditorTabs
              tabs={[
                ...(changelogOpen
                  ? [{ key: CHANGELOG_TAB_KEY, title: "更新日志", nodeId: -1 }]
                  : []),
                ...tabs.map(entry => entry.tab),
              ]}
              activeKey={activeKey}
              onSelect={setActiveKey}
              onClose={closeTab}
              onCloseOthers={closeOtherTabs}
              onCloseAll={closeAllTabs}
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
                  {activeTab.view === "abc" && (
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      aria-label="导出反汇编 (.pa)"
                      title="导出反汇编 (.pa)"
                      isDisabled={!activeContent}
                      onPress={() => void exportActivePa()}
                      className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  )}
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
              {!busyMessage && activeTab && activeTab.kind === "resource" && activeContent?.language === "image" && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label="导出图片"
                  title="导出图片"
                  onPress={() => void exportActiveImage()}
                  className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              )}
              {!busyMessage && activeTab && activeTab.kind === "resource" && activeContent?.language === "json" && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label="导出文件"
                  title="导出文件"
                  onPress={() => void exportActiveResource()}
                  className="h-6 w-6 min-w-6 rounded-md text-default-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}

          {activeKey === CHANGELOG_TAB_KEY ? (
            changelogLoading ? (
              <EmptyState
                icon={<LoaderCircle className="h-8 w-8 animate-spin text-primary/70" />}
                text="正在加载更新日志…"
              />
            ) : (
              <ChangelogView content={changelogContent ?? ""} />
            )
          ) : busyMessage ? (
            <EmptyState
              icon={<LoaderCircle className="h-10 w-10 animate-spin text-primary/70" />}
              text={busyMessage}
              action={
                <Button
                  color="danger"
                  variant="flat"
                  size="sm"
                  onPress={() => void api.cancelOpenProject()}
                >
                  取消
                </Button>
              }
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
            activeContent.language === "image" ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-default-50/50 p-6">
                <img
                  src={activeContent.body}
                  alt={activeContent.title}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <div className="relative flex min-h-0 flex-1 flex-col">
                {activeTab.view === "ets" && (
                  <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs leading-5 text-warning-700 dark:text-warning-300">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      当前为 ArkTS 还原视图，结果仅供参考。该还原仍处于不稳定的测试阶段，
                      可能存在与原始源码不一致的语法、结构或语义偏差，请以反汇编（.abc）视图为准核对。
                    </span>
                  </div>
                )}
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
            )
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

        {/* AI 面板：始终挂载，收起时 width:0 + overflow-hidden（与左侧侧栏动画一致） */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden border-l border-default-200/80",
            !isAIResizing && "transition-[width] duration-200",
          )}
          style={{ width: isAIPanelOpen ? aiPanelWidth : 0 }}
        >
          {/* 拖宽分隔条 */}
          {isAIPanelOpen && (
            <div
              role="separator"
              aria-label="调整 AI 面板宽度"
              className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none"
              onPointerDown={startAIResize}
              onPointerMove={doAIResize}
              onPointerUp={endAIResize}
              onPointerCancel={endAIResize}
            />
          )}
          <div className="min-h-0 flex-1 overflow-hidden" style={{ width: aiPanelWidth }}>
            <AIChatContainer
              isPanelOpen={isAIPanelOpen}
              onClose={() => window.dispatchEvent(new Event("hark:toggle-ai-panel"))}
              onOpenSettings={onOpenAISettings}
              context={aiContext}
            />
          </div>
        </aside>
      </div>
      {/* 打开过程中又选择新文件时的确认对话框 */}
      <Modal
        isOpen={pendingOpenPath !== null}
        onClose={cancelReplaceOpen}
        size="sm"
      >
        <ModalContent>
          <ModalHeader>终止当前操作</ModalHeader>
          <ModalBody>
            <p className="text-sm text-default-600">
              确定要终止当前正在打开的项目，打开一个新的项目吗？
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={cancelReplaceOpen}>取消</Button>
            <Button color="primary" onPress={() => void confirmReplaceOpen()}>确定</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
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
