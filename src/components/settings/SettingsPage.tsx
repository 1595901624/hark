/**
 * 软件设置页面。
 *
 * 布局：顶部「返回 + 设置」标题条，下方为圆角卡片：
 * 左侧是分区导航（外观 / 反编译器 / 数据管理 / 关于），
 * 右侧滚动展示当前分区的设置项。
 *
 * 「反编译器」分区承载 `ark_disasm` 可执行文件路径配置，
 * 保存时同步给后端校验并持久化，供打开项目时使用。
 */
import { useCallback, useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Store } from "@tauri-apps/plugin-store"
import {
  ArrowLeft,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Info,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Bot,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ThemeToggle } from "../ThemeToggle"
import {
  addToast,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  Tooltip,
  useDisclosure,
} from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { cn } from "../../lib/utils"
import { api, type ViewKind } from "../../lib/api"
import { PROVIDER_PRESETS, saveAiConfig, loadAiConfig, DEFAULT_AI_CONFIG, type AiConfig } from "../../lib/ai-config"
import { createProvider } from "../../lib/ai-provider"
import { generateText } from "ai"
import appIcon from "../../assets/app-icon.svg"

/** 设置页分区 ID。 */
export type SettingsSectionId = "appearance" | "decompiler" | "data" | "ai" | "about"

/** 「反编译」分区下的子菜单 ID。 */
type DecompilerSubId = "tool" | "config"

/** 设置页分区描述。 */
interface SettingsSection {
  id: SettingsSectionId
  label: string
  icon: LucideIcon
  title: string
  description?: string
}

/** 左侧导航分区（顺序即展示顺序）。 */
const SECTIONS: SettingsSection[] = [
  { id: "appearance", label: "外观", icon: Palette, title: "外观", description: "自定义 Hark 的界面显示效果。" },
  { id: "decompiler", label: "反编译", icon: FileCode2, title: "反编译", description: "配置反编译工具与文件打开方式。" },
  { id: "ai", label: "AI 助手", icon: Bot, title: "AI 助手", description: "配置 AI 模型提供商与 API 密钥。" },
  { id: "data", label: "数据管理", icon: Database, title: "数据管理", description: "管理应用的本地数据与缓存。" },
  { id: "about", label: "关于", icon: Info, title: "关于" },
]

/** 「反编译」分区的子菜单描述。 */
const DECOMPILER_SUBS: { id: DecompilerSubId; label: string; icon: LucideIcon; title: string; description: string }[] = [
  { id: "tool", label: "反编译器", icon: FileCode2, title: "反编译器", description: "配置用于反编译 Ark 字节码的外部工具。" },
  { id: "config", label: "配置", icon: SlidersHorizontal, title: "配置", description: "配置文件打开方式与默认视图。" },
]

interface SettingsPageProps {
  /** 当前激活的分区（受控，由 App 持有以便从菜单直达指定分区）。 */
  activeSection: SettingsSectionId
  /** 切换分区。 */
  onSectionChange: (id: SettingsSectionId) => void
  /** 返回工作台。 */
  onBack: () => void
}

/** 渲染软件设置页面。 */
export function SettingsPage({ activeSection, onSectionChange, onBack }: SettingsPageProps) {
  const [version, setVersion] = useState("0.1.0")
  /** 「反编译」分区当前激活的子菜单（仅在反编译分区显示子菜单）。 */
  const [decompilerSub, setDecompilerSub] = useState<DecompilerSubId>("tool")

  useEffect(() => {
    getVersion()
      .then(value => setVersion(value.replace(/^v/i, "")))
      .catch(() => setVersion("0.1.0"))
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* 页面标题条：返回 + 标题 */}
      <header className="flex h-[38px] shrink-0 items-center gap-1 border-b border-default-200/80 bg-chrome px-2.5">
        <Tooltip content="返回">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="返回"
            onPress={onBack}
            className="h-7 w-7 min-w-7 rounded-md text-default-500 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.07]"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Tooltip>
        <span className="text-[12.5px] font-medium text-default-500">设置</span>
      </header>

      {/* 设置卡片：左分区导航 + 右设置项 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto h-full w-full max-w-5xl px-6 py-5">
          <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-default-200">
            <nav
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-default-200 bg-default-50/45 p-2 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r md:p-3"
              aria-label="设置分区"
            >
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <div key={id} className="flex shrink-0 flex-col gap-1 md:w-full">
                  <Button
                    size="sm"
                    color={activeSection === id ? "primary" : "default"}
                    variant={activeSection === id ? "flat" : "light"}
                    className="h-9 shrink-0 justify-start px-3 md:w-full"
                    onPress={() => onSectionChange(id)}
                    startContent={<Icon className="h-4 w-4" />}
                  >
                    {label}
                  </Button>
                  {/* 反编译分区的子菜单 */}
                  {id === "decompiler" && (
                    <div className="flex shrink-0 gap-1 pl-3 md:flex-col md:pl-5">
                      {DECOMPILER_SUBS.map(({ id: subId, label: subLabel, icon: SubIcon }) => (
                        <Button
                          key={subId}
                          size="sm"
                          color={decompilerSub === subId ? "primary" : "default"}
                          variant={decompilerSub === subId ? "flat" : "light"}
                          className="h-8 shrink-0 justify-start px-3 text-[12px] md:w-full"
                          onPress={() => setDecompilerSub(subId)}
                          startContent={<SubIcon className="h-3.5 w-3.5" />}
                        >
                          {subLabel}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "decompiler" && decompilerSub === "tool" && <DecompilerToolSection />}
              {activeSection === "decompiler" && decompilerSub === "config" && <DecompilerConfigSection />}
              {activeSection === "ai" && <AISection />}
              {activeSection === "data" && <DataSection />}
              {activeSection === "about" && <AboutSection version={version} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 分区标题（大标题 + 可选描述，底部细分隔线）。 */
function SectionHeader({ id, title, description }: { id: string; title: string; description?: string }) {
  return (
    <div className="border-b border-default-200 px-5 py-4">
      <h2 id={id} className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 text-xs text-default-400">{description}</p>}
    </div>
  )
}

/** 外观分区：主题切换。 */
function AppearanceSection() {
  return (
    <section aria-labelledby="appearance-settings-heading">
      <SectionHeader id="appearance-settings-heading" title="外观" description="自定义 Hark 的界面显示效果。" />
      <div className="divide-y divide-default-200 px-5">
        <div className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <Palette className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div>
              <div className="text-sm font-medium text-foreground">主题</div>
              <div className="mt-1 text-xs text-default-400">在浅色、深色与跟随系统之间切换。</div>
            </div>
          </div>
          <ThemeToggle showLabel variant="bordered" className="h-8 min-w-28 justify-start" />
        </div>
      </div>
    </section>
  )
}

/** 反编译器子页：`ark_disasm` 可执行文件路径配置与版本信息。 */
function DecompilerToolSection() {
  /** 已保存的 `ark_disasm` 路径（持久化，与工作台打开项目时读取的键一致）。 */
  const [toolPath, setToolPath, , toolPathLoaded] = usePersistentState<string>("disassembler-path", "")
  /** 输入框中的路径草稿（加载完成后与已保存值同步）。 */
  const [draft, setDraft] = useState("")
  /** 是否正在保存（等待后端校验）。 */
  const [isSaving, setIsSaving] = useState(false)
  /** 当前展示的版本信息文本（`--version` 输出）。 */
  const [versionInfo, setVersionInfo] = useState<string | null>(null)
  /** 版本信息获取失败的错误信息。 */
  const [versionError, setVersionError] = useState<string | null>(null)
  /** 是否正在获取版本信息。 */
  const [isLoadingVersion, setIsLoadingVersion] = useState(false)

  useEffect(() => {
    if (toolPathLoaded) setDraft(toolPath)
  }, [toolPath, toolPathLoaded])

  const isDirty = toolPathLoaded && draft.trim() !== toolPath.trim()

  /**
   * 拉取指定路径（空串表示自动探测）的 `ark_disasm` 版本信息。
   * 失败时不打断页面，仅在版本区域展示错误。
   * @param path 候选可执行文件路径；空串表示按探测顺序定位
   */
  const refreshVersion = useCallback(async (path: string) => {
    setIsLoadingVersion(true)
    try {
      const text = await api.disassemblerVersion(path.trim() || null)
      setVersionInfo(text)
      setVersionError(null)
    } catch (e) {
      setVersionInfo(null)
      setVersionError(String(e))
    } finally {
      setIsLoadingVersion(false)
    }
  }, [])

  // 已保存路径变化（初次加载 / 保存 / 重置）时同步刷新版本信息
  useEffect(() => {
    if (toolPathLoaded) void refreshVersion(toolPath)
  }, [toolPath, toolPathLoaded, refreshVersion])

  /** 弹出原生文件选择框，选择 `ark_disasm` 可执行文件。 */
  const browse = async () => {
    const selected = await openFileDialog({ multiple: false, directory: false })
    if (typeof selected === "string") setDraft(selected)
  }

  /** 校验并保存路径；留空表示清除配置、回退自动探测。后端执行
   * `--version` 校验失败时会返回错误，此时保持原配置不变。 */
  const save = async () => {
    const value = draft.trim()
    setIsSaving(true)
    try {
      await api.setDisassemblerPath(value || null)
    } catch (e) {
      addToast({ title: "ark_disasm 不可用，已保留原配置", description: String(e), severity: "danger" })
      setIsSaving(false)
      return
    }
    setIsSaving(false)
    setToolPath(value)
    addToast({
      title: "设置已保存",
      description: value || "未配置时将优先使用应用内置的 ark_disasm",
      severity: "success",
    })
  }

  /** 清除手动配置，回退到应用内置的 ark_disasm（同样经过后端校验）。 */
  const reset = async () => {
    setIsSaving(true)
    try {
      await api.setDisassemblerPath(null)
    } catch (e) {
      addToast({ title: "重置失败，已保留原配置", description: String(e), severity: "danger" })
      setIsSaving(false)
      return
    }
    setIsSaving(false)
    setDraft("")
    setToolPath("")
    addToast({ title: "已重置", description: "将使用应用内置的 ark_disasm", severity: "success" })
  }

  return (
    <section aria-labelledby="decompiler-tool-heading">
      <SectionHeader
        id="decompiler-tool-heading"
        title="反编译器"
        description="配置用于反编译 Ark 字节码的外部工具。"
      />
      <div className="divide-y divide-default-200 px-5">
        <div className="py-4">
          <div className="flex items-start gap-3">
            <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">ark_disasm 路径</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-default-400">
                Hark 调用 OpenHarmony 官方 <code className="rounded bg-default-100 px-1">ark_disasm</code>{" "}
                工具反编译字节码。应用已内置各平台的 ark_disasm，通常无需配置；如需指定其他版本，
                可填写其可执行文件的完整路径（随 DevEco Studio 安装）：
              </p>
              <div className="mt-1.5 max-w-xl space-y-1 text-xs leading-5 text-default-400">
                <div>
                  <span className="inline-block w-16 shrink-0">Windows</span>
                  <code className="rounded bg-default-100 px-1">
                    DevEco Studio\sdk\default\openharmony\toolchains\ark_disasm.exe
                  </code>
                </div>
                <div>
                  <span className="inline-block w-16 shrink-0">macOS</span>
                  <code className="rounded bg-default-100 px-1">
                    /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/ark_disasm
                  </code>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 pl-7">
            <Input
              className="flex-1"
              placeholder="C:\\tools\\ark_disasm.exe"
              value={draft}
              onValueChange={setDraft}
              isDisabled={!toolPathLoaded}
            />
            <Button
              variant="bordered"
              startContent={<FolderOpen className="h-3.5 w-3.5" />}
              onPress={() => void browse()}
            >
              浏览…
            </Button>
            <Button color="primary" isDisabled={!isDirty} isLoading={isSaving} onPress={() => void save()}>
              保存
            </Button>
            <Button
              variant="light"
              isDisabled={!toolPathLoaded || (!toolPath && !draft)}
              isLoading={isSaving}
              onPress={() => void reset()}
            >
              重置
            </Button>
          </div>
          <div className="mt-4 pl-7">
            <div className="text-xs font-medium text-default-500">版本信息</div>
            <div className="mt-1.5 max-w-xl">
              {isLoadingVersion ? (
                <p className="text-xs leading-5 text-default-400">正在获取版本信息…</p>
              ) : versionInfo ? (
                <pre className="overflow-x-auto rounded-lg bg-default-50 px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-default-600 dark:bg-white/5 dark:text-default-400">
                  {versionInfo}
                </pre>
              ) : (
                <p className="text-xs leading-5 text-danger">{versionError ?? "尚未获取版本信息"}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** 配置子页：默认文件打开模式。 */
function DecompilerConfigSection() {
  /** 默认文件打开模式（持久化，与工作台打开节点时读取的键一致）。 */
  const [defaultOpenView, setDefaultOpenView] = usePersistentState<ViewKind>("default-open-view", "ets")
  /** 点击方法时是否在新页面打开（持久化，与工作台读取的键一致）。 */
  const [openMethodInNewTab, setOpenMethodInNewTab] = usePersistentState<boolean>("open-method-in-new-tab", false)

  return (
    <section aria-labelledby="decompiler-config-heading">
      <SectionHeader
        id="decompiler-config-heading"
        title="配置"
        description="配置文件打开方式与默认视图。"
      />
      <div className="divide-y divide-default-200 px-5">
        <div className="py-4">
          <div className="flex items-start gap-3">
            <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">默认文件打开模式</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-default-400">
                选择点击文件时默认打开的视图。选中 .ets 时，每次点开文件将直接以 ArkTS 还原视图打开。
              </p>
              <div className="mt-3">
                <RadioGroup
                  value={defaultOpenView}
                  onValueChange={(v) => setDefaultOpenView(v as ViewKind)}
                  className="gap-2"
                >
                  <Radio value="ets">.ets（ArkTS 还原）</Radio>
                  <Radio value="abc">.abc（反汇编文本）</Radio>
                </RadioGroup>
              </div>
            </div>
          </div>
        </div>
        <div className="py-4">
          <div className="flex items-start gap-3">
            <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">方法打开方式</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-default-400">
                勾选后点击左侧项目树中的方法将单独打开新标签页；不勾选时点击方法会跳转到所属类并定位到方法声明处（类似 IDE 的 Structure 功能）。
              </p>
              <div className="mt-3">
                <Checkbox
                  isSelected={openMethodInNewTab}
                  onValueChange={setOpenMethodInNewTab}
                >
                  点击方法时，在新页面打开
                </Checkbox>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** AI 助手分区：Provider / Base URL / API Key / Model / Temperature + 测试连接。 */
function AISection() {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void loadAiConfig().then(cfg => {
      setConfig(cfg ?? { ...DEFAULT_AI_CONFIG })
      setLoaded(true)
    })
  }, [])

  const update = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => {
    setConfig(prev => (prev ? { ...prev, [key]: value } : prev))
    setTestResult(null)
  }

  const handleProviderChange = (providerId: string) => {
    const preset = PROVIDER_PRESETS.find(p => p.id === providerId)
    if (preset && config) {
      setConfig({
        ...config,
        provider: providerId,
        baseURL: preset.baseURL || config.baseURL,
        model: preset.defaultModel || config.model,
      })
      setTestResult(null)
    }
  }

  const handleSave = async () => {
    if (!config) return
    await saveAiConfig(config)
    window.dispatchEvent(new Event("hark:ai-config-saved"))
    addToast({ title: "AI 配置已保存", severity: "success" })
  }

  const handleTest = async () => {
    if (!config || !config.baseURL.trim() || !config.model.trim()) {
      setTestResult({ ok: false, message: "请先填写 Base URL 和模型名称" })
      return
    }
    setIsTesting(true)
    setTestResult(null)
    try {
      const provider = createProvider(config)
      const result = await generateText({
        model: provider.chat(config.model),
        prompt: "请回复「连接成功」四个字。",
      })
      setTestResult({ ok: true, message: `连接成功：${result.text.slice(0, 50)}` })
    } catch (e) {
      setTestResult({ ok: false, message: String(e) })
    } finally {
      setIsTesting(false)
    }
  }

  if (!loaded || !config) {
    return (
      <section>
        <SectionHeader id="ai-settings-heading" title="AI 助手" description="配置 AI 模型提供商与 API 密钥。" />
        <div className="p-5 text-sm text-default-400">正在加载配置…</div>
      </section>
    )
  }

  return (
    <section aria-labelledby="ai-settings-heading">
      <SectionHeader id="ai-settings-heading" title="AI 助手" description="配置 AI 模型提供商与 API 密钥。" />
      <div className="divide-y divide-default-200 px-5">
        {/* Provider 选择 */}
        <div className="py-4">
          <div className="flex items-start gap-3">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">模型提供商</div>
              <p className="mt-1 text-xs leading-5 text-default-400">选择 AI 模型提供商，选择后自动填入地址与默认模型。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {PROVIDER_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleProviderChange(preset.id)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      config.provider === preset.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-default-200 text-default-500 hover:bg-default-100",
                    )}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Base URL */}
        <div className="py-4">
          <div className="flex items-start gap-3">
            <Code2 className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">Base URL</div>
              <p className="mt-1 text-xs leading-5 text-default-400">API 基础地址，通常以 /v1 结尾。</p>
              <Input
                className="mt-2"
                value={config.baseURL}
                onValueChange={v => update("baseURL", v)}
                placeholder="https://api.deepseek.com/v1"
              />
            </div>
          </div>
        </div>

        {/* API Key */}
        <div className="py-4">
          <div className="flex items-start gap-3">
            <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">API Key</div>
              <p className="mt-1 text-xs leading-5 text-default-400">API 密钥，本地存储不上传。Ollama 本地部署可留空。</p>
              <Input
                className="mt-2"
                type="password"
                value={config.apiKey}
                onValueChange={v => update("apiKey", v)}
                placeholder="sk-…"
              />
            </div>
          </div>
        </div>

        {/* Model */}
        <div className="py-4">
          <div className="flex items-start gap-3">
            <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">模型名称</div>
              <p className="mt-1 text-xs leading-5 text-default-400">如 deepseek-chat、gpt-4o、qwen-plus 等。</p>
              <Input
                className="mt-2"
                value={config.model}
                onValueChange={v => update("model", v)}
                placeholder="deepseek-chat"
              />
            </div>
          </div>
        </div>

        {/* Temperature */}
        <div className="py-4">
          <div className="flex items-start gap-3">
            <Palette className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">采样温度</div>
              <p className="mt-1 text-xs leading-5 text-default-400">值越大回复越发散，值越小越确定。范围 0~2。</p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={config.temperature}
                  onChange={e => update("temperature", parseFloat(e.target.value))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-default-200 accent-primary"
                />
                <span className="w-10 text-right text-sm tabular-nums text-default-500">{config.temperature.toFixed(1)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 py-4">
          <Button color="primary" onPress={() => void handleSave()}>保存配置</Button>
          <Button variant="bordered" isLoading={isTesting} onPress={() => void handleTest()}>测试连接</Button>
          {testResult && (
            <span className={cn("text-xs", testResult.ok ? "text-success" : "text-danger")}>
              {testResult.message}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

/** 数据管理分区：清除本地数据与缓存。 */
function DataSection() {
  const cacheModal = useDisclosure()

  /** 清空 localStorage 与 Tauri store 后重启应用。 */
  const handleClearCache = async () => {
    try {
      localStorage.clear()
      const store = await Store.load("store.bin")
      await store.clear()
      await store.save()
      window.location.reload()
    } catch (e) {
      console.error("Failed to clear cache:", e)
      addToast({ title: "清除缓存失败", description: String(e), severity: "danger" })
    }
  }

  return (
    <section aria-labelledby="data-settings-heading">
      <SectionHeader id="data-settings-heading" title="数据管理" description="管理应用的本地数据与缓存。" />
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-6 rounded-xl border border-warning/35 bg-warning/5 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <div className="text-sm font-medium text-foreground">清除缓存</div>
              <p className="mt-1.5 max-w-xl text-xs leading-5 text-default-400">
                删除全部本地数据（包括偏好设置与反编译器配置），并重启应用。该操作不可撤销。
              </p>
            </div>
          </div>
          <Button
            size="sm"
            color="warning"
            variant="flat"
            className="shrink-0"
            startContent={<RefreshCw className="h-4 w-4" />}
            onPress={cacheModal.onOpen}
          >
            清除缓存
          </Button>
        </div>
      </div>

      <Modal isOpen={cacheModal.isOpen} onClose={cacheModal.onClose}>
        <ModalContent>
          {onClose => (
            <>
              <ModalHeader>清除缓存</ModalHeader>
              <ModalBody>
                <p className="text-sm leading-6 text-default-500">
                  确定要清除全部本地数据吗？应用将自动重启，该操作不可撤销。
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>
                  取消
                </Button>
                <Button color="warning" onPress={() => void handleClearCache()}>
                  清除
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </section>
  )
}

/** 关于分区：应用图标、版本与源代码链接。 */
function AboutSection({ version }: { version: string }) {
  return (
    <section aria-labelledby="about-settings-heading">
      <SectionHeader id="about-settings-heading" title="关于" />
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src={appIcon} alt="Hark 图标" className="h-12 w-12 rounded-xl border border-default-200 shadow-sm" />
            <div>
              <div className="text-sm font-medium text-foreground">Hark v{version}</div>
              <div className="mt-0.5 text-xs text-default-400">© Cloris 2026</div>
            </div>
          </div>
          <Button
            size="sm"
            variant="bordered"
            startContent={<Code2 className="h-4 w-4" />}
            endContent={<ExternalLink className="h-3.5 w-3.5 text-default-400" />}
            onPress={() => void openUrl("https://github.com/1595901624/hi-abc")}
          >
            GitHub
          </Button>
        </div>
        <p className="mt-5 max-w-xl text-xs leading-5 text-default-400">
          Hark 是一个 Ark 字节码（.abc / .hap / .har）反编译工作台，基于 Tauri2 框架构建。
        </p>
      </div>
    </section>
  )
}
