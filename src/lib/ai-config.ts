/**
 * AI 助手配置：类型定义、Provider 预设与 Tauri Store 持久化。
 *
 * 支持多家 OpenAI 兼容协议的 LLM 提供商，用户在设置页选择 Provider 后
 * 自动填入 baseURL，也可手动填写自定义地址。配置通过 Tauri Store
 * 持久化，与 disassembler-path 等其他设置统一管理。
 */
import { getStoredItem, setStoredItem } from "./store"

/** AI 配置（持久化到 Tauri Store）。 */
export interface AiConfig {
  /** Provider 标识，对应 PROVIDER_PRESETS 中的 id；自定义时为 "custom"。 */
  provider: string
  /** API 基础地址（如 `https://api.deepseek.com/v1`）。 */
  baseURL: string
  /** API 密钥。 */
  apiKey: string
  /** 模型名称（如 `deepseek-chat`、`gpt-4o`）。 */
  model: string
  /** 采样温度，0~2。 */
  temperature: number
}

/** Provider 预设：选择后自动填入 baseURL 与默认模型。 */
export interface ProviderPreset {
  id: string
  name: string
  baseURL: string
  defaultModel: string
  /** 是否需要 API Key（Ollama 本地部署通常不需要）。 */
  needsApiKey: boolean
}

/** 内置 Provider 预设列表。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o", needsApiKey: true },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", needsApiKey: true },
  { id: "moonshot", name: "Moonshot", baseURL: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-32k", needsApiKey: true },
  { id: "qwen", name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", needsApiKey: true },
  { id: "ollama", name: "Ollama (本地)", baseURL: "http://localhost:11434/v1", defaultModel: "llama3.1", needsApiKey: false },
  { id: "custom", name: "自定义", baseURL: "", defaultModel: "", needsApiKey: true },
]

/** Tauri Store 中存储 AI 配置的键名。 */
const AI_CONFIG_KEY = "ai-config"

/** 默认 AI 配置（未配置时使用）。 */
export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.7,
}

/** 从 Tauri Store 加载 AI 配置；未配置时返回 null。 */
export async function loadAiConfig(): Promise<AiConfig | null> {
  try {
    const raw = await getStoredItem(AI_CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AiConfig>
    if (!parsed.baseURL || !parsed.model) return null
    return { ...DEFAULT_AI_CONFIG, ...parsed }
  } catch {
    return null
  }
}

/** 保存 AI 配置到 Tauri Store。 */
export async function saveAiConfig(config: AiConfig): Promise<void> {
  await setStoredItem(AI_CONFIG_KEY, JSON.stringify(config))
}

/** 根据 Provider ID 查找预设。 */
export function findPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === providerId)
}

/** 判断配置是否已就绪可发起对话。 */
export function isConfigReady(config: AiConfig | null): boolean {
  if (!config) return false
  if (!config.baseURL.trim()) return false
  if (!config.model.trim()) return false
  const preset = findPreset(config.provider)
  if (preset?.needsApiKey && !config.apiKey.trim()) return false
  return true
}
