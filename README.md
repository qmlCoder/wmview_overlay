# wmview.overlay

wmview 主程序的**分子结构对齐（overlay）插件**。

把**文件列表里多选的分子（option）**旋转/平移到与**选择的分子（参考）**最接近，
对齐结果直接写回宿主场景，让分子真正移动到参考分子上，并可另存为独立 GJF。

> 由原独立 Tauri 应用 `D:\code\overlay` 迁移而来；
> 原 Rust 实现的读文件 / 对齐 / 保存 xyz 能力已迁移到 **Rust WASM**（见 `wasm/`）。
> 本插件**没有自己的 3D 场景**，只提供一个对齐控制面板。

## 功能

- **参考分子**：主程序里选择的那个分子（`wmapi_files.get_select()`）
- **待调节分子**：`wmapi_files.get_option()` 返回的多选分子，面板里每个分子一行，并显示它选中的原子
- **对齐指标**：RMSD（默认，Kabsch/Horn 闭式解，全局最优）/ MESD（平均绝对距离）
- **原子选择**：有选中原子时按选中原子对齐，否则按全部原子；可一键把参考分子的选择同步给所有待调节分子
- **自动加载**：未进入场景的待调节分子会静默加载进场景（不切换当前显示）后再对齐
- **保存结果**：一键写出 `<原名>-overlay.gjf`（任务行/电荷/自旋取自源文件）
- **脚本 API**：`window.wmapi_overlay`（`align` / `sync_selects` / `save` / `get_state` / `set_method`）
- **自带文档**：注册进主程序「程序文档 → 插件 / overlay」（使用说明 + 对齐算法原理）

对齐算法与两种指标的差异、以及面板各项的含义，见插件内文档或仓库里的
[`src/doc/algorithm.md`](./src/doc/algorithm.md)、[`src/doc/usage.md`](./src/doc/usage.md)。

## 安装

`wmview.overlay.zip` 解压到主程序根目录的 `plugs/` 下（目录名保持 `wmview.overlay`），
重启主程序即加载；插件市场里安装则无需手动操作。

## 开发

```sh
npm install            # 首次
npm run build:wasm     # 仓库不含 wasm/pkg：克隆后首次构建前需要（需 Rust + wasm-pack），改 wasm 源码后也要
npm run dev            # vite 3001
npm run build          # 产物 dist/index.js + dist/assets（含 WASM）
python pack.py         # 打包 wmview.overlay.zip（版本号取自 package.json 并同步进 info.json）
```

- 仓库里只有 wasm 源码（`wasm/src`、`Cargo.toml`）：wasm-pack 生成的 `wasm/pkg` 被其自带的
  `.gitignore` 忽略，所以克隆后要先 `npm run build:wasm` 才能 `npm run build`。
  发布包里 wasm 通过 `dist/assets/*.wasm` 分发，**安装使用插件不需要 Rust**。
- 主程序 dev 自动加载只认 `wmview_xtb`，联调时把 `vite.config.ts` 的 `name` 临时改为
  `wmview_xtb`（发布前改回 `wmview_overlay`），或通过主程序「插件市场 → 加载本地插件」手动加载。
- 对齐算法的对照脚本：`node notes/align_check.mjs`（会把 `wasm` 里的算法与 Kabsch 最优解对比，
  并校验编译出来的 wasm）。

## 构建产物（发布）

`npm run build` 生成 `dist/`，把 `dist/index.js` + `dist/assets/`（含 `*.wasm`）放进主目录
`plugs/wmview.overlay/` 重启主程序即被加载（主程序会自动把该目录映射为 MF remote `wmview_overlay`）。
`python pack.py` 会直接产出这个结构的 `wmview.overlay.zip`。

详细契约与规则见 [`AGENTS.md`](./AGENTS.md) 与 [`开发指南.md`](./开发指南.md)。
