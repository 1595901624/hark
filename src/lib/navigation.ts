/**
 * 页面导航标识。
 *
 * Hark 当前只有两个页面：反编译工作台（`home`）与设置页（`settings`），
 * 由 `App` 的 `handleNavigate` 统一处理跳转。
 */
export type ToolId = "home" | "settings"
