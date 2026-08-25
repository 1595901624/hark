import { useRef, useState } from "react"
import { Layout } from "./components/Layout"
import { ToolId, navGroups, findGroup, findChild } from "./lib/navigation"
import { Card, CardBody } from "./components/ui/base-ui"
import { ArrowRightLeft } from "lucide-react"

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("home")
  const [activeTab, setActiveTab] = useState<string | undefined>()
  const settingsReturnLocation = useRef<{ toolId: ToolId; tabId?: string } | null>(null)

  const resolveTab = (toolId: ToolId, tabId?: string) => {
    if (tabId) return tabId
    return findGroup(toolId)?.children[0]?.tabId
  }

  const handleToolChange = (id: ToolId) => {
    if (id === "settings" && activeTool !== "settings") {
      settingsReturnLocation.current = { toolId: activeTool, tabId: activeTab }
    }
    setActiveTool(id)
    setActiveTab(resolveTab(id))
  }

  const handleNavigate = (toolId: ToolId, tabId?: string) => {
    if (toolId === "settings" && activeTool !== "settings") {
      settingsReturnLocation.current = { toolId: activeTool, tabId: activeTab }
    }
    setActiveTool(toolId)
    setActiveTab(resolveTab(toolId, tabId))
  }

  const handleSettingsBack = () => {
    const previous = settingsReturnLocation.current ?? { toolId: "home" as ToolId, tabId: undefined }
    settingsReturnLocation.current = null
    setActiveTool(previous.toolId)
    setActiveTab(previous.tabId)
  }

  const getTitle = () => {
    const child = findChild(activeTool, activeTab)
    if (child) return child.label
    switch (activeTool) {
      case "home": return "首页"
      case "settings": return "设置"
      default: return findGroup(activeTool)?.label ?? "abcde"
    }
  }

  const renderActiveTool = () => {
    switch (activeTool) {
      case "home":
        return <HomePage onNavigate={handleNavigate} />
      case "settings":
        return <SettingsPage />
      default:
        return <ToolPlaceholder toolId={activeTool} tabId={activeTab} />
    }
  }

  return (
    <Layout
      activeTool={activeTool}
      activeTab={activeTab}
      onToolChange={handleToolChange}
      onNavigate={handleNavigate}
      title={getTitle()}
      onBack={activeTool === "settings" ? handleSettingsBack : undefined}
    >
      {renderActiveTool()}
    </Layout>
  )
}

function HomePage({ onNavigate }: { onNavigate: (toolId: ToolId, tabId?: string) => void }) {
  const tools = navGroups.map(group => ({
    id: group.id,
    title: group.label,
    icon: <group.icon className="w-6 h-6" />,
    gradient: group.gradient,
    iconColor: group.iconColor,
    firstTab: group.children[0]?.tabId,
  }))

  return (
    <div className="animate-in space-y-10 py-5 fade-in duration-300">
      <div className="max-w-2xl space-y-2">
        <h2 className="text-[30px] font-semibold tracking-[-0.035em]">欢迎使用 abcde</h2>
        <p className="text-[15px] leading-relaxed text-default-500">基于 TroveKit 框架复刻的桌面应用，左侧侧边栏与顶部菜单提供完整导航。</p>
      </div>

      <div className="home-tool-grid grid grid-cols-1 gap-3">
        {tools.map((item) => (
          <Card
            key={item.id}
            isPressable
            onPress={() => onNavigate(item.id as ToolId, item.firstTab)}
            className="group border border-default-200/80 bg-default-50/60 transition-colors duration-150 hover:bg-default-100/80"
            shadow="none"
          >
            <CardBody className="space-y-4 p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-default-200 bg-background text-default-600 shadow-sm">
                {item.icon}
              </div>
              <div className="space-y-2">
                <h3 className="text-[15px] font-semibold tracking-tight">{item.title}</h3>
                <p className="line-clamp-2 text-[13px] leading-relaxed text-default-500">点击进入该工具分类。</p>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <div className="space-y-4 border-t border-default-200/70 pt-7">
        <h3 className="text-[17px] font-semibold tracking-tight">常用功能</h3>
        <div className="home-favorite-grid grid grid-cols-2 gap-3">
          {navGroups.slice(0, 4).map(group => (
            <Card
              key={`fav-${group.id}`}
              isPressable
              onPress={() => onNavigate(group.id, group.children[0]?.tabId)}
              className="group border border-default-200/80 bg-default-50/60 transition-colors hover:bg-default-100/80"
              shadow="none"
            >
              <CardBody className="flex flex-row items-center gap-3 p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-default-200 bg-background text-default-500">
                  <ArrowRightLeft className="w-4 h-4" />
                </div>
                <div className="flex-1 text-left">
                  <div className="text-sm font-medium group-hover:text-primary transition-colors truncate">{group.children[0]?.label}</div>
                  <div className="text-xs text-default-400 truncate">{group.label}</div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

function SettingsPage() {
  return (
    <div className="animate-in space-y-6 py-5 fade-in duration-300">
      <div className="space-y-2">
        <h2 className="text-[22px] font-semibold tracking-tight">设置</h2>
        <p className="text-sm text-default-500">应用偏好设置占位页面。</p>
      </div>
      <Card className="border border-default-200/80" shadow="none">
        <CardBody className="space-y-3 p-5 text-sm text-default-500">
          <p>此处可放置主题、语言、侧边栏等偏好设置。</p>
          <p>顶部菜单「视图 → 主题」可切换浅色 / 深色 / 跟随系统。</p>
        </CardBody>
      </Card>
    </div>
  )
}

function ToolPlaceholder({ toolId, tabId }: { toolId: ToolId; tabId?: string }) {
  const group = findGroup(toolId)
  const child = findChild(toolId, tabId)
  return (
    <div className="animate-in space-y-6 py-5 fade-in duration-300">
      <div className="space-y-2">
        <h2 className="text-[22px] font-semibold tracking-tight">{child?.label ?? group?.label}</h2>
        <p className="text-sm text-default-500">{group?.label} · 工具页面占位内容。</p>
      </div>
      <Card className="border border-dashed border-default-200" shadow="none">
        <CardBody className="flex min-h-[300px] items-center justify-center p-10 text-center text-sm text-default-400">
          <div className="space-y-2">
            <p>这是「{child?.label ?? group?.label}」的占位区域。</p>
            <p>替换为此工具的实际功能实现即可。</p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

export default App
