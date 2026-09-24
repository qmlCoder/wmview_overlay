# 修改记录

- 初始化：由原 Tauri 独立应用 `D:\code\overlay` 迁移为 wmview 插件（MF remote）。
  - 原 Rust 实现（read.rs / maths.rs / lib.rs 的 read_gjf / align / save_xyz）迁移到 `wasm/src/lib.rs`，
    以 wasm-bindgen 编译为 WASM（`wasm/pkg/`）。
- 调整：插件不做自有 3D 场景，改为纯对齐面板。
  - 参考分子取 `wmapi_files.get_select()`，几何取 `wmapi_scene.get_mole_geom(name)`；
  - 要对齐（调节）的分子取 `wmapi_files.get_option()`（多选）；
  - 未添加到场景的 option 分子跳过（`wmapi_scene.get_mole_geom(name)` 为空）；
  - 分子结构取 `wmapi_files.get_mole_info(name)`（异步 `{ syms, xyzs, bonds }`）；
  - 对齐用 WASM `align`，结果通过 `wmapi_editor.set_atom_position(name, record)` 写回宿主场景（宿主新增该 API）。
- 用 `wmapi_files.on_select` 监听文件列表选择变化，实时刷新“待对齐分子”与参考分子；
  进入面板只静默读取、不弹窗，点击对齐且前置条件不满足时才提示。
- 移除 unnecessary 依赖：three（不再渲染自有场景）。

- 同步 `src/wmapi.d.ts` 与主程序当前 `.d.ts`（主程序已无更新的 API 面）：
  - `SystmArgs.dirs` 补上“必须给出 3 个长度为3的单位向量（x/y/z 轴）”的注释；
  - `wmapi_scene.add_systm` 的文档注释同步；
  - 默认值 `SystmVals.dirs` 由 2 个方向修正为 `[[1,0,0],[0,1,0],[0,0,1]]`（与主程序 `scene/wmval.ts` 一致）。
- 核查结论：主程序当前**没有**“把分子添加到场景”的插件 API。
  唯一可用的间接路径是 `wmapi_files.show_file(name)`（内部 `get_moleInfo` → 未在场景则 `scene.moles.append(...)`），
  但它会把 `select` 切到该分子、切换当前显示分子、触发 `on_select` 并改窗口标题，不适合当作纯“加入场景”用。
- 主程序把 `wmapi_files.show_file` 改名为 `load_file(name, show)` 后接入本插件：
  - `src/wmapi.d.ts` 同步为主程序当前签名 `load_file: (name: string, show: boolean) => void`（移除 `show_file`）；
  - `Sider.vue` 新增 `ensure_in_scene(name)`：对齐前若 `wmapi_scene.get_mole_geom(name)` 为空，
    先 `await wmapi_files.load_file(name, false)` 把分子静默加载进场景，再重新取几何；
  - 面板说明同步为“未进入场景的 option 分子会先静默加载（不切换当前显示）再对齐”；
  - 主程序 `get_moleInfo` 为 async，`await load_file(...)` 能拿到“已加入场景”的时机（否则随后取几何会取空而误跳过）。
- 待主程序处理的问题（已在会话中反馈，未改主程序代码）：
  `Moles.append()` 内部固定调用 `show_mole(mole.uuid)`（`src/scripts/cores/mole.ts`），
  因此 `load_file(name, false)` 仍会把画面切到新加载的分子并隐藏原显示分子，
  需要在 `get_moleInfo` 里 append 之后恢复原显示分子（`const prev = scene.moles.get('', '', false)` → `scene.moles.show_mole(prev.uuid)`）才算真正的“只加载不显示”。
- 修复：文件列表点“全选/空选”后插件的“待调节分子（多选 option）”不刷新。
  - 原因：这两种操作是**整表替换**（`fileStore.option = [...]`，见主程序 `plugin/filelist/Sider.vue` 的 `set_option`），
    插件里保存的旧数组引用失效；而主程序只有 `on_select` 事件（切换显示分子时才触发），没有 option 变化事件。
    Shift 多选/单选取消是原地 push/splice，插件持有的是 store 数组本身，靠 Vue 响应式本来就能即时刷新，所以只有全选/空选失效。
  - 处理：新增 `sync_state()`，每 500ms 比对 `get_select()`/`get_option()`（整表替换由它兜底，原地修改仍即时生效），
    select 变化时同步刷新参考分子几何；组件卸载时清理定时器。
  - 前向兼容：若主程序提供 `wmapi_files.on_option(cb)`，插件优先订阅该事件、不再轮询（主程序尚未提供）。
  - 同一条兜底同时覆盖了主程序里其它无事件的改动：重命名/删除文件会整表替换 option 或直接改 select。
  - 附带风险提示（主程序侧）：`set_option('all')` 用的是 `fileStore.files`（未按文件类型过滤），
    因此“全选”可能把当前不显示的类型的文件也加入 option，对齐时会尝试全部加载。
- 主程序补上 `wmapi_files.on_option(callback)` 事件后，插件改为**优先订阅事件**（`src/wmapi.d.ts` 同步了该签名），
  仅当宿主没有该 API 时才退回 500ms 轮询。
  注意主程序目前是 `watch(() => fileStore.option, ...)`（未加 `deep`）：整表替换（全选/空选、重命名、删除）会触发，
  原地 push/splice（Shift 多选、单击取消）不会触发 —— 后者目前靠插件持有同一个 store 数组、由 Vue 响应式兜住。
  已反馈，主程序随之改为 `watch(..., { deep: true })`：原地增删、整表替换、重命名/删除都会触发 on_option。
  用 Vue 响应式做了对照验证：未加 deep 时原地 push 不触发（只有整表替换触发），加 deep 后三种改动都触发；
  整表替换后插件手里的旧数组引用确实失效（`held === store.option` 为 false），因此 `sync_state` 的键值比对是必要的。
- 面板改版：去掉“参考分子原子数”，待调节分子改成**每个分子一行**，并在每个分子下方显示其**已选中的原子**
  （用 `wmapi_scene.get_atom_select` 读，显示为 1 起的原子编号，与主程序里原子标签一致）；
  单元格里同时标注该分子是否已进入场景（未加载时显示“对齐时自动加载”）。
- 一键同步原子选择：新增按钮“用参考分子选中的原子同步待调节分子”。
  已在场景中的分子立即写入选择；尚未加载的记录为待同步、对齐加载后自动套用
  （否则它们没有选择会按“全部原子”对齐，与参考分子的子集数量不一致而被跳过）。
  `sync_state()` 同时负责刷新逐行显示的选中原子：宿主有 `on_atom_select` 事件就订阅，否则 500ms 轮询。
- **需要主程序补的 API**（插件已做运行时探测，加上即生效，插件无需再改）：
  1. 必需：`wmapi_scene.set_atom_select(mole_name, atms)` —— 当前只有 `get_atom_select`，没有写入接口；
     缺它时同步按钮禁用并给出提示；
  2. 可选：`wmapi_scene.on_atom_select(callback)` —— 用于替代 500ms 轮询刷新原子选择显示，
    可由 `scene.add_eventListener('SelectAtom', ...)`（`Atoms.set_selects` 内已触发）转发。
- 主程序已实现 `Moles.append(..., show = true)`（`show=false` 时只 add、不改 nowUuid、不切显示）与
  `wmapi_scene.set_atom_select`，`get_moleInfo` 里 append 传 `false`、再由 `if (show)` 的
  `show_mole(undefined, name)` 负责显示 —— “开始对齐/同步时不切换画面”已生效。
  插件 `src/wmapi.d.ts` 同步补上 `set_atom_select`。
- 按需求调整“同步原子选择”：点击后先把**未进入场景**的待调节分子逐个静默加载进场景
  （`load_file(name,false)`，不切换当前显示），再 `set_atom_select(name, 参考分子的原子)`；
  按钮加 loading/禁用防重复点击，加载失败的分子计数并在日志里说明。
  原先“未加载先记下来、对齐时再套用”的临时机制（`pending_selects`）随之删除。
- 宿主 console 一直打「根据名称获取分子 X」的原因：该日志在 `Moles.get(name)`（`scripts/cores/mole.ts`）里，
  而 overlay 为刷新“每个分子下面显示的选中原子”在轮询 `wmapi_scene.get_atom_select(name)`（以及 `get_mole_geom(name)`），
  两者内部都走 `scene.moles.get(mole_name)`，所以每个分子每轮都会打一条。
  插件侧缓解：轮询间隔 500ms→1000ms、面板收起（`get_show_siders` 不含 `overlay`）时跳过轮询、
  有选中原子的分子不再额外调 `get_mole_geom`（调用量约减半）。
  根治需宿主二选一：`wmapi_scene.on_atom_select(cb)`（由 `SelectAtom` 场景事件转发，插件已能自动改用、不再轮询）
  或 `wmapi_scene.get_atom_select_all()`（内部遍历 `moles.getAll()`，不经过 `Moles.get(name)`，不产生日志）。
- 主程序已提供 `wmapi_scene.on_atom_select(callback:(mole_name,atms)=>void)`（内部把 `SelectAtom` 场景事件转发出来），
  插件 `src/wmapi.d.ts` 同步该签名，`onMounted` 改为订阅事件：
  - 收到事件时**只更新对应那一行**（`on_atom_select_changed`），不再整表重查，避免每次按名查询宿主打日志；
  - `on_option` 与 `on_atom_select` 都在时**完全不创建轮询定时器**，console 刷屏问题消失
    （剩余按名查询只发生在用户动作上：切换选择/option、点同步、点对齐）。
- 排查「对得不是很齐」：把 `wasm/src/lib.rs` 的 align() 照抄成 JS，与 Kabsch/Horn 闭式最优刚体叠合对照
  （脚本留在 `notes/align_check.mjs`，`node notes/align_check.mjs` 可复跑）：
  - 400 组随机用例（随机分子 / 旋转 0~180° / 整体平移 / 构型变形 / 一半只用部分原子）：
    **rmsd 模式 0/400 次没到理论最优**，最大单原子偏差与最优解完全一致（平均 0.377 Å）；
  - **mesd 模式（原默认）问题明显**：平均最大单原子偏差 0.470 Å，最坏 6.6 Å
    （14 原子、旋转 172°、只对齐 4 个时，mesd 结果 RMSD 4.507 而最优 0.234）；
    且 400 组里有 **43 组**「从零开始的贪心」卡在比「用 Kabsch 解做初值再细化」更差的局部解（平均 MESD 差 0.189）；
  - 结论：优化器对 RMSD 够用（局部贪心但实测收敛到最优），
    看起来不齐主要来自默认指标 MESD（平均绝对距离，对个别原子的大偏差不敏感）+ MESD 下贪心会卡局部解。
- 据此改动：默认指标 MESD → **RMSD**（单选项顺序也调整为首位），并新增“选中原子索引不一致”的日志提醒
  （此前只校验数量，数量相同但索引不同时会做无意义的对应）。
- 待定（需用户确认）：把 RMSD 路径换成 Kabsch/Horn 闭式解（保证全局最优、比 300×9 次评估快得多），
  MESD 保留贪心但用 Kabsch 结果做初值；本机已有 cargo 1.96 + wasm-pack 0.15，可直接 `npm run build:wasm` 重建。
- 对齐算法落地改造（`wasm/src/lib.rs`）：
  - **RMSD 改为 Kabsch/Horn 闭式解**：新增 `kabsch()`（相关矩阵 → 4x4 对称阵 → Jacobi 求最大特征向量 → 四元数转旋转矩阵），
    一步给出全局最优，不再依赖 300×9 次贪心评估；Jacobi 而非幂迭代是因为对称分子（苯环）特征值重根会让幂迭代不收敛。
  - **MESD 改为双起点**：无闭式解，仍用逐轴贪心下降，但分别以“原始坐标”和“Kabsch 最优解”为起点各跑一次取更优，
    保证结果不差于改动前（原先约 10% 用例会卡在局部解）。
  - 新增入参校验：选择数为 0/两边数量不等/索引越界都返回错误（以前越界索引会 panic，进而让 WASM 实例失效）。
  - `cargo test` 新增两个纯数学测试（Kabsch 恢复已知刚体变换；Kabsch 的 RMSD 不大于贪心）；
    原有的 `read_gjf` 测试依赖 JS 运行时，加 `#[cfg(target_arch = "wasm32")]` 限定，宿主上 `cargo test` 现在可通过。
  - 用真实编译的 `wasm/pkg` 校验（脚本 `notes/align_check.mjs` 末尾）：
    200 组随机用例下 **rmsd 与理论最优 0/200 不一致**（最大差 8.9e-16）；
    **mesd 对比改动前 0 次更差、24 次更好、176 次相同**。
- 面板新增指标说明（用户要求“显示两个算法的原理与区别”）：
  - 单选下方常显当前指标的公式与一句话特点，另有「两种算法的原理与区别」可展开表格
    （定义 / 优化目标 / 求解方式 / 特点 / 适合场景），说明内容与 `lib.rs` 实现一致。
- 插件文档接入主程序「程序文档」面板（`wmapi_cores.add_appdoc(path, content)`，
  面板按 `/` 把 key 折成目录树、用 MdView 渲染，支持表格与 $公式$，**不解析裸 HTML**）：
  - 新增 `src/doc/usage.md`（使用说明：界面各项含义、使用步骤、对齐时发生了什么、注意事项、常见问题、依赖的宿主 API）
    与 `src/doc/algorithm.md`（对齐算法原理：RMSD/MESD 定义、Kabsch/Horn 闭式解、MESD 双起点贪心、对比表、实测数据、已知限制）；
  - `src/doc/index.ts` 导出 `DOCS`（path -> 内容）与 `register_docs()`，注册路径为
    `插件/overlay/使用说明.md`、`插件/overlay/对齐算法原理.md`；
  - `src/index.ts`（插件加载时）注册一次，`Sider.vue` 的 onMounted 再兜底注册一次
    （同 path 覆盖，重复调用无副作用；宿主没有 `add_appdoc` 时静默跳过）；
  - `src/wmapi.d.ts` 同步主程序的 `add_appdoc` 签名。
  - 校验：`npm run build` 通过；用 markdown-it 渲染两个 md 确认表格/公式块正常、无裸 HTML；
    dist 产物中已包含文档内容（`src-*.js` 命中）。
- 面板瘦身（文档搬进「程序文档」后，界面上不再重复解释原理）：
  - 删掉「对齐指标」下的公式、说明与可展开的对比表格，只留一行随选项变化的一句话提示
    （RMSD：整体贴合最紧（推荐）；MESD：抗离群原子，个别原子可能偏出去）→ `metric_hint`；
  - 删掉「开始对齐」下方那段多行说明，改为一行「详细说明见『程序文档 → 插件 / overlay』」；
  - 状态占位文字缩短：`（未选择，按全部原子对齐）`→`（未选择）`、`（未在场景中，对齐时自动加载）`→`（未加载）`；
  - 去掉 API 术语后缀：`参考分子（选择）`→`参考分子`、`待调节分子（多选 option）`→`待调节分子`；
  - 按钮改名 `用参考分子选中的原子同步待调节分子` → `同步原子选择到待调节分子`（日志里那句提示同步更新）；
  - 同步更新 `src/doc/usage.md` 中对应的界面名称与按钮名，保持文档与界面一致。
  - 保留的仍是功能性信息：参考分子/待调节分子/各自选中的原子、同步按钮、指标单选、开始对齐、日志。
- 新增「插件文档」按钮（主程序 `wmapi_cores.show_doc(path)`：设置 `appStore.dockey` 并打开文档面板）：
  - `src/doc/index.ts` 导出路径常量 `DOC_USAGE` / `DOC_ALGORITHM`，注册与打开共用同一份路径（避免对不上）；
  - `Sider.vue` 在「开始对齐」下方放轻量 link 按钮，点击时先 `register_docs()` 兜底注册，再 `show_doc(DOC_USAGE)`；
    宿主版本过旧（没有 `show_doc`）时提示去「程序文档 → 插件/overlay」查看，不静默失败；
  - 同时去掉了原来那行「详细说明见…」提示文字（由按钮替代）；
  - `src/wmapi.d.ts` 同步主程序的 `show_doc` 签名；`usage.md` 界面表补上一行「插件文档」。
- 「插件文档」入口样式调整（原来只是普通小号文字，不明显）：
  前面加文档图标 `📄`，文字改成蓝色（`#1971c2`，与主程序文档正文里的链接色一致，用内联样式保证不被
  element-plus 的 link 按钮配色覆盖），hover 加下划线，字号 13px、字重 500。
- 新增「保存对齐结果（-overlay.gjf）」按钮：把对齐过的待调节分子按**当前场景坐标**各写成一个 GJF，
  文件名 = 源文件名去扩展名 + `-overlay`（如 `BTM-1_sp.gjf` → `BTM-1_sp-overlay.gjf`），写到分子目录：
  - 头部信息取源文件：`.gjf` 用其任务行 + 电荷/自旋（`wmapi_fileinfo.get_file_info` 的 `Gjf`）；
    `.log` 只有任务行（电荷/自旋退回 `0 1`）；其它类型退回默认 `opt freq b3lyp/6-31g` + `0 1`，
    凡是用默认值都会在日志里以 `注意 xxx：…请检查` 明确提示；
  - 坐标用场景值（Å，8 位小数），拼文本后 `wmapi_cores.save_text(<分子目录>/<新名>, text)` 写出；
  - 用 `refs.aligned` 记录本次会话对齐成功的分子，按钮只在有可保存目标时可用（对齐过 + 仍在 option + 仍在场景）；
  - 同名文件直接覆盖；保存后文件列表不会自动刷新，日志/文档提示点 ↻ 刷新。
  - 用临时脚本核对过生成文本的格式（route / 空行 / title / 空行 / `charge multip` / 坐标 / 结尾空行），
    检查完已删；文档 `usage.md` 补了「保存对齐结果」小节、界面表一行与常见问题。
  - 顺带修文档渲染问题：中文标点紧贴 `**` 时 CommonMark 的 flanking 规则会让加粗失效
    （`点**「开始对齐」**` 渲染成字面量），已改成 `点 **「开始对齐」**`；用 markdown-it 复核两篇文档已无残留 `**`。
- 修保存按钮“换个选择就变灰”：原先保存目标要求 `option.includes(name)`，
  而主程序文件列表里**单击某个分子会把它从 option 里移出**（`on_item_click` → `splice` → 变成参考分子），
  于是对齐完再点一下那个分子，目标就空了、按钮被禁用。
  现在 `save_targets()` 以**「本次会话对齐过的分子 ∩ 仍在场景中」**为准（不再看 option / select 是谁），
  没有对齐结果时才退回「当前待调节分子 ∩ 仍在场景中」；只要场景里有分子按钮就可用，
  未参与本次对齐的会在日志里标注 `（当前坐标，未参与本次对齐）`。文档 `usage.md` 同步说明。
- 暴露插件脚本 API（主程序 `Plugin.apidoc` 通道：脚本面板「参考」页按插件名分标签，AI 通过 `wmapi_script.get_apidoc()` 读）：
  - 新增 `src/wmapi_overlay.d.ts`：声明 `window.wmapi_overlay`（`align` / `sync_selects` / `save` / `get_state` / `set_method`）
    及返回类型 `OverlayAlignResult` / `OverlaySaveResult` / `OverlayState`，文件本身就是 apidoc（`index.ts` 用 `?raw` 引入并挂到 `plugin.apidoc`）；
  - 面板三个功能重构成「核心函数 + 面板包装」：`align_core(method?, notify)`、`sync_selects_core(notify)`、`save_core(suffix?, notify)`，
    面板按钮传 `notify=true`（弹提示），脚本 API 传 `false`（只写日志），并返回结构化结果
    （对齐返回每个分子的 `{name, ok, err?, atoms?, reason?}`；保存返回 `{name, path?, from_source?, error?}`）；
  - 踩坑记录：apidoc 里**不能再用三反引号**写代码示例 —— 脚本面板会把整份 apidoc 再包一层 ```ts 渲染，
    里面的 ``` 会提前闭合外层代码块；改成缩进注释形式，并用 markdown-it 按面板流程复核（只剩 1 个代码块且包含全部 5 个 API）。
  - `usage.md` 增加「脚本 / AI 调用（wmapi_overlay）」小节列出各 API。
- 打包发布：新增 `info.json`（name/desc/version，version 与 package.json 保持一致）
  与 `pack.py`（照搬 `wmview.xtb/pack.py` 的约定：版本号从 package.json 同步进 info.json，
  打包前校验 `dist/index.js`、`dist/assets` 是否存在），产物 `wmview.overlay.zip`（703.7 KB，v0.1.0）。
  - 流程：`npm run build:wasm` → `npm run build` → `python pack.py`。
  - 包内布局以**插件目录根**为基准（`index.js`、`assets/`、`info.json`、`icon.png`），
    不带顶层目录：主程序 `market/Sider.vue` 明确要求入口是插件目录下的 `index.js`、
    有 `assets/` 才算 MF 打包插件，`assetUrlOf(folder + '/index.js')` 也是这个路径；
    `dist/` 这一层只存在于开发目录，`pack.py` 对文件取 basename、对目录取相对 dist 的路径，正好展平
    （与已发布的 wmview.xtb.zip / wmview.xyzrender.zip 逐条一致）。
  - 校验：zip 内 22 条，含 `assets/overlay_wasm_bg-*.wasm`（111 KB，对齐算法在 wasm 里）、
    `info.json`（version 0.1.0）、`icon.png`；MF remote 名仍是 `wmview_overlay`，`base: './'` 未变。
