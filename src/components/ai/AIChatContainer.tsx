/**
 * AIChatContainer：隔离 AI 对话状态的独立组件。
 *
 * 将 useAIChat 调用从 Workspace 中抽离，使流式输出时只有本组件
 * 及其子组件重渲染，不影响项目树、编辑器等重型 UI。
 */
import { memo, useMemo } from "react"
import { useAIChat, type ChatContext } from "../../hooks/useAIChat"
import { AIPanel } from "./AIPanel"

interface AIChatContainerProps {
  isPanelOpen: boolean
  onClose: () => void
  onOpenSettings: () => void
  context: ChatContext | null
}

function AIChatContainerInner({ onClose, onOpenSettings, context }: AIChatContainerProps) {
  const ai = useAIChat(context)

  // 稳定回调，避免 AIPanel 因 onClose 引用变化而重渲染
  const handleClose = useMemo(() => onClose, [onClose])
  const handleSettings = useMemo(() => onOpenSettings, [onOpenSettings])

  return (
    <AIPanel
      onClose={handleClose}
      onOpenSettings={handleSettings}
      context={context}
      messages={ai.messages}
      sendMessage={ai.sendMessage}
      status={ai.status}
      error={ai.error}
      configReady={ai.configReady}
      configLoaded={ai.configLoaded}
      config={ai.config}
    />
  )
}

export const AIChatContainer = memo(AIChatContainerInner)
