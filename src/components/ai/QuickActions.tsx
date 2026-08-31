/**
 * 快捷操作按钮：一键发送预设 prompt。
 */
import { BookOpen, ShieldQuestion, FileSearch } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"

interface QuickActionsProps {
  onAction: (prompt: string) => void
  disabled?: boolean
}

interface QuickAction {
  label: string
  prompt: string
  icon: LucideIcon
}

const ACTIONS: QuickAction[] = [
  { label: "解释代码", prompt: "请解释当前代码的功能和逻辑，包括主要类和方法的作用。", icon: BookOpen },
  { label: "总结项目", prompt: "请根据当前项目结构和代码，总结这个应用的主要功能和架构。", icon: FileSearch },
  { label: "检测敏感API", prompt: "请检查当前代码中是否存在敏感 API 调用（如隐私权限、网络请求、文件操作等），并给出风险提示。", icon: ShieldQuestion },
]

/** 快捷操作常量，供输入框折叠菜单复用。 */
export const QUICK_ACTIONS = ACTIONS

export function QuickActions({ onAction, disabled }: QuickActionsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2">
      {ACTIONS.map(({ label, prompt, icon: Icon }) => (
        <button
          key={label}
          type="button"
          disabled={disabled}
          onClick={() => onAction(prompt)}
          className={cn(
            "flex items-center gap-1 rounded-lg border border-default-200 px-2 py-1 text-[11px] font-medium text-default-500 transition-colors hover:bg-default-100 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  )
}
