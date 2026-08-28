/**
 * AI Profile 系统：支持多配置档案，类似 Cline 的供应商管理。
 *
 * 用户可创建多个配置档案（如"DeepSeek 日常"、"GPT-4o 代码"），
 * 在对话窗口中快速切换。配置通过 Tauri Store 持久化。
 */
import { getStoredItem, setStoredItem } from "./store"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"

/** AI 配置档案。 */
export interface AiProfile {
  /** 唯一标识。 */
  id: string
  /** 用户自定义名称。 */
  name: string
  /** Provider 标识，对应 PROVIDER_PRESETS 中的 id；自定义时为 "custom"。 */
  provider: string
  /** API 基础地址。 */
  baseURL: string
  /** API 密钥。 */
  apiKey: string
  /** 当前使用的模型名称。 */
  model: string
  /** 该 Profile 下可用的模型列表。 */
  models: string[]
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
  { id: "anthropic", name: "Anthropic Claude", baseURL: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-20250514", needsApiKey: true },
  { id: "gemini", name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash", needsApiKey: true },
  { id: "moonshot", name: "Moonshot", baseURL: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-32k", needsApiKey: true },
  { id: "qwen", name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", needsApiKey: true },
  { id: "zhipu", name: "智谱 AI", baseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4", needsApiKey: true },
  { id: "yi", name: "零一万物", baseURL: "https://api.lingyiwanwu.com/v1", defaultModel: "yi-large", needsApiKey: true },
  { id: "baichuan", name: "百川", baseURL: "https://api.baichuan-ai.com/v1", defaultModel: "Baichuan4", needsApiKey: true },
  { id: "siliconflow", name: "硅基流动", baseURL: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3", needsApiKey: true },
  { id: "mistral", name: "Mistral AI", baseURL: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest", needsApiKey: true },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", needsApiKey: true },
  { id: "together", name: "Together AI", baseURL: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", needsApiKey: true },
  { id: "orca", name: "Orca Router", baseURL: "https://api.orcarouter.ai/v1", defaultModel: "orcarouter/free", needsApiKey: true },
  { id: "ollama", name: "Ollama (本地)", baseURL: "http://localhost:11434/v1", defaultModel: "llama3.1", needsApiKey: false },
  { id: "custom", name: "自定义", baseURL: "", defaultModel: "", needsApiKey: true },
]

/** Tauri Store 中存储 Profile 列表的键名。 */
const AI_PROFILES_KEY = "ai-profiles"
/** Tauri Store 中存储当前激活 Profile ID 的键名。 */
const AI_ACTIVE_PROFILE_KEY = "ai-active-profile"
/** 旧版单配置键名（用于迁移）。 */
const LEGACY_AI_CONFIG_KEY = "ai-config"

/** 根据 Provider ID 查找预设。 */
export function findPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === providerId)
}

/** 判断配置是否已就绪可发起对话。 */
export function isProfileReady(profile: AiProfile | null): boolean {
  if (!profile) return false
  if (!profile.baseURL.trim()) return false
  if (!profile.model.trim()) return false
  const preset = findPreset(profile.provider)
  if (preset?.needsApiKey && !profile.apiKey.trim()) return false
  return true
}

/** 生成唯一 ID。 */
function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 从旧版 ai-config 迁移为 Profile 列表。 */
async function migrateLegacyConfig(): Promise<{ profiles: AiProfile[]; migrated: boolean }> {
  const legacyRaw = await getStoredItem(LEGACY_AI_CONFIG_KEY)
  if (!legacyRaw) return { profiles: [], migrated: false }

  try {
    const parsed = JSON.parse(legacyRaw) as Partial<AiProfile>
    if (!parsed.baseURL || !parsed.model) return { profiles: [], migrated: false }

    const preset = findPreset(parsed.provider ?? "custom")
    const model = parsed.model ?? ""
    const profile: AiProfile = {
      id: genId(),
      name: preset ? `${preset.name}` : "默认配置",
      provider: parsed.provider ?? "custom",
      baseURL: parsed.baseURL,
      apiKey: parsed.apiKey ?? "",
      model,
      models: model ? [model] : [],
      temperature: parsed.temperature ?? 0.7,
    }
    return { profiles: [profile], migrated: true }
  } catch {
    return { profiles: [], migrated: false }
  }
}

/** 加载所有 Profile。首次使用时自动迁移旧配置。 */
export async function loadProfiles(): Promise<AiProfile[]> {
  try {
    const raw = await getStoredItem(AI_PROFILES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AiProfile[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 兼容旧版无 models 字段的 Profile
        return parsed.map(p => ({
          ...p,
          models: p.models ?? (p.model ? [p.model] : []),
        }))
      }
    }

    // 尝试迁移旧配置
    const { profiles, migrated } = await migrateLegacyConfig()
    if (migrated && profiles.length > 0) {
      await saveProfiles(profiles)
      await saveActiveProfileId(profiles[0].id)
    }
    return profiles
  } catch {
    return []
  }
}

/** 保存所有 Profile。 */
export async function saveProfiles(profiles: AiProfile[]): Promise<void> {
  await setStoredItem(AI_PROFILES_KEY, JSON.stringify(profiles))
}

/** 创建新 Profile 并保存。 */
export async function createProfile(profile: Omit<AiProfile, "id">): Promise<AiProfile> {
  const profiles = await loadProfiles()
  const newProfile: AiProfile = { ...profile, id: genId() }
  profiles.push(newProfile)
  await saveProfiles(profiles)
  return newProfile
}

/** 更新已有 Profile。 */
export async function updateProfile(id: string, updates: Partial<Omit<AiProfile, "id">>): Promise<void> {
  const profiles = await loadProfiles()
  const idx = profiles.findIndex(p => p.id === id)
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], ...updates }
    await saveProfiles(profiles)
  }
}

/** 删除 Profile。若删除的是激活 Profile，自动切换到第一个。 */
export async function deleteProfile(id: string): Promise<void> {
  const profiles = await loadProfiles()
  const filtered = profiles.filter(p => p.id !== id)
  await saveProfiles(filtered)

  const activeId = await loadActiveProfileId()
  if (activeId === id && filtered.length > 0) {
    await saveActiveProfileId(filtered[0].id)
  } else if (filtered.length === 0) {
    await setStoredItem(AI_ACTIVE_PROFILE_KEY, "")
  }
}

/** 加载当前激活的 Profile ID。 */
export async function loadActiveProfileId(): Promise<string | null> {
  const raw = await getStoredItem(AI_ACTIVE_PROFILE_KEY)
  if (!raw) return null
  return raw
}

/** 保存当前激活的 Profile ID。 */
export async function saveActiveProfileId(id: string): Promise<void> {
  await setStoredItem(AI_ACTIVE_PROFILE_KEY, id)
}

/** 获取当前激活的 Profile 对象。 */
export async function loadActiveProfile(): Promise<AiProfile | null> {
  const profiles = await loadProfiles()
  if (profiles.length === 0) return null

  const activeId = await loadActiveProfileId()
  if (activeId) {
    const found = profiles.find(p => p.id === activeId)
    if (found) return found
  }

  // 回退到第一个 Profile
  await saveActiveProfileId(profiles[0].id)
  return profiles[0]
}

/** 默认 Profile 数据（供 Settings UI 新建时使用）。 */
export function createDefaultProfileData(providerId: string = "deepseek"): Omit<AiProfile, "id"> {
  const preset = findPreset(providerId)
  const model = preset?.defaultModel ?? ""
  return {
    name: preset?.name ?? "自定义",
    provider: providerId,
    baseURL: preset?.baseURL ?? "",
    apiKey: "",
    model,
    models: model ? [model] : [],
    temperature: 0.7,
  }
}

/** 获取可用模型：调用 /v1/models 端点获取当前 API 下的模型列表。 */
export async function fetchAvailableModels(baseURL: string, apiKey: string): Promise<string[]> {
  const url = baseURL.replace(/\/+$/, "") + "/models"
  const res = await tauriFetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey || "ollama"}`,
      "Content-Type": "application/json",
    },
  })
  if (!res.ok) {
    throw new Error(`获取模型列表失败：HTTP ${res.status}`)
  }
  const data = await res.json() as { data?: Array<{ id: string }> }
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("模型列表响应格式异常")
  }
  return data.data.map(m => m.id).sort()
}
