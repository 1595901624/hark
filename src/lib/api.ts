/**
 * Tauri 后端命令的类型定义与调用封装。
 *
 * 所有与 Rust 侧（`src-tauri`）的通信统一收敛到 `api` 对象，
 * 前端组件不直接调用 `invoke`。
 */
import { invoke } from "@tauri-apps/api/core"

/** 项目树节点的类型，与后端 `NodeKind` 一一对应。 */
export type NodeKind =
  | "root" // 项目根节点（打开的文件）
  | "abc" // .abc 字节码单元
  | "package" // 包（按类名分段推导）
  | "class" // 类（pandasm record）
  | "method" // 方法
  | "resource_dir" // 资源目录
  | "resource" // 资源文件

/** 项目树节点（后端 `TreeNode` 的镜像）。 */
export interface TreeNode {
  /** 全项目唯一的节点 ID，用于请求内容。 */
  id: number
  /** 展示名（包名最后一段 / 类短名 / 方法名等）。 */
  name: string
  /** 节点类型。 */
  kind: NodeKind
  /** 附加说明（类数量、字节码版本等），可能为空。 */
  detail?: string
  /** 子节点；方法与资源文件为叶子节点。 */
  children: TreeNode[]
}

/** 节点内容切片（后端 `NodeContent` 的镜像）。 */
export interface NodeContent {
  /** 内容标题（完整类名 / `类.方法` / 单元名）。 */
  title: string
  /** 内容语言标记（`asm` / `ts` / `text`），决定高亮方式。 */
  language: string
  /** 正文文本。 */
  body: string
}

/** 节点内容视图：`.abc` 反汇编 / `.ets` ArkTS 还原。 */
export type ViewKind = "abc" | "ets"

/** `.hark` 工作区快照中的单个标签恢复信息。 */
export interface SavedTab {
  /** 项目树节点 ID。 */
  nodeId: number
  /** 该标签激活的内容视图。 */
  view: ViewKind
}

/** `.hark` 工作区快照：已打开标签列表 + 激活标签 + 项目树展开状态。 */
export interface SavedWorkspace {
  tabs: SavedTab[]
  activeNodeId?: number | null
  /** 保存时处于展开状态的项目树节点 ID（恢复侧边栏展开现场）。 */
  expandedNodeIds?: number[] | null
}

/** 打开 `.hark` 时后端返回的会话元数据。 */
export interface HarkSession {
  app: string
  appVersion: string
  savedAtMs: number
  project: {
    name: string
    kind: string
    sourcePath: string
  }
  workspace: SavedWorkspace
}

/** 全局搜索类别（后端 `SearchCategory` 镜像，可多选）。 */
export type SearchCategory =
  | "class" // 类名
  | "method" // 方法名
  | "field" // 字段名
  | "string" // 字符串字面量内容
  | "code" // 反汇编代码全文
  | "resource" // 压缩包内资源文件路径

/** 全局搜索参数。 */
export interface SearchOptions {
  /** 查询文本；正则模式下为表达式。 */
  query: string
  /** 启用的类别（至少一个）。 */
  categories: SearchCategory[]
  /** 是否区分大小写。 */
  caseSensitive?: boolean
  /** 是否按正则表达式解析查询。 */
  isRegex?: boolean
  /** 返回结果上限，默认 1000。 */
  maxResults?: number
}

/** 单条全局搜索命中。 */
export interface SearchHit {
  /** 点击结果时应打开的节点 ID（类节点或资源节点）。 */
  classNodeId: number
  /** 分组标题：类展示名或资源文件路径。 */
  classDisplayName: string
  /** 所属 `.abc` 单元名；资源命中为空串。 */
  unitName: string
  /** 命中行（1-based，对应类的 abc 视图）；类名 / 资源命中为 0。 */
  line: number
  /** 命中行文本（trim 后）。 */
  text: string
  /** 高亮区间（`text` 内的字符下标，前闭后开）。 */
  matchRanges: [number, number][]
  /** 命中类别（同行多类别聚合）。 */
  categories: SearchCategory[]
}

/** 全局搜索响应。 */
export interface SearchResponse {
  /** 命中列表（按项目树顺序排序）。 */
  hits: SearchHit[]
  /** 聚合后的命中总数。 */
  totalMatches: number
  /** 是否因超过上限被截断。 */
  truncated: boolean
  /** 搜索耗时（毫秒）。 */
  elapsedMs: number
  /** 被更新的搜索取消时为 `true`（结果为空，可忽略）。 */
  cancelled: boolean
}

/** [`api.openProject`] 的返回值。 */
export interface OpenProjectResult {
  /** 项目树根节点。 */
  tree: TreeNode
  /** 打开 `.hark` 时的会话元数据；普通文件为 `null`。 */
  session: HarkSession | null
}

/** 后端命令的统一调用入口。 */
export const api = {
  /**
   * 打开一个 `.abc` / `.hap` / `.har` 文件或 `.hark` 工作区并反编译。
   * @param path 文件绝对路径
   * @returns 项目树根节点 + `.hark` 会话元数据（普通文件为 `null`）
   */
  openProject(path: string): Promise<OpenProjectResult> {
    return invoke<OpenProjectResult>("open_project", { path })
  },

  /**
   * 把当前项目与工作区快照保存为 `.hark` 文件。
   * @param path 目标 `.hark` 文件的绝对路径
   * @param workspace 前端整理的工作区快照（标签与激活状态）
   */
  saveProjectHark(path: string, workspace: SavedWorkspace): Promise<void> {
    return invoke<void>("save_project_hark", { path, workspace })
  },

  /** 关闭当前项目并释放后端内存。 */
  closeProject(): Promise<void> {
    return invoke("close_project")
  },

  /**
   * 获取指定节点的内容切片。
   * @param nodeId 项目树节点 ID
   * @param view 内容视图：`abc` 反汇编（默认）/ `ets` ArkTS 还原
   */
  getContent(nodeId: number, view: ViewKind = "abc"): Promise<NodeContent> {
    return invoke<NodeContent>("get_content", { nodeId, view })
  },

  /**
   * 把节点的 `.ets` 还原结果导出到目标路径。
   * @param nodeId 项目树节点 ID
   * @param path 导出文件的绝对路径
   */
  exportNodeEts(nodeId: number, path: string): Promise<void> {
    return invoke<void>("export_node_ets", { nodeId, path })
  },

  /**
   * 配置官方 `ark_disasm` 可执行文件路径。
   * @param path 完整路径；`null` / 空串表示清除配置、回退自动探测
   * @returns 是否配置成功
   */
  setDisassemblerPath(path: string | null): Promise<boolean> {
    return invoke<boolean>("set_disassembler_path", { path })
  },

  /**
   * 全局多类别搜索当前打开的项目（后端后台线程执行，自动取消旧请求）。
   * @param options 查询文本、类别集合与匹配选项
   */
  searchProject(options: SearchOptions): Promise<SearchResponse> {
    return invoke<SearchResponse>("search_project", { options })
  },
}
