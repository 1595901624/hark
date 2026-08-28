/**
 * Hark —— Ark 字节码（.abc / .hap / .har）反编译工作台。
 *
 * 应用入口组件：顶部为全局标题栏，下方在「反编译工作台」与
 * 「设置」页面之间切换。切换到设置页时工作台保持挂载（仅隐藏），
 * 以保留已打开的标签与项目现场。
 */
import { useCallback, useEffect, useState } from "react"
import TitleBar from "./components/TitleBar"
import { SettingsPage, type SettingsSectionId } from "./components/settings/SettingsPage"
import { Workspace } from "./components/workspace/Workspace"
import { usePersistentState } from "./hooks/usePersistentState"
import type { ToolId } from "./lib/navigation"

/** 应用根组件：全局标题栏 + 页面切换（工作台 / 设置）。 */
function App() {
  /** 当前页面：`workspace` 工作台 / `settings` 设置 */
  const [view, setView] = useState<"workspace" | "settings">("workspace")
  /** 设置页当前分区（受控，便于从菜单直达「反编译器」等分区） */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("appearance")
  /** 工作台项目树侧栏是否收起（持久化，标题栏按钮切换） */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = usePersistentState<boolean>(
    "workspace-sidebar-collapsed",
    false,
  )
  /** AI 面板是否展开（持久化） */
  const [isAIPanelOpen, setIsAIPanelOpen] = usePersistentState<boolean>("ai-panel-open", false)

  useEffect(() => {
    /** 标题栏「文件 → 设置」等入口 */
    const openSettings = () => setView("settings")
    /** 标题栏「文件 → 反编译器设置…」：直达设置页的反编译器分区 */
    const openToolSettings = () => {
      setSettingsSection("decompiler")
      setView("settings")
    }
    /** 标题栏或快捷键切换 AI 面板 */
    const toggleAIPanel = () => setIsAIPanelOpen(open => !open)
    /** 标题栏「文件 → AI 助手设置…」：直达设置页的 AI 分区 */
    const openAISettings = () => {
      setSettingsSection("ai")
      setView("settings")
    }
    window.addEventListener("hark:open-settings", openSettings)
    window.addEventListener("hark:configure-tool", openToolSettings)
    window.addEventListener("hark:toggle-ai-panel", toggleAIPanel)
    window.addEventListener("hark:configure-ai", openAISettings)
    return () => {
      window.removeEventListener("hark:open-settings", openSettings)
      window.removeEventListener("hark:configure-tool", openToolSettings)
      window.removeEventListener("hark:toggle-ai-panel", toggleAIPanel)
      window.removeEventListener("hark:configure-ai", openAISettings)
    }
  }, [setIsAIPanelOpen])

  /** 全局页面导航：设置页（可携带分区）、返回工作台。 */
  const handleNavigate = useCallback((toolId: ToolId, tabId?: string) => {
    if (toolId === "settings") {
      if (tabId) setSettingsSection(tabId as SettingsSectionId)
      setView("settings")
    } else if (toolId === "home") {
      setView("workspace")
    }
  }, [])

  const toggleSidebar = useCallback(
    () => setIsSidebarCollapsed(collapsed => !collapsed),
    [setIsSidebarCollapsed],
  )

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-chrome text-foreground">
      <TitleBar onNavigate={handleNavigate} onToggleSidebar={toggleSidebar} onToggleAIPanel={() => setIsAIPanelOpen(open => !open)} isAIPanelOpen={isAIPanelOpen} />

      {/* 工作台：切到设置页时隐藏但保持挂载，保留标签与项目现场 */}
      <div className={view === "workspace" ? "flex min-h-0 flex-1 overflow-hidden" : "hidden"}>
        <Workspace
          isSidebarCollapsed={isSidebarCollapsed}
          isAIPanelOpen={isAIPanelOpen}
          onOpenAISettings={() => {
            setSettingsSection("ai")
            setView("settings")
          }}
        />
      </div>

      {view === "settings" && (
        <SettingsPage
          activeSection={settingsSection}
          onSectionChange={setSettingsSection}
          onBack={() => setView("workspace")}
        />
      )}
    </div>
  )
}

export default App
