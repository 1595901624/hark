/**
 * 软件设置页面（参考 TroveKit 的设置页布局）。
 *
 * 布局：顶部「返回 + 设置」标题条，下方为圆角卡片：
 * 左侧是分区导航（外观 / 反编译器 / 数据管理 / 关于），
 * 右侧滚动展示当前分区的设置项。
 *
 * 「反编译器」分区承载 `ark_disasm` 可执行文件路径配置，
 * 保存时同步给后端校验并持久化，供打开项目时使用。
 */
import { useEffect, useState } from "react"
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
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ThemeToggle } from "../ThemeToggle"
import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tooltip,
  useDisclosure,
} from "../ui/base-ui"
import { usePersistentState } from "../../hooks/usePersistentState"
import { api } from "../../lib/api"
import appIcon from "../../assets/app-icon.svg"

/** 设置页分区 ID。 */
export type SettingsSectionId = "appearance" | "decompiler" | "data" | "about"

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
  { id: "decompiler", label: "反编译器", icon: FileCode2, title: "反编译器", description: "配置用于反编译 Ark 字节码的外部工具。" },
  { id: "data", label: "数据管理", icon: Database, title: "数据管理", description: "管理应用的本地数据与缓存。" },
  { id: "about", label: "关于", icon: Info, title: "关于" },
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
                <Button
                  key={id}
                  size="sm"
                  color={activeSection === id ? "primary" : "default"}
                  variant={activeSection === id ? "flat" : "light"}
                  className="h-9 shrink-0 justify-start px-3 md:w-full"
                  onPress={() => onSectionChange(id)}
                  startContent={<Icon className="h-4 w-4" />}
                >
                  {label}
                </Button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "decompiler" && <DecompilerSection />}
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

/** 反编译器分区：`ark_disasm` 可执行文件路径配置。 */
function DecompilerSection() {
  /** 已保存的 `ark_disasm` 路径（持久化，与工作台打开项目时读取的键一致）。 */
  const [toolPath, setToolPath, , toolPathLoaded] = usePersistentState<string>("disassembler-path", "")
  /** 输入框中的路径草稿（加载完成后与已保存值同步）。 */
  const [draft, setDraft] = useState("")
  /** 是否正在保存（等待后端校验）。 */
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (toolPathLoaded) setDraft(toolPath)
  }, [toolPath, toolPathLoaded])

  const isDirty = toolPathLoaded && draft.trim() !== toolPath.trim()

  /** 弹出原生文件选择框，选择 `ark_disasm` 可执行文件。 */
  const browse = async () => {
    const selected = await openFileDialog({ multiple: false, directory: false })
    if (typeof selected === "string") setDraft(selected)
  }

  /** 校验并保存路径；留空表示清除配置、回退自动探测。 */
  const save = async () => {
    const value = draft.trim()
    setIsSaving(true)
    try {
      await api.setDisassemblerPath(value || null)
    } catch (e) {
      addToast({ title: "ark_disasm 不可用", description: String(e), severity: "danger" })
      setIsSaving(false)
      return
    }
    setIsSaving(false)
    setToolPath(value)
    addToast({
      title: "设置已保存",
      description: value || "将自动在应用目录与 PATH 中查找 ark_disasm",
      severity: "success",
    })
  }

  return (
    <section aria-labelledby="decompiler-settings-heading">
      <SectionHeader
        id="decompiler-settings-heading"
        title="反编译器"
        description="配置用于反编译 Ark 字节码的外部工具。"
      />
      <div className="divide-y divide-default-200 px-5">
        <div className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-default-400" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">ark_disasm 路径</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-default-400">
                Hark 调用 OpenHarmony 官方 <code className="rounded bg-default-100 px-1">ark_disasm</code>{" "}
                工具反编译字节码。填写其可执行文件的完整路径；留空则自动在应用目录与 PATH 中查找。
              </p>
            </div>
          </div>
          <div className="flex w-full max-w-md flex-col gap-2 sm:w-auto sm:min-w-80">
            <Input
              placeholder="C:\\tools\\ark_disasm.exe"
              value={draft}
              onValueChange={setDraft}
              isDisabled={!toolPathLoaded}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="bordered"
                startContent={<FolderOpen className="h-3.5 w-3.5" />}
                onPress={() => void browse()}
              >
                浏览…
              </Button>
              <Button size="sm" color="primary" isDisabled={!isDirty} isLoading={isSaving} onPress={() => void save()}>
                保存
              </Button>
            </div>
          </div>
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
          Hark 是一个 Ark 字节码（.abc / .hap / .har）反编译工作台，基于 TroveKit 框架构建。
        </p>
      </div>
    </section>
  )
}
