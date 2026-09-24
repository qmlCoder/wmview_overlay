import type { Plugin } from './plugin'
import Sider from './Sider.vue'
import icon from './icon.png'
import { register_docs } from './doc'
// 插件脚本 API 的声明文件直接作为 apidoc：脚本面板的「参考」页与 AI 助手都会读到
import apidoc from './wmapi_overlay.d.ts?raw'

// 插件加载即把文档注册到主程序「程序文档」面板（宿主过旧时静默跳过）
try {
  register_docs()
} catch (e) {
  console.warn('注册插件文档失败', e)
}

/**
 * 插件入口（与开发指南约定，见「插件契约」）
 *
 * - `exposes['./index']` 指向本文件（vite.config.ts）
 * - 必须同时导出：
 *   - `plugin` 命名导出：主程序加载器优先取命名导出
 *   - `default` 导出：兼容旧加载通道（回退读取）
 */
export const plugin: Plugin = {
  name: 'overlay', // 侧边栏/日志里显示的名字
  sider: { name: 'overlay', icon: icon, comp: Sider },
  apidoc: apidoc, // 脚本 / AI 可调用的 API（window.wmapi_overlay）
  position: 'right', // 侧边栏位置：'left' | 'right'
  device: ['windows'],
}

export default plugin // 加载器优先读 plugin 导出，回退读 default
