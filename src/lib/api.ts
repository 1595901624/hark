import { invoke } from "@tauri-apps/api/core"

export type NodeKind = "root" | "abc" | "package" | "class" | "method" | "resource_dir" | "resource"

export interface TreeNode {
  id: number
  name: string
  kind: NodeKind
  detail?: string
  children: TreeNode[]
}

export interface NodeContent {
  title: string
  language: string
  body: string
}

export const api = {
  openProject(path: string): Promise<TreeNode> {
    return invoke<TreeNode>("open_project", { path })
  },
  closeProject(): Promise<void> {
    return invoke("close_project")
  },
  getContent(nodeId: number): Promise<NodeContent> {
    return invoke<NodeContent>("get_content", { nodeId })
  },
  setDisassemblerPath(path: string | null): Promise<boolean> {
    return invoke<boolean>("set_disassembler_path", { path })
  },
}
