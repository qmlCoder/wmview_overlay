/**
 * 插件文档：注册到主程序的「程序文档」面板（顶栏文档图标 / 菜单 → 程序文档）。
 *
 * 主程序 `wmapi_cores.add_appdoc(path, content)` 把 markdown 存进 appdoc（key 即路径），
 * 面板按 `/` 分层显示目录树；内容用 markdown-it 渲染，支持表格与 $公式$，
 * 但不解析裸 HTML（所以文档里不要写 <br> 之类）。
 * 同一个 path 重复注册是覆盖，可安全重复调用。
 */
import usage from './usage.md?raw'
import algorithm from './algorithm.md?raw'

/** 本插件文档在「程序文档」里的路径（同时是文档面板的 key） */
export const DOC_USAGE = '插件/overlay/使用说明.md'
export const DOC_ALGORITHM = '插件/overlay/对齐算法原理.md'

/** 文档路径 -> markdown 内容（路径决定目录层级） */
export const DOCS: [string, string][] = [
  [DOC_USAGE, usage],
  [DOC_ALGORITHM, algorithm],
]

/**
 * 把本插件文档注册到主程序文档面板。
 * @returns 是否注册成功（宿主版本过旧、没有 add_appdoc 时返回 false）
 */
export const register_docs = () => {
  const cores = window.wmapi_cores
  if (typeof cores?.add_appdoc !== 'function') return false
  for (const [path, content] of DOCS) {
    cores.add_appdoc(path, content)
  }
  return true
}
