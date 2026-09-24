"""
打包 wmview.overlay 插件压缩包

产物: wmview.overlay.zip（文件名不带版本号，版本号见包内 info.json）
解压到主程序根目录 plugs/ 下（目录名保持 wmview.overlay），重启 wmview 即可加载。
zip 内直接是插件内容，不带顶层目录（与 wmview.xtb / wmview.xyzrender 一致）。

用法: python pack.py
"""
import json
import os
from zipfile import ZipFile, ZIP_DEFLATED


def compress_specified_items(output_zip: str, items: list, compress_level: int = 6):
    """自定义压缩指定的 文件/文件夹 列表"""
    with ZipFile(output_zip, "w", ZIP_DEFLATED, compresslevel=compress_level) as zipf:
        for item in items:
            if not os.path.exists(item):
                print(f"警告：{item} 不存在，已跳过")
                continue
            if os.path.isfile(item):
                # 文件直接放到 zip 根目录（如 src/icon.png → icon.png）
                zipf.write(item, arcname=os.path.basename(item))
            elif os.path.isdir(item):
                for root, dirs, files in os.walk(item):
                    for file in files:
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path, os.path.dirname(item))
                        zipf.write(file_path, arcname=arcname)


# 版本号单一来源：package.json 的 version，打包时同步进 info.json 随包发布
with open("package.json", encoding="utf-8") as f:
    VERSION = json.load(f)["version"]

with open("info.json", encoding="utf-8") as f:
    _info = json.load(f)
if _info.get("version") != VERSION:
    _info["version"] = VERSION
    with open("info.json", "w", encoding="utf-8") as f:
        json.dump(_info, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"已同步 info.json 的 version → {VERSION}")

# ====================== 【只需修改这里】 ======================
# 本插件不渲染自有 3D 场景，也没有外部可执行程序：对齐算法在 wasm 里（编译进 dist/assets）。
# MF 构建产物: index.js 是入口，assets/ 是运行时 chunk（含 *.wasm，必须一起打包）。
# icon.png 放 zip 根目录（从 src/icon.png 复制过来），供市场/加载器取用。
TO_COMPRESS = [
    "dist/index.js",         # MF remote 入口
    "dist/assets",           # 运行时 chunk + css + wasm
    "info.json",             # 插件市场元数据（含版本号）
    "src/icon.png",          # 插件图标 → zip 根目录 icon.png
]

OUTPUT = "wmview.overlay.zip"

# 先确认构建产物存在，避免打出空包
for need in ("dist/index.js", "dist/assets"):
    if not os.path.exists(need):
        raise SystemExit(f"缺少构建产物 {need}，请先执行 npm run build")

compress_specified_items(OUTPUT, TO_COMPRESS, compress_level=6)
size = os.path.getsize(OUTPUT) / 1024
print(f"压缩完成: {OUTPUT}（{size:.1f} KB，版本 {VERSION}）")
