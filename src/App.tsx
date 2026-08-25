/**
 * abcde —— Ark 字节码（.abc / .hap / .har）反编译工作台。
 *
 * 应用入口组件：整体界面即反编译工作台（jadx-gui 风格），
 * 左侧为项目文件树，右侧为反编译内容的多标签代码区。
 */
import { Workspace } from "./components/workspace/Workspace"

/** 应用根组件，直接渲染反编译工作台。 */
function App() {
  return <Workspace />
}

export default App
