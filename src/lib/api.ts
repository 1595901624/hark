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

/** 后端命令的统一调用入口。 */
export const api = {
  /**
   * 打开一个 `.abc` / `.hap` / `.har` 文件并反编译。
   * @param path 文件绝对路径
   * @returns 项目树根节点
   */
  openProject(path: string): Promise<TreeNode> {
    return invoke<TreeNode>("open_project", { path })
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
}
