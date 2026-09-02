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
  /** 内容语言标记（`asm` / `ts` / `json` / `image` / `text`），决定渲染方式。 */
  language: string
  /** 正文文本。 */
  body: string
}

/** 节点内容视图：`.abc` 反汇编 / `.ets` ArkTS 还原。 */
export type ViewKind = "abc" | "ets"

/** 方法在其所属类内容中的行定位信息（点击方法跳转到类内声明处）。 */
export interface MethodLocation {
  /** 所属类节点的 ID。 */
  class_node_id: number
  /** abc 视图中方法声明所在行（1-based，0 表示未找到）。 */
  abc_line: number
  /** ets 视图中方法声明所在行（1-based，0 表示未找到）。 */
  ets_line: number
}

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

/** 更新日志引用的资源文件内容（图片以 data URL 返回，文本以原文返回）。 */
export interface ChangelogAsset {
  /** 资源类型：`image` / `text`。 */
  kind: string
  /** MIME 类型（如 `image/png`、`application/json`）。 */
  mime: string
  /** 文本类资源的原始内容；图片类为空串。 */
  text: string
  /** 图片类资源的 data URL（`data:<mime>;base64,...`）；文本类为空串。 */
  data_url: string
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
   * 取消正在进行的打开项目操作。
   * 后端抬高打开代次，使正在运行的 `Project::open` 提前终止。
   */
  cancelOpenProject(): Promise<void> {
    return invoke<void>("cancel_open_project")
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
   * 定位方法节点在其所属类内容中的行位置（点击方法跳转到类内声明处）。
   * @param nodeId 方法节点 ID
   * @returns 所属类节点 ID 与 abc / ets 视图中的行号
   */
  methodLocation(nodeId: number): Promise<MethodLocation> {
    return invoke<MethodLocation>("method_location", { nodeId })
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
   * 导出指定节点的反汇编文本（abc 视图）为 `.pa` 文件。
   * @param nodeId 项目树节点 ID
   * @param path 导出文件的绝对路径
   */
  exportNodePa(nodeId: number, path: string): Promise<void> {
    return invoke<void>("export_node_pa", { nodeId, path })
  },

  /**
   * 导出指定图片资源节点的原始字节到目标路径。
   *
   * 从压缩包中读取图片的原始字节（未经 base64 编码）直接写盘，保留原始格式与质量。
   * 仅对图片类型（`.png` / `.jpg` / `.jpeg` / `.webp`）的资源节点有效。
   * @param nodeId 项目树节点 ID
   * @param path 导出文件的绝对路径
   */
  exportNodeImage(nodeId: number, path: string): Promise<void> {
    return invoke<void>("export_node_image", { nodeId, path })
  },

  /**
   * 导出指定文本资源节点（`.json` / `.info`）的原始内容到目标路径。
   *
   * 从压缩包中读取条目的原始字节直接写盘，保留原始内容。
   * @param nodeId 项目树节点 ID
   * @param path 导出文件的绝对路径
   */
  exportNodeResource(nodeId: number, path: string): Promise<void> {
    return invoke<void>("export_node_resource", { nodeId, path })
  },

  /**
   * 把当前项目包含的全部原始 `.abc` 字节码批量导出到目标目录。
   *
   * 后端在所选目录下自动创建以项目名命名的子目录：`.abc` 项目复制源文件，
   * 压缩包项目按包内相对路径提取全部 `.abc` 条目（同名覆盖）。
   * @param dir 目标目录的绝对路径
   * @returns 成功写入的文件相对路径列表（相对导出子目录）
   */
  exportProjectAbc(dir: string): Promise<string[]> {
    return invoke<string[]>("export_project_abc", { dir })
  },

  /**
   * 把项目全部反汇编文本按项目树结构批量导出为 `.pa` 文件到目标目录。
   *
   * 后端在所选目录下创建以项目名命名的子目录，并镜像左侧项目树：包名作为
   * 一层层文件夹、每个类作为单独的 `.pa` 文件（内容为该类的完整反汇编）。
   * 多单元项目按 `.abc` 单元建子目录，同名类自动去重。
   * @param dir 目标目录的绝对路径
   * @returns 成功写入的文件相对路径列表（相对导出子目录）
   */
  exportProjectPa(dir: string): Promise<string[]> {
    return invoke<string[]>("export_project_pa", { dir })
  },

  /**
   * 配置官方 `ark_disasm` 可执行文件路径。
   *
   * 保存前后端会对目标二进制执行 `--version` 校验，失败时返回错误且不保存。
   * @param path 完整路径；`null` / 空串表示清除配置、回退自动探测（含内置副本）
   * @returns 是否配置成功
   */
  setDisassemblerPath(path: string | null): Promise<boolean> {
    return invoke<boolean>("set_disassembler_path", { path })
  },

  /**
   * 获取 `ark_disasm` 的版本信息（执行 `--version`）。
   * @param path 指定的可执行文件路径；`null` / 空串时按自动探测顺序定位（含内置副本）
   * @returns 版本命令的多行文本输出
   */
  disassemblerVersion(path: string | null): Promise<string> {
    return invoke<string>("disassembler_version", { path })
  },

  /**
   * 全局多类别搜索当前打开的项目（后端后台线程执行，自动取消旧请求）。
   * @param options 查询文本、类别集合与匹配选项
   */
  searchProject(options: SearchOptions): Promise<SearchResponse> {
    return invoke<SearchResponse>("search_project", { options })
  },

  /**
   * 读取随应用分发的更新日志（`resources/CHANGELOG.md`）全文。
   * @returns 更新日志的 Markdown 文本
   */
  readChangelog(): Promise<string> {
    return invoke<string>("read_changelog")
  },

  /**
   * 读取更新日志引用的资源文件（`resources/changelog/<name>`）。
   * 图片以 data URL 返回，文本类（.json / .info 等）以原文返回。
   * @param name 资源文件名（仅文件名，不含路径）
   */
  readChangelogAsset(name: string): Promise<ChangelogAsset> {
    return invoke<ChangelogAsset>("read_changelog_asset", { name })
  },
}
