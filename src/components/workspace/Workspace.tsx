/**
 * 反编译工作台主组件（jadx-gui 风格布局）。
 *
 * 布局：顶部标题栏 + 左侧可拖宽的项目树面板 + 右侧多标签代码区。
 *
 * 职责：
 * - 通过原生对话框 / Ctrl+O / 拖拽打开 `.abc` / `.hap` / `.har` 文件；
 * - 监听标题栏菜单派发的全局事件（打开文件 / 关闭项目 / 反编译器设置）；
 * - 管理编辑器标签（最多 12 个）并懒加载节点内容；
 * - 持久化侧栏宽度与 `ark_disasm` 路径配置。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { FileCode2, FolderOpen, LoaderCircle, Settings2 } from "lucide-react"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import TitleBar from "../TitleBar"
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, addToast } from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { cn } from "../../lib/utils"
import { api, type NodeContent, type TreeNode } from "../../lib/api"
import { ProjectTree, type TreeCommand } from "./ProjectTree"
import { EditorTabs, type EditorTab } from "./EditorTabs"
import { CodeView } from "./CodeView"

/** 原生打开对话框的文件类型过滤器。 */
const FILE_FILTERS = [
  {
    name: "Ark 字节码 / 应用包",
    extensions: ["abc", "hap", "har", "app"],
  },
]

/** 单个标签的完整状态：标签信息 + 异步加载的内容 / 错误。 */
interface TabEntry {
  /** 标签基础信息。 */
  tab: EditorTab
  /** 已加载的内容切片；加载中 / 失败时为空。 */
  content?: NodeContent
  /** 内容是否正在加载。 */
  loading?: boolean
  /** 加载失败时的错误信息。 */
  error?: string
}

/** 同一时刻允许打开的最大标签数，超出时淘汰最早的标签。 */
const MAX_TABS = 12

/**
 * 渲染整个工作台界面。
 *
 * 无项目时显示拖入提示与「打开文件 / 反编译器设置」入口；
 * 有项目时左侧渲染项目树，右侧按标签状态（加载中 / 出错 / 有内容）
 * 渲染对应视图。
 */
export function Workspace() {
  /** 项目树根节点；`null` 表示未打开项目 */
  const [tree, setTree] = useState<TreeNode | null>(null)
  /** 当前项目名（打开文件的文件名） */
  const [projectName, setProjectName] = useState<string | null>(null)
  /** 全局忙碌提示（如「正在反编译 …」）；`null` 表示空闲 */
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  /** 已打开的标签列表 */
  const [tabs, setTabs] = useState<TabEntry[]>([])
  /** 激活标签的 key */
  const [activeKey, setActiveKey] = useState<string | undefined>()
  /** 侧栏宽度（持久化） */
  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>("workspace-sidebar-width", 280)
  /** 侧栏是否收起（持久化，由标题栏左上角按钮切换） */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = usePersistentState<boolean>(
    "workspace-sidebar-collapsed",
    false,
  )
  /** 是否正在拖拽调整侧栏宽度（拖拽期间禁用宽度过渡动画） */
  const [isResizing, setIsResizing] = useState(false)
  /** 切换侧栏收起/展开状态 */
  const toggleSidebar = () => setIsSidebarCollapsed(collapsed => !collapsed)
  /** 反编译器设置弹窗是否打开 */
  const [toolModalOpen, setToolModalOpen] = useState(false)
  /** 弹窗中的路径输入草稿 */
  const [toolPathDraft, setToolPathDraft] = useState("")
  /** 已保存的 `ark_disasm` 路径（持久化） */
  const [toolPath, setToolPath, , toolPathLoaded] = usePersistentState<string>("disassembler-path", "")
  /** 已加载完成后的工具路径快照，供回调读取最新值 */
  const toolPathRef = useRef("")
  toolPathRef.current = toolPathLoaded ? toolPath : ""
  /** 下发给项目树的展开/折叠指令（携带递增 seq 保证重复指令生效） */
  const [treeCommand, setTreeCommand] = useState<TreeCommand | null>(null)
  const treeCommandSeq = useRef(0)

  /** 全部展开项目树。 */
  const expandAll = () =>
    setTreeCommand({ type: "expand-all", seq: ++treeCommandSeq.current })
  /** 全部折叠项目树（仅保留根节点展开）。 */
  const collapseAll = () =>
    setTreeCommand({ type: "collapse-all", seq: ++treeCommandSeq.current })

  // ---------- 打开文件 ----------

  /**
   * 打开指定路径的文件：调用后端反编译并重建项目树。
   * 成功后清空所有标签；失败时以 toast 展示错误。
   * @param path 文件绝对路径
   */
  const openFile = useCallback(async (path: string) => {
    setBusyMessage(`正在反编译 ${path.split(/[\\/]/).pop()} …`)
    try {
      const t = await api.openProject(path)
      setTree(t)
      setProjectName(t.name)
      setTabs([])
      setActiveKey(undefined)
      // 同步一次工具路径，便于后端立即校验/缓存
      void api.setDisassemblerPath(toolPathRef.current.trim() || null)
    } catch (e) {
      addToast({ title: "打开失败", description: String(e), severity: "danger" })
    } finally {
      setBusyMessage(null)
    }
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
      void api.closeProject()
    }
    /** 标题栏「文件 → 反编译器设置…」 */
    const onConfigureTool = () => {
      setToolPathDraft(toolPathRef.current)
      setToolModalOpen(true)
    }
    window.addEventListener("abcde:open-file", onOpenFile)
    window.addEventListener("abcde:close-project", onCloseProject)
    window.addEventListener("abcde:configure-tool", onConfigureTool)
    return () => {
      window.removeEventListener("abcde:open-file", onOpenFile)
      window.removeEventListener("abcde:close-project", onCloseProject)
      window.removeEventListener("abcde:configure-tool", onConfigureTool)
    }
  }, [pickAndOpen])

  // Ctrl+O / Cmd+O 快捷键打开文件
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault()
        void pickAndOpen()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [pickAndOpen])

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

  // ---------- 标签管理 ----------

  /**
   * 打开一个节点对应的标签（已存在时仅激活），并异步加载其内容。
   * @param node 被点击的项目树节点
   */
  const openNode = useCallback((node: TreeNode) => {
    const key = `node-${node.id}`
    setTabs(prev => {
      if (prev.some(entry => entry.tab.key === key)) return prev
      const entry: TabEntry = {
        tab: { key, title: node.name, nodeId: node.id },
        loading: true,
      }
      const next = [...prev, entry]
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
    })
    setActiveKey(key)

    void api.getContent(node.id).then(
      content =>
        setTabs(prev =>
          prev.map(entry =>
            entry.tab.key === key ? { ...entry, content, loading: false } : entry,
          ),
        ),
      err =>
        setTabs(prev =>
          prev.map(entry =>
            entry.tab.key === key
              ? { ...entry, loading: false, error: String(err) }
              : entry,
          ),
        ),
    )
  }, [])

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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-chrome text-foreground">
      <TitleBar onToggleSidebar={toggleSidebar} />

      <div className="flex min-h-0 flex-1">
        {/* 左侧项目树面板 */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden border-r border-default-200/80 bg-chrome",
            !isResizing && "transition-[width] duration-200",
          )}
          style={{ width: isSidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-default-200/70 px-3">
            <span className="text-[12px] font-medium tracking-wide text-default-500">项目</span>
            <div className="flex items-center gap-0.5">
              {tree && (
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
          <div className="min-h-0 flex-1 overflow-auto py-2 scrollbar-thin">
            {tree ? (
              <ProjectTree
                tree={tree}
                activeNodeId={activeTab?.tab.nodeId}
                onOpenNode={openNode}
                command={treeCommand}
              />
            ) : (
              <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-default-400">
                尚未打开项目
                <br />
                点击右上角图标或按 Ctrl+O
              </p>
            )}
          </div>
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
              {projectName ?? "abcde"}
            </div>
          )}

          {busyMessage ? (
            <EmptyState
              icon={<LoaderCircle className="h-10 w-10 animate-spin text-primary/70" />}
              text={busyMessage}
            />
          ) : activeTab?.loading ? (
            <EmptyState
              icon={<LoaderCircle className="h-8 w-8 animate-spin text-primary/70" />}
              text="正在加载内容…"
            />
          ) : activeTab?.error ? (
            <EmptyState
              icon={<FileCode2 className="h-10 w-10 text-default-300" />}
              text={activeTab.error}
            />
          ) : activeTab?.content ? (
            <>
              <div className="shrink-0 border-b border-default-200/50 px-4 py-1.5 text-[11px] text-default-400">
                {activeTab.content.title}
              </div>
              <CodeView content={activeTab.content.body} language={activeTab.content.language} />
            </>
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
                  <div className="flex gap-2">
                    <Button color="primary" variant="solid" size="sm" onPress={() => void pickAndOpen()}>
                      打开文件…
                    </Button>
                    <Button
                      variant="bordered"
                      size="sm"
                      startContent={<Settings2 className="h-3.5 w-3.5" />}
                      onPress={() => {
                        setToolPathDraft(toolPathRef.current)
                        setToolModalOpen(true)
                      }}
                    >
                      反编译器设置
                    </Button>
                  </div>
                )
              }
            />
          )}
        </main>
      </div>

      {/* 反编译器设置弹窗 */}
      <Modal isOpen={toolModalOpen} onClose={() => setToolModalOpen(false)}>
        <ModalContent className="max-w-[480px]">
          <ModalHeader>反编译器设置</ModalHeader>
          <ModalBody className="space-y-3 text-sm">
            <p className="leading-relaxed text-default-500">
              abcde 调用 OpenHarmony 官方 <code className="rounded bg-default-100 px-1">ark_disasm</code>{" "}
              工具反编译字节码。请填写其可执行文件的完整路径；留空则自动在应用目录与 PATH 中查找。
            </p>
            <Input
              placeholder="C:\\tools\\ark_disasm.exe"
              value={toolPathDraft}
              onValueChange={setToolPathDraft}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setToolModalOpen(false)}>
              取消
            </Button>
            <Button
              color="primary"
              onPress={async () => {
                const value = toolPathDraft.trim() || ""
                try {
                  await api.setDisassemblerPath(value || null)
                } catch (e) {
                  addToast({ title: "ark_disasm 不可用", description: String(e), severity: "danger" })
                  return
                }
                setToolPath(value)
                setToolModalOpen(false)
              }}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
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
