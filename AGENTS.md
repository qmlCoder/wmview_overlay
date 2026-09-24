# wmview.overlay 插件项目

wmview 主程序的**外部插件**，提供分子结构对齐（overlay）能力：
把**文件列表里选中的分子**旋转/平移到与**当前显示的分子（参考）**最接近，
对齐结果直接写回宿主场景，让选中的分子真正移动到参考分子上。原逻辑由 `D:\code\overlay`（Tauri 独立应用）迁移而来，
其中原先用 Rust 实现的读文件 / 对齐 / 保存 xyz 能力已迁移到 **Rust WASM**（见 `wasm/`）。

> 本插件**没有自己的 3D 场景**：只做对齐面板，参考分子用 `wmapi_files.get_select()`（选择的分子，需在场景中）、
  需要调节的分子用 `wmapi_files.get_option()`（多选），对齐结果通过 `wmapi_editor.set_atom_position(name, record)`
  写回宿主场景（`record` 为原子索引到 [x,y,z] 的映射）；未添加到场景中的 option 分子会被跳过。

> 本文件是本项目的核心规则。开始任务前先读它；规则与任务冲突时，以本文件为准并向用户说明。

## 参考项目（必读）

| 项目 | 路径（相对本目录） | 用途 |
| --- | --- | --- |
| 主程序 | `../../wmview_app` | API、库版本、插件契约的**唯一权威来源** |
| 插件样板 | `../wmview.xtb` | Module Federation remote 工程结构参考 |
| 插件样板 | `../wmview.xyzrender` | 如何用宿主 `wmapi_scene/files/core` 取分子结构 |

主程序关键文件：`src/plugin.d.ts`（Plugin 类型）、`src/wmapi.d.ts`（`wmapi_cores`）、
`src/plugin/filelist/wmapi.d.ts`（`wmapi_files`）、`src/plugin/mf.ts`（`remoteNameOf` / `assetUrlOf`）、
`src/plugin/dev.ts`（`DEV_PLUGIN_FOLDER`，dev 自动加载只认 `wmview.xtb`）。

## 依赖与版本（硬约束）

- **运行时库复用主程序的 MF 共享依赖**：vue / element-plus 由主程序（MF Host）以 singleton 形式
  提供（见主项目 `wmview_app/vite.config.ts` 的 `federation.shared`），插件作为 MF remote 不重复打包。
  `@module-federation/vite` 版本与主项目保持一致。
- 所有依赖版本**必须与主项目 `wmview_app/package.json` 保持一致**；主项目升级依赖时同步升级。
- 本插件**不引入**主项目没有的运行时依赖（本插件已移除 three，不渲染自有 3D 场景）。
  wasm-bindgen 只存在于 `wasm/` 子工程，不进入 npm 运行时依赖。

## 插件契约（与主程序约定，勿擅自更改）

- 本插件以 **Module Federation remote** 构建（`@module-federation/vite`），配置见 `vite.config.ts`：
  - name **发布时必须是** `wmview_overlay`（主程序 `remoteNameOf('wmview.overlay')` 得到）；
    目录名 `wmview.overlay` → 发布目录 `plugs/wmview.overlay/`。
  - exposes `./index` → 入口 `src/index.ts`；shared 声明 vue/element-plus/three singleton。
  - **开发自动加载**：主程序 `dev.ts` 把 `DEV_PLUGIN_FOLDER` 写死为 `wmview.xtb`，所以本插件
    `npm run dev` 后不会自动被主程序 dev 加载；联调时可临时把 `vite.config.ts` 的 `name` 改为
    `wmview_xtb`（发布前改回 `wmview_overlay`），或通过主程序"插件市场→加载本地插件"手动加载。
- 入口 `src/index.ts` 必须**同时**导出：
  - `export const plugin: Plugin` —— 主程序 `pickPlugin` 优先取命名导出
  - `export default plugin` —— 兼容旧加载通道
- 宿主 API：`window.wmapi_cores`（`save_file_dialog` / `save_text` / `notify` 等）、
  `window.wmapi_files`（`get_file_list` / `get_mole_info` / `get_select` / `get_option` / `on_select` / `wait_root` / `get_moleFold` 等）、
  `window.wmapi_editor`（`set_atom_position(name, record)` —— 写回原子坐标）。
  `wmapi_files.get_select()` 返回**参考分子**（选择的分子）；`get_option()` 返回**需要调节的分子**（多选）；
  仅对已经在场景中的分子做对齐并写回（`wmapi_scene.get_mole_geom(name)` 为空则跳过）；
  分子结构用 `wmapi_files.get_mole_info(name)`（异步，返回 `{ syms, xyzs, bonds }`）。
  类型定义见 `src/wmapi.d.ts`（与主项目 `.d.ts` 保持同步，唯一类型来源）。
- **构建产物 base 必须是 `./`**：插件被宿主放到 `plugs/wmview.overlay/` 子目录加载
  （`asset.localhost`），wasm 等资源用 `new URL(..., import.meta.url)` 引用，若 base 为 `/` 会解析到
  宿主根目录而 404。见 `vite.config.ts` 的 `base: './'`。

## WASM 子工程（wasm/）

- 原 Tauri 工程的 Rust 逻辑迁移到浏览器 WASM，代码在 `wasm/src/lib.rs`：
  - `readGjf(text)` → 解析 gjf/xyz 文本，返回 `{ syms, xyzs }`
  - `align(mole1, mole2, method)` → 旋转/平移第二组分子使 MESD 或 RMSD 最小，返回 `{ xyzs, err }`
  - `saveXyz(moles)` → 把分子列表拼成 xyz 文本
- 构建命令：`npm run build:wasm`（即 `wasm-pack build wasm --target web --out-dir pkg`）。
  wasm 产物 `wasm/pkg/overlay_wasm.{js,wasm,d.ts}` **不进版本库**（wasm-pack 自带的 `wasm/pkg/.gitignore` 里是 `*`）；
  **安装/使用插件不需要 Rust 工具链**（发布包里 wasm 通过 `dist/assets/*.wasm` 分发），
  但**从仓库克隆后首次构建前必须先跑 `npm run build:wasm`**（需要 Rust + wasm-pack），
  修改 `wasm/` 源码后同样要重新构建。
- 前端通过 `import wasmInit, { readGjf, align, saveXyz } from "../wasm/pkg/overlay_wasm.js"`
  使用，`onMounted` 里 `await wasmInit()` 初始化一次。

## 目录结构

```
wmview.overlay/
├── AGENTS.md           # 本项目规则
├── vite.config.ts      # Module Federation remote 构建, dev 端口 3001, base='./'
├── src/                # 前端（Vue3 + TS）
│   ├── index.ts        # 插件入口（exposes './index'）：export plugin + export default
│   ├── plugin.d.ts     # Plugin/Sider/Setting 类型（从主程序复制）
│   ├── Sider.vue       # 插件主界面：对齐面板（无自有 3D 场景）
│   ├── comps/          # Panel-Group.vue / Panel-Item.vue（从主程序复制）
│   └── wmapi.d.ts      # 宿主 API 类型（wmapi_cores/files/scene/...）
├── wasm/               # Rust WASM 子工程（原 Tauri Rust 逻辑迁移）
│   ├── Cargo.toml
│   ├── src/lib.rs      # readGjf / align / saveXyz
│   └── pkg/            # wasm-pack 产物（本地构建生成，不进版本库）
└── 开发指南.md
```

## 开发流程

```sh
npm install            # 首次
npm run build:wasm     # 仓库不含 wasm/pkg：克隆后首次构建前需要（需 Rust + wasm-pack），改 wasm 源码后也要
npm run dev            # vite 3001；主程序 dev 需把 MF name 临时改为 wmview_xtb 才会自动加载
npm run build          # 产物 dist/index.js + dist/assets（含 WASM）
```

坑位提醒：
- **面板组件从主程序 `src/comps/` 复制**（Panel-Group.vue / Panel-Item.vue），改动前先看主程序是否已更新。
- `wmapi_files.get_files()` / `get_moleInfo()` 依赖主程序根目录初始化，先 `await files.wait_root()`。
- WASM 函数（readGjf/align/saveXyz）在**主线程**同步执行；分子较大时对齐会短暂卡顿，
  属可接受范围（与原 Tauri 实现算法一致）。

## 发布形态

主程序把压缩包解压到其根目录 `plugs/` 下（目录名 `wmview.overlay`）重启即加载。
插件目录内包含：`dist/index.js`、`dist/assets/`（含 `*.wasm`）。

## 修改记录

- 每完成一次功能/修复，将要点**追加**到 `notes/latest.md`。

## 版本号

- 版本号**单一来源**为 `package.json` 的 `version` 字段。
