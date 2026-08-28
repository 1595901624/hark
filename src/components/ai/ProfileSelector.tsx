/**
 * Profile/Model 下拉选择器：在 AI 面板内快速切换供应商与模型。
 *
 * 按钮显示当前模型名称，下拉菜单按 Profile 分组展示所有可选模型。
 * 选择模型时若跨 Profile 则同时切换 Profile。
 */
import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "../../lib/utils"
import { findPreset, type AiProfile } from "../../lib/ai-profiles"

interface ProfileSelectorProps {
  profiles: AiProfile[]
  activeProfile: AiProfile | null
  onSelectModel: (profileId: string, model: string) => void
}

export function ProfileSelector({ profiles, activeProfile, onSelectModel }: ProfileSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  if (profiles.length === 0 || !activeProfile) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex max-w-[200px] items-center gap-1 rounded-md bg-default-100 px-2 py-0.5 text-[11px] font-medium text-default-500 transition-colors hover:bg-default-200 dark:bg-white/5 dark:hover:bg-white/10"
        title={`${activeProfile.name} · ${activeProfile.model}`}
      >
        <span className="truncate">{activeProfile.model}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[400px] w-64 overflow-y-auto rounded-lg border border-default-200 bg-background shadow-lg scrollbar-thin">
          {profiles.map(profile => (
            <div key={profile.id}>
              {/* Profile 分组标题 */}
              <div className="sticky top-0 border-b border-default-200/50 bg-chrome/80 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-default-400 backdrop-blur-sm">
                {profile.name}
                <span className="ml-1.5 text-default-300">
                  {findPreset(profile.provider)?.name ?? profile.provider}
                </span>
              </div>
              {/* 模型列表 */}
              {profile.models.length === 0 ? (
                <div className="px-3 py-1.5 text-[11px] text-default-300">暂无模型</div>
              ) : (
                profile.models.map(model => {
                  const isActive = profile.id === activeProfile.id && model === activeProfile.model
                  return (
                    <button
                      key={model}
                      type="button"
                      onClick={() => {
                        onSelectModel(profile.id, model)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-default-100",
                        isActive && "bg-primary/5",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">{model}</span>
                      {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  )
                })
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
