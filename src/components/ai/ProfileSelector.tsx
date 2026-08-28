/**
 * Profile 下拉选择器：在 AI 面板内快速切换供应商/模型配置。
 */
import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "../../lib/utils"
import { findPreset, type AiProfile } from "../../lib/ai-profiles"

interface ProfileSelectorProps {
  profiles: AiProfile[]
  activeProfile: AiProfile | null
  onSelect: (id: string) => void
}

export function ProfileSelector({ profiles, activeProfile, onSelect }: ProfileSelectorProps) {
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
        className="flex max-w-[160px] items-center gap-1 rounded-md bg-default-100 px-2 py-0.5 text-[11px] font-medium text-default-500 transition-colors hover:bg-default-200 dark:bg-white/5 dark:hover:bg-white/10"
      >
        <span className="truncate">{activeProfile.name}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-default-200 bg-background shadow-lg">
          {profiles.map(profile => (
            <button
              key={profile.id}
              type="button"
              onClick={() => {
                onSelect(profile.id)
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-default-100",
                activeProfile.id === profile.id && "bg-primary/5",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">{profile.name}</div>
                <div className="truncate text-[10px] text-default-400">
                  {findPreset(profile.provider)?.name ?? profile.provider} · {profile.model}
                </div>
              </div>
              {activeProfile.id === profile.id && (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
