/**
 * overlay 分子对齐插件的脚本 API（挂在 `window.wmapi_overlay` 上）
 *
 * 把文件列表里多选的分子（`wmapi_files.get_option()`）旋转/平移到与选择的参考分子
 * （`wmapi_files.get_select()`）最接近，结果直接写回场景；并可另存为 GJF。
 * 这里每个函数都等价于面板上的对应按钮，面板没打开也能调用。
 *
 * 用法示例（脚本面板里执行，或交给 AI 助手）：
 *
 *     // 1) 参考分子选好几个原子后，先同步给所有待调节分子
 *     await wmapi_overlay.sync_selects()
 *     // 2) 用 RMSD 对齐（返回每个分子的误差与状态）
 *     const res = await wmapi_overlay.align('rmsd')
 *     res.forEach((r) => console.log(r.name, r.ok ? r.err : r.reason))
 *     // 3) 另存为 <原名>-overlay.gjf
 *     const files = await wmapi_overlay.save()
 *     // 4) 查看当前状态（参考分子 / 待调节分子 / 各自选中的原子 / 已对齐的分子）
 *     console.log(wmapi_overlay.get_state())
 *
 * 注意：这里的示例故意不用三反引号包代码，因为脚本面板会把整份 apidoc 再包一层代码块渲染。
 *
 * 说明：对齐只管**旋转 + 平移**，不改键长键角；参与计算的原子是“选中的原子”，
 * 没选就用全部原子。相关原理与用法见「程序文档 → 插件 / overlay」。
 */
export interface wmapi_overlay {
  /**
   * 执行对齐（等价于面板「开始对齐」）
   * @param method 对齐指标：'rmsd'（默认，整体最紧）| 'mesd'（抗离群原子）；缺省用面板当前选择
   * @returns 每个待调节分子的结果，顺序与 get_option() 一致；ok=false 时看 reason
   */
  align: (method?: 'rmsd' | 'mesd') => Promise<OverlayAlignResult[]>

  /**
   * 把参考分子选中的原子同步给所有待调节分子（等价于面板「同步原子选择到待调节分子」）
   * 还没进入场景的分子会先静默加载（不切换当前显示的分子）
   * @returns 成功写入原子选择的分子名
   */
  sync_selects: () => Promise<string[]>

  /**
   * 把对齐结果另存为 GJF（等价于面板「保存对齐结果」）
   * 文件名 = 源文件名 + suffix + '.gjf'，写到当前分子目录；同名文件会被覆盖
   * 优先保存“本次会话对齐过的分子”，没有对齐结果时保存当前待调节分子
   * @param suffix 文件名后缀，缺省 '-overlay'
   * @returns 每个分子的保存结果（含写出的完整路径；失败时看 error）
   */
  save: (suffix?: string) => Promise<OverlaySaveResult[]>

  /** 读取当前状态（不改变任何东西） */
  get_state: () => OverlayState

  /** 设置对齐指标，会同步面板上的单选 */
  set_method: (method: 'rmsd' | 'mesd') => void
}

/** 单个分子的对齐结果 */
export interface OverlayAlignResult {
  /** 分子名（文件名） */
  name: string
  /** 是否对齐并写回成功 */
  ok: boolean
  /** 误差：rmsd 模式为 RMSD，mesd 模式为平均绝对距离（单位 Å） */
  err?: number
  /** 参与对齐的原子数 */
  atoms?: number
  /** ok=false 的原因（未在场景中 / 选中原子数不一致 等） */
  reason?: string
}

/** 单个分子的保存结果 */
export interface OverlaySaveResult {
  /** 分子名（源文件名） */
  name: string
  /** 写出的文件完整路径 */
  path?: string
  /** 任务行/电荷/自旋是否取自源文件（false 表示用了默认值，需要检查） */
  from_source?: boolean
  /** 失败原因 */
  error?: string
}

/** 插件当前状态 */
export interface OverlayState {
  /** 参考分子（get_select） */
  reference: string
  /** 待调节分子（get_option） */
  options: string[]
  /** 每个分子选中的原子索引（从 0 开始） */
  selects: Record<string, number[]>
  /** 每个分子是否已在场景中 */
  in_scene: Record<string, boolean>
  /** 本次会话里对齐过的分子 */
  aligned: string[]
  /** 当前对齐指标 */
  method: 'rmsd' | 'mesd'
}

declare global {
  interface Window {
    wmapi_overlay: wmapi_overlay
  }
}
