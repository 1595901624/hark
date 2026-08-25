import { useCallback, useEffect, useRef, useState } from "react"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { FileCode2, FolderOpen, LoaderCircle, Settings2 } from "lucide-react"
import TitleBar from "../TitleBar"
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, addToast } from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { api, type NodeContent, type TreeNode } from "../../lib/api"
import { ProjectTree } from "./ProjectTree"
import { EditorTabs, type EditorTab } from "./EditorTabs"
import { CodeView } from "./CodeView"

const FILE_FILTERS = [
  {
    name: "Ark 字节码 / 应用包",
    extensions: ["abc", "hap", "har", "app"],
  },
]

interface TabEntry {
  tab: EditorTab
  content?: NodeContent
  loading?: boolean
  error?: string
}

export function Workspace() {
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [projectName, setProjectName] = useState<string | null>(null)
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabEntry[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>("workspace-sidebar-width", 280)
  const [toolModalOpen, setToolModalOpen] = useState(false)
  const [toolPathDraft, setToolPathDraft] = useState("")
  const [toolPath, setToolPath, , toolPathLoaded] = usePersistentState<string>("disassembler-path", "")
  const toolPathRef = useRef("")
  toolPathRef.current = toolPathLoaded ? toolPath : ""

  // ---------- opening ----------
  const openFile = useCallback(async (path: string) => {
    setBusyMessage(`正在反编译 ${path.split(/[\\/]/).pop()} …`)
    try {
      const t = await api.openProject(path)
      setTree(t)
      setProjectName(t.name)
      setTabs([])
      setActiveKey(undefined)
      void api.setDisassemblerPath(toolPathRef.current.trim() || null)
    } catch (e) {
      addToast({ title: "打开失败", description: String(e), severity: "danger" })
    } finally {
      setBusyMessage(null)
    }
  }, [])

  const pickAndOpen = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      filters: FILE_FILTERS,
    })
    if (typeof selected === "string") await openFile(selected)
  }, [openFile])

  // ---------- events ----------
  useEffect(() => {
    const onOpenFile = () => void pickAndOpen()
    const onCloseProject = () => {
      setTree(null)
      setProjectName(null)
      setTabs([])
      setActiveKey(undefined)
      void api.closeProject()
    }
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

  // drag & drop
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

  // ---------- tabs ----------
  const openNode = useCallback((node: TreeNode) => {
    const key = `node-${node.id}`
    setTabs(prev => {
      if (prev.some(entry => entry.tab.key === key)) return prev
      const entry: TabEntry = {
        tab: { key, title: node.name, nodeId: node.id },
        loading: true,
      }
      const next = [...prev, entry]
      // keep at most 12 tabs
      return next.length > 12 ? next.slice(next.length - 12) : next
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

  const activeTab = tabs.find(entry => entry.tab.key === activeKey)

  // ---------- sidebar resize ----------
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }
  const doResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (document.body.style.cursor !== "col-resize") return
    const width = Math.min(520, Math.max(200, e.clientX))
    setSidebarWidth(width)
  }
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (document.body.style.cursor !== "col-resize") return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-chrome text-foreground">
      <TitleBar onToggleSidebar={() => undefined} />

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside
          className="relative flex shrink-0 flex-col border-r border-default-200/80 bg-chrome"
          style={{ width: sidebarWidth }}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-default-200/70 px-3">
            <span className="text-[12px] font-medium tracking-wide text-default-500">项目</span>
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
          <div className="min-h-0 flex-1 overflow-auto py-2 scrollbar-hide">
            {tree ? (
              <ProjectTree tree={tree} activeNodeId={activeTab?.tab.nodeId} onOpenNode={openNode} />
            ) : (
              <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-default-400">
                尚未打开项目
                <br />
                点击右上角图标或按 Ctrl+O
              </p>
            )}
          </div>
          <div
            role="separator"
            aria-label="调整宽度"
            className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none"
            onPointerDown={startResize}
            onPointerMove={doResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
        </aside>

        {/* editor area */}
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

      {/* disassembler settings */}
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
