<style scoped>
.overlay-root {
  padding: 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.overlay-info {
  font-size: small;
  color: #495057;
}

.overlay-muted {
  color: #adb5bd;
}

.overlay-tip {
  font-size: 12px;
  color: #868e96;
  line-height: 1.4;
}

.overlay-logs {
  display: flex;
  flex-direction: column;
  font-size: small;
  color: #495057;
}

.overlay-atoms {
  font-size: 12px;
  color: #495057;
  word-break: break-all;
}

.overlay-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0;
}

.overlay-option {
  border: 1px solid #e9ecef;
  border-radius: 4px;
  padding: 3px 6px;
  background-color: #f8f9fa;
}

.overlay-option-name {
  font-size: small;
  color: #212529;
  word-break: break-all;
}

.overlay-hint {
  font-size: 12px;
  color: #868e96;
  margin-top: 4px;
}

/* 插件文档入口：蓝色链接样式 + hover 下划线，明确是可点击的文档入口 */
.overlay-doc-link {
  cursor: pointer;
}

.overlay-doc-link:hover {
  text-decoration: underline;
}
</style>


<template>
  <div class="overlay-root">

    <div class="overlay-info">
      <div>参考分子：
        <b v-if="refs.select">{{ refs.select }}</b>
        <span v-else class="overlay-muted">（尚未选择）</span>
      </div>
      <div class="overlay-atoms" v-if="refs.select">
        选中原子：<b v-if="atoms_text(refs.selmap[refs.select]?.idxs)">{{ atoms_text(refs.selmap[refs.select]?.idxs) }}</b>
        <span v-else class="overlay-muted">{{ refs.selmap[refs.select]?.inside ? "（未选择）" : "（不在场景中）" }}</span>
      </div>

      <div style="margin-top: 4px">待调节分子：</div>
      <div class="overlay-options" v-if="refs.option.length">
        <div class="overlay-option" v-for="name in refs.option" :key="name">
          <div class="overlay-option-name">{{ name }}</div>
          <div class="overlay-atoms">
            选中原子：<b v-if="atoms_text(refs.selmap[name]?.idxs)">{{
              atoms_text(refs.selmap[name]?.idxs)
            }}</b>
            <span v-else class="overlay-muted">{{ refs.selmap[name]?.inside ? "（未选择）" : "（未加载）" }}</span>
          </div>
        </div>
      </div>
      <div class="overlay-muted" v-else>（尚未标记）</div>

      <el-button
        size="small"
        style="width: 100%; margin-top: 4px"
        :loading="refs.syncing"
        :disabled="!can_sync_selects || refs.syncing"
        @click="sync_selects"
      >
        同步原子选择到待调节分子
      </el-button>
      <div class="overlay-tip" v-if="!has_set_atom_select">
        宿主缺少 `wmapi_scene.set_atom_select`，无法写入原子选择。
      </div>
    </div>

    <panel-group title="对齐设置">
      <panel-item title="对齐指标">
        <el-radio-group v-model="refs.method">
          <el-radio value="rmsd">RMSD</el-radio>
          <el-radio value="mesd">MESD</el-radio>
        </el-radio-group>
        <div class="overlay-muted" style="font-size: 12px">{{ metric_hint[refs.method] }}</div>
      </panel-item>
    </panel-group>
    <el-button type="primary" :loading="refs.busy" style="width: 100%" @click="align_moles">
      开始对齐
    </el-button>
    <el-button
      :loading="refs.saving"
      :disabled="!can_save || refs.saving"
      style="width: 100%; margin-left: 0"
      @click="save_aligned"
    >
      保存对齐结果（{{ SAVE_SUFFIX }}.gjf）
    </el-button>
    <!-- 文档入口：📄 图标 + 蓝色文字（取与文档正文链接一致的蓝 #1971c2），hover 加下划线 -->
    <el-button
      link
      class="overlay-doc-link"
      style="align-self: flex-start; padding: 0; font-size: 13px; font-weight: 500; color: #1971c2"
      @click="open_docs"
    >
      📄 插件文档
    </el-button>

    <panel-group title="日志">
      <div class="overlay-logs">
        <div v-for="(log, i) in refs.logs" :key="i">{{ log }}</div>
      </div>
    </panel-group>
  </div>
</template>


<script setup lang="ts">
import { ElButton, ElMessage, ElRadioGroup, ElRadio } from "element-plus";
import { computed, onMounted, onUnmounted, ref } from "vue";
import PanelGroup from "./comps/Panel-Group.vue";
import PanelItem from "./comps/Panel-Item.vue";
import { register_docs, DOC_USAGE } from "./doc";
import type {
  wmapi_overlay,
  OverlayAlignResult,
  OverlaySaveResult,
} from "./wmapi_overlay";
// WASM：原 Tauri 工程里由 Rust 实现的对齐能力
import wasmInit, { align as wasmAlign } from "../wasm/pkg/overlay_wasm.js";

// 主程序宿主 API
const cores = window.wmapi_cores;
const files = window.wmapi_files;
const wmscene = window.wmapi_scene;
// 设置原子位置的新 API（mole_name -> 原子索引 -> [x,y,z]）
const editor = window.wmapi_editor;

// set_atom_select / on_atom_select 均为当前主程序已提供的 wmapi_scene API；
// 这里仍做一次运行时探测，宿主版本偏旧时降级（同步按钮禁用 / 退回轮询刷新选择显示）
const set_atom_select = wmscene?.set_atom_select?.bind(wmscene);
const on_atom_select = wmscene?.on_atom_select?.bind(wmscene);
const has_set_atom_select = !!set_atom_select;

const refs = ref({
  // 默认 RMSD：叠合最常用的指标，整体贴合最紧；MESD 是平均绝对距离，对个别原子偏差不敏感
  // （会留个别原子偏出去，看起来“不齐”），需要鲁棒拟合时再切 MESD
  method: "rmsd",
  wasmReady: false,
  busy: false,
  select: "", // 参考分子（get_select，选择的分子）
  refGeom: [] as [string, number, number, number][],
  option: [] as string[], // 需要调节的分子（get_option，多选）
  syncing: false, // 正在把待调节分子加载进场景并同步原子选择
  saving: false, // 正在保存对齐结果
  aligned: [] as string[], // 本次会话里成功对齐过的分子（保存按钮据此决定可保存哪些）
  // 每个分子的选中原子与是否已进入场景（面板逐行显示用）
  selmap: {} as Record<string, { idxs: number[]; inside: boolean }>,
  logs: [] as string[],
});

/** 两个指标的一句话提示（详细原理见「程序文档 → 插件 / overlay / 对齐算法原理」） */
const metric_hint: Record<string, string> = {
  rmsd: "整体贴合最紧（推荐）",
  mesd: "抗离群原子，个别原子可能偏出去",
};

/** 保存文件名后缀：<原名>-overlay.gjf */
const SAVE_SUFFIX = "-overlay";
/** 源文件取不到任务信息时用的默认任务行（日志里会明确提示需要检查） */
const DEFAULT_JOB = "opt freq b3lyp/6-31g";

/** 保存时使用的任务信息（route / 电荷 / 自旋） */
interface SourceHeader {
  job: string;
  charge: number;
  multip: number;
  /** true = 来自源文件；false = 部分或全部用了默认值 */
  exact: boolean;
}

/**
 * 读取源文件的任务信息：.gjf 有任务行 + 电荷/自旋；.log 只有任务行（电荷/自旋退回 0 1）。
 * 取不到返回 null（调用方用默认值并在日志里提示）。
 */
const read_source_header = async (name: string): Promise<SourceHeader | null> => {
  const fileinfo = window.wmapi_fileinfo;
  if (typeof fileinfo?.get_file_info !== "function") return null;
  try {
    const info = (await fileinfo.get_file_info(name)) as unknown as {
      Gjf?: { job?: string; charge?: number; multip?: number };
      Log?: { job?: string };
    };
    if (info?.Gjf?.job) {
      return {
        job: info.Gjf.job,
        charge: info.Gjf.charge ?? 0,
        multip: info.Gjf.multip ?? 1,
        exact: true,
      };
    }
    if (info?.Log?.job) {
      // 高斯 log 里没有电荷/自旋字段，只能退回默认值
      return { job: info.Log.job, charge: 0, multip: 1, exact: false };
    }
  } catch (e) {
    console.warn("读取源文件任务信息失败", name, e);
  }
  return null;
};

/** 由分子几何拼出 GJF 文本（坐标取场景里的 Å，保留 8 位小数） */
const build_gjf = (
  title: string,
  header: SourceHeader,
  geom: [string, number, number, number][]
) => {
  const job = header.job.trim();
  // 源文件的任务行一般自带 #，缺失时补一个 "#p"
  const route = job.startsWith("#") ? job : `#p ${job}`;
  const lines = geom.map(
    ([sym, x, y, z]) =>
      `${sym.padEnd(4)}${x.toFixed(8).padStart(14)}${y.toFixed(8).padStart(14)}${z.toFixed(8).padStart(14)}`
  );
  return `${route}\n\n${title}\n\n${header.charge} ${header.multip}\n${lines.join("\n")}\n\n`;
};

/** 去掉扩展名："a.b.gjf" -> "a.b" */
const strip_ext = (name: string) => {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
};

/**
 * 可保存的分子：优先“本次会话对齐过的分子”，还没有对齐结果时退回“当前待调节分子”，
 * 两者都只要求**仍在场景中**。
 *
 * 不能要求“仍在 option 列表里”：文件列表里单击分子会把它从 option 移出（变成参考分子），
 * 那样换个选择保存按钮就废了；这里以“对齐过”为准，选谁都不影响已对齐的结果。
 */
const save_targets = () => {
  const in_scene = (names: string[]) => names.filter((name) => name && refs.value.selmap[name]?.inside);
  const aligned = in_scene(refs.value.aligned);
  return aligned.length ? aligned : in_scene(refs.value.option);
};

/** 场景里有分子就能保存（有对齐结果存对齐结果，没有就按当前坐标存） */
const can_save = computed(() => save_targets().length > 0);

/**
 * 把对齐结果按当前场景坐标另存为 <原名>-overlay.gjf（写入分子目录）。
 * 任务行/电荷/自旋优先取源文件；取不到时用默认值并在日志里提示。
 * @param suffix 文件名后缀，缺省 "-overlay"
 * @param notify 是否弹提示（面板按钮用 true；脚本 API 调用用 false）
 * @returns 每个分子的保存结果（失败时带着原因）
 */
const save_core = async (suffix = SAVE_SUFFIX, notify = true): Promise<OverlaySaveResult[]> => {
  const results: OverlaySaveResult[] = [];
  const fold = files?.get_moleFold?.() ?? "";
  const targets = save_targets();
  if (!targets.length) {
    if (notify) {
      ElMessage({
        message: "没有可保存的分子：场景里还没有待调节分子（先选好要调节的分子）",
        type: "warning",
      });
    }
    return results;
  }
  if (typeof cores?.save_text !== "function" || !fold) {
    if (notify) ElMessage({ message: "宿主缺少 save_text 或分子目录不可用", type: "error" });
    return results;
  }
  refs.value.saving = true;
  let saved = 0;
  let defaulted = 0;
  let failed = 0;
  try {
    for (const name of targets) {
      const geom = wmscene.get_mole_geom(name);
      if (!geom?.length) {
        failed++;
        add_log(`保存 ${name} 失败：取不到几何`);
        results.push({ name, error: "取不到几何（不在场景中或结构为空）" });
        continue;
      }
      const header = (await read_source_header(name)) ?? {
        job: DEFAULT_JOB,
        charge: 0,
        multip: 1,
        exact: false,
      };
      if (!header.exact) {
        defaulted++;
        add_log(
          `注意 ${name}：源文件取不到完整的任务信息，任务行/电荷/自旋可能用了默认值（${header.job} / ${header.charge} ${header.multip}），请检查`
        );
      }
      const base = strip_ext(name);
      const target_name = `${base}${suffix}.gjf`;
      const aligned_tip = refs.value.aligned.includes(name) ? "" : "（当前坐标，未参与本次对齐）";
      try {
        const path = `${fold}/${target_name}`;
        await cores.save_text(path, build_gjf(`${base}${suffix}`, header, geom));
        add_log(`已保存 ${target_name}（${geom.length} 个原子）${aligned_tip}`);
        results.push({ name, path, from_source: header.exact });
        saved++;
      } catch (e) {
        failed++;
        add_log(`保存 ${target_name} 失败：${String(e)}`);
        results.push({ name, error: String(e) });
      }
    }
  } finally {
    refs.value.saving = false;
  }
  const summary =
    `已保存 ${saved} 个文件到分子目录（文件名加 ${suffix}.gjf）` +
    (defaulted ? `，其中 ${defaulted} 个用了默认任务信息` : "") +
    (failed ? `，${failed} 个失败` : "");
  add_log(summary);
  if (notify) {
    ElMessage({ message: summary, type: saved ? (failed || defaulted ? "warning" : "success") : "error" });
  }
  return results;
};

/** 面板按钮：保存对齐结果（带提示） */
const save_aligned = () => save_core();

/**
 * 脚本 / AI 可调用的插件 API（对应文档见 src/wmapi_overlay.d.ts，会作为插件 apidoc 提供给脚本面板与 AI）。
 * 与面板按钮的区别：不弹提示，只写日志并通过返回值给出结果。
 */
window.wmapi_overlay = {
  align: (method?: "rmsd" | "mesd") => align_core(method, false),
  sync_selects: () => sync_selects_core(false),
  save: (suffix?: string) => save_core(suffix, false),
  get_state: () => ({
    reference: refs.value.select,
    options: [...refs.value.option],
    selects: Object.fromEntries(
      Object.entries(refs.value.selmap).map(([name, state]) => [name, [...state.idxs]])
    ),
    in_scene: Object.fromEntries(
      Object.entries(refs.value.selmap).map(([name, state]) => [name, state.inside])
    ),
    aligned: [...refs.value.aligned],
    method: refs.value.method as "rmsd" | "mesd",
  }),
  set_method: (method: "rmsd" | "mesd") => {
    if (method === "rmsd" || method === "mesd") refs.value.method = method;
  },
} satisfies wmapi_overlay;

/** 选中的原子索引显示成主程序里的原子编号（1 起） */
const atoms_text = (idxs?: number[]) =>
  idxs && idxs.length ? idxs.map((idx) => idx + 1).join(", ") : "";

/** 本插件在侧边栏里的名字（须与 index.ts 的 sider.name 一致），用于判断面板是否正在显示 */
const SIDER_NAME = "overlay";

/** overlay 面板当前是否显示在侧边栏（收起时不必轮询） */
const panel_shown = () => {
  try {
    return cores?.get_show_siders?.().includes(SIDER_NAME) ?? true;
  } catch {
    return true;
  }
};

/**
 * 收到宿主的原子选择变化事件时，只更新对应那一行。
 * 不整体重查：`get_atom_select(name)` 内部走 `Moles.get(name)`，宿主会为每次按名查询打一条 console 日志。
 */
const on_atom_select_changed = (mole_name: string, atms: number[]) => {
  if (!mole_name) return;
  const old = refs.value.selmap[mole_name];
  if (!old) return; // 既不是参考分子也不是待调节分子，面板不显示，忽略
  const idxs = atms?.slice() ?? [];
  if (old.idxs.join(",") === idxs.join(",")) return;
  refs.value.selmap = {
    ...refs.value.selmap,
    [mole_name]: { idxs, inside: true }, // 有选择必然已在场景中
  };
};

const add_log = (text: string) => {
  refs.value.logs.push(text);
  if (refs.value.logs.length > 200) refs.value.logs.shift();
  if (cores) cores.add_logText("overlay", text);
};

/**
 * 打开主程序的「程序文档」面板并定位到本插件的使用说明。
 * 打开前先注册一次（同 path 覆盖，幂等），避免文档还没注册时打开到空面板。
 */
const open_docs = () => {
  if (typeof cores?.show_doc !== "function") {
    ElMessage({
      message: "当前宿主版本不支持 show_doc，请在「程序文档」中查看 插件/overlay",
      type: "warning",
    });
    return;
  }
  try {
    register_docs();
  } catch (e) {
    console.warn("注册插件文档失败", e);
  }
  cores.show_doc(DOC_USAGE);
};

/** 读取参考分子(select)与待调节分子(option)列表（需要 wait_root 后调用） */
const reload = () => {
  if (files) {
    try {
      refs.value.select = files.get_select() ?? "";
      refs.value.option = files.get_option() ?? [];
    } catch (e) {
      console.warn("读取 select/option 失败", e);
    }
  }
};

/**
 * 读取参考分子（select）在场景中的坐标，作为对齐目标。
 * @param warn 是否在“没有参考分子”时弹窗提示；启动/切换选择时的静默刷新传 false
 */
const read_ref = (warn = true) => {
  if (!wmscene) {
    if (warn) add_log("宿主 wmapi_scene 不可用");
    refs.value.refGeom = [];
    return false;
  }
  // 参考分子优先取 get_select()，否则回退到当前显示的分子
  const name = refs.value.select || wmscene.get_mole_name();
  if (!name) {
    if (warn) ElMessage({ message: "请先在主程序里选择一个分子作为参考", type: "warning" });
    refs.value.refGeom = [];
    return false;
  }
  const geom = wmscene.get_mole_geom(name);
  if (!geom?.length) {
    if (warn) ElMessage({ message: "参考分子不在场景中或结构为空", type: "warning" });
    refs.value.refGeom = [];
    return false;
  }
  refs.value.select = name; // 回退时同步 select
  refs.value.refGeom = geom;
  return true;
};

/**
 * 同步文件列表的 select/option、以及各分子选中的原子到面板。
 *
 * 主程序里 option 有三种改法，刷新时机不一样：
 * - Shift 多选 / 单选取消：原地 push/splice，插件拿到的就是 store 数组本身，Vue 响应式即时刷新；
 * - “全选 / 空选”：整表替换（`fileStore.option = [...]`），插件里的旧引用会失效，且主程序没有对应事件
 *   （`on_select` 只在切换显示分子时触发），所以这里定时比对一次兜底。
 * - 原子选择：宿主暂无选择变化事件（`on_atom_select`），同样靠比对刷新。
 * 主程序已提供 `on_option` 事件，onMounted 里会订阅；两者齐全时不再需要轮询。
 * @returns 面板显示的内容是否发生了变化
 */
const sync_state = () => {
  if (!files) return false;
  let select = "";
  let option: string[] = [];
  try {
    select = files.get_select() ?? "";
    option = files.get_option() ?? [];
  } catch (e) {
    console.warn("读取 select/option 失败", e);
    return false;
  }
  const select_changed = select !== refs.value.select;
  const option_changed = option.join("\u0001") !== refs.value.option.join("\u0001");
  if (select_changed) {
    refs.value.select = select;
    read_ref(false);
  }
  if (option_changed) {
    refs.value.option = option; // 存 store 数组本身，原地增删仍即时生效
  }

  // 刷新每个分子的选中原子（宿主暂无选择变化事件时靠这个轮询兜底）
  const names: string[] = [];
  if (refs.value.select) names.push(refs.value.select);
  for (const name of refs.value.option) {
    if (name && !names.includes(name)) names.push(name);
  }
  const old = refs.value.selmap;
  const next: Record<string, { idxs: number[]; inside: boolean }> = {};
  let sel_changed = Object.keys(old).length !== names.length;
  for (const name of names) {
    const idxs = wmscene?.get_atom_select(name) ?? [];
    // 有选中的原子就一定已经在场景里，这时不必再查一次几何（少一次调用，宿主日志也少一半）
    const inside = idxs.length > 0 || (wmscene?.get_mole_geom(name)?.length ?? 0) > 0;
    next[name] = { idxs, inside };
    if ((old[name]?.idxs ?? []).join(",") !== idxs.join(",")) sel_changed = true;
    if (old[name]?.inside !== inside) sel_changed = true;
  }
  if (sel_changed) refs.value.selmap = next;
  return select_changed || option_changed || sel_changed;
};

const to_xyzs = (geom: [string, number, number, number][]) =>
  geom.map(([_sym, x, y, z]) => [x, y, z]);

/** 获取分子参与对齐的原子索引：有选中原子用选中，否则用全部（长度为 natm） */
const get_atom_idxs = (name: string, natm: number) => {
  const sel = wmscene?.get_atom_select(name);
  if (sel && sel.length > 0) return sel;
  return Array.from({ length: natm }, (_v, i) => i);
};

/**
 * 确保分子已加载进宿主场景：不在场景中时用 wmapi_files.load_file(name, false) 静默加载。
 * show=false 只把分子加入场景、不切换当前显示的分子，所以参考分子会一直留在画面上。
 * @returns 场景中的原子几何；加载后仍取不到则返回空数组（调用方据此跳过）
 */
const ensure_in_scene = async (name: string) => {
  let geom = wmscene.get_mole_geom(name);
  if (geom?.length) return geom;
  if (!files || typeof files.load_file !== "function") {
    add_log(`宿主 wmapi_files.load_file 不可用，无法加载 ${name}`);
    return [];
  }
  try {
    await files.load_file(name, false); // 异步：读取分子信息后才加入场景
    add_log(`已加载 ${name}（不显示）`);
  } catch (e) {
    add_log(`加载 ${name} 失败：${String(e)}`);
    return [];
  }
  geom = wmscene.get_mole_geom(name);
  return geom ?? [];
};

/** 参考分子是否已选好原子、且有可写的宿主 API（决定“同步选择”按钮是否可用） */
const can_sync_selects = computed(
  () =>
    has_set_atom_select &&
    !!refs.value.select &&
    (refs.value.selmap[refs.value.select]?.idxs.length ?? 0) > 0 &&
    refs.value.option.some((name) => name !== refs.value.select)
);

/**
 * 一键把参考分子选中的原子同步给所有待调节分子。
 * 还没进场景的分子会先静默加载进场景（load_file(name,false)，不切换当前显示），再写入原子选择，
 * 这样对齐时所有分子用的是同一套原子。
 * @param notify 是否弹提示（面板按钮用 true；脚本 API 调用用 false，只看日志与返回值）
 * @returns 成功写入原子选择的分子名
 */
const sync_selects_core = async (notify = true): Promise<string[]> => {
  const refName = refs.value.select;
  const idxs = wmscene?.get_atom_select(refName) ?? [];
  if (!refName || idxs.length === 0) {
    if (notify) ElMessage({ message: "参考分子还没有选中原子", type: "warning" });
    return [];
  }
  if (!set_atom_select) {
    if (notify) ElMessage({ message: "宿主 wmapi_scene 缺少 set_atom_select", type: "error" });
    return [];
  }
  refs.value.syncing = true;
  const done: string[] = [];
  let failed = 0;
  try {
    for (const name of refs.value.option) {
      if (name === refName) continue;
      // 未进入场景的先加载（不切换当前显示），再写选择
      const geom = await ensure_in_scene(name);
      if (!geom.length) {
        failed++;
        continue;
      }
      set_atom_select(name, idxs);
      done.push(name);
    }
  } catch (e) {
    add_log(`同步原子选择失败：${String(e)}`);
    if (notify) ElMessage({ message: `同步失败: ${String(e)}`, type: "error" });
  } finally {
    refs.value.syncing = false;
  }
  add_log(
    `把 ${refName} 的选中原子(${atoms_text(idxs)}) 同步给 ${done.length} 个待调节分子` +
      (failed ? `，${failed} 个加载失败已跳过` : "")
  );
  if (notify) {
    ElMessage({
      message: `已同步 ${done.length} 个分子${failed ? `，${failed} 个失败` : ""}`,
      type: "success",
    });
  }
  sync_state();
  return done;
};

/** 面板按钮：同步原子选择（带提示） */
const sync_selects = () => sync_selects_core(true);

/**
 * 把待调节分子（get_option）对齐到参考分子（get_select）。
 * 对齐结果通过 wmapi_editor.set_atom_position 写回宿主场景中对应分子的坐标。
 * @param method 对齐指标，缺省用面板当前选择
 * @param notify 是否弹提示（面板按钮用 true；脚本 API 调用用 false）
 * @returns 每个分子的结果（ok=false 时 reason 说明跳过原因）
 */
const align_core = async (
  method?: "rmsd" | "mesd",
  notify = true
): Promise<OverlayAlignResult[]> => {
  const results: OverlayAlignResult[] = [];
  if (!refs.value.wasmReady) {
    if (notify) ElMessage({ message: "WASM 尚未初始化", type: "error" });
    return results;
  }
  if (!read_ref(notify)) return results;

  const refName = refs.value.select;
  const refGeom = refs.value.refGeom;
  const refIdxs = get_atom_idxs(refName, refGeom.length);
  const mole1 = { xyzs: to_xyzs(refGeom), idxs: refIdxs };
  const use_method = method ?? (refs.value.method as "rmsd" | "mesd");

  // 要对齐的分子：wmapi_files.get_option() 返回需要调节的分子（多选）
  let selects: string[] = [];
  if (files) {
    try {
      await files.wait_root();
      selects = files.get_option();
    } catch (e) {
      console.warn("读取 option 分子失败", e);
    }
  }
  if (selects.length === 0) {
    if (notify) ElMessage({ message: "请先在主程序里标记需要调节的分子(option)", type: "warning" });
    return results;
  }

  refs.value.busy = true;
  let done = 0;
  try {
    for (const name of selects) {
      if (name === refName) continue; // 不把参考分子对齐到它自己
      // 未进入场景的分子先加载进场景（不显示），再取几何
      const geom = await ensure_in_scene(name);
      if (!geom?.length) {
        add_log(`跳过 ${name}：未在场景中`);
        results.push({ name, ok: false, reason: "未在场景中（加载失败或结构为空）" });
        continue;
      }
      const xyzs2 = to_xyzs(geom);
      const idxs = get_atom_idxs(name, xyzs2.length);
      if (idxs.length !== refIdxs.length) {
        add_log(
          `跳过 ${name}：与参考分子选中的原子数不一致（可点“同步原子选择到待调节分子”）`
        );
        if (notify) ElMessage({ message: `${name} 与参考分子原子数不一致`, type: "error" });
        results.push({
          name,
          ok: false,
          reason: `与参考分子选中的原子数不一致（本分子 ${idxs.length} 个，参考 ${refIdxs.length} 个）`,
        });
        continue;
      }
      // 数量相同但索引不同时，是在把“参考的第 i 个选中原子”对到“该分子的另一个原子”，结果没有意义
      if (refIdxs.length < xyzs2.length && idxs.join(",") !== refIdxs.join(",")) {
        add_log(
          `注意 ${name}：选中的原子索引与参考分子不一致（参考 [${atoms_text(refIdxs)}] vs 本分子 [${atoms_text(idxs)}]），对齐结果可能没有意义`
        );
      }
      const mole2 = { xyzs: xyzs2, idxs };
      const res = wasmAlign(mole1, mole2, use_method) as {
        xyzs: number[][];
        err: number;
      };
      const xyzs = res.xyzs;
      const err = res.err;
      // 通过 wmapi_editor.set_atom_position 写回宿主场景，让分子真正移动
      if (editor) {
        const positions: Record<number, [number, number, number]> = {};
        for (let i = 0; i < xyzs.length; i++) {
          positions[i] = [xyzs[i][0], xyzs[i][1], xyzs[i][2]];
        }
        editor.set_atom_position(name, positions);
      } else {
        add_log(`警告：宿主 wmapi_editor 不可用，无法写回坐标`);
      }
      add_log(`${name} -> ${refName},${use_method}(avg):${err.toFixed(4)}`);
      if (notify) ElMessage({ message: `${name} 对齐到 ${refName} 完成`, type: "success" });
      // 记录已对齐的分子：保存按钮只保存这些
      if (!refs.value.aligned.includes(name)) refs.value.aligned.push(name);
      results.push({ name, ok: true, err, atoms: refIdxs.length });
      done++;
    }
    if (done > 0) {
      add_log(`对齐完成，共 ${done} 个分子`);
      if (notify) ElMessage({ message: `已对齐 ${done} 个分子`, type: "success" });
    }
  } catch (e) {
    console.error("对齐失败", e);
    if (notify) ElMessage({ message: `对齐失败: ${String(e)}`, type: "error" });
  } finally {
    refs.value.busy = false;
  }
  return results;
};

/** 面板按钮：开始对齐 */
const align_moles = () => align_core(undefined, true);

onMounted(() => {
  // 兜底注册文档：插件模块加载时宿主 wmapi_cores 可能还没就绪（同 path 覆盖，重复调用无副作用）
  try {
    register_docs();
  } catch (e) {
    console.warn("注册插件文档失败", e);
  }

  // 多选(option)变化：优先用主程序的 on_option 事件；老版本宿主没有该 API 时退回定时比对
  // （“全选/空选”是整表替换，光靠 Vue 响应式追不到）
  let has_option_event = false;
  if (files && typeof files.on_option === "function") {
    try {
      files.on_option(() => sync_state());
      has_option_event = true;
    } catch (e) {
      console.warn("注册 on_option 监听失败", e);
    }
  }

  // 原子选择变化：宿主提供 on_atom_select 时只按事件增量更新对应那一行，不再轮询刷新
  let has_select_event = false;
  if (on_atom_select) {
    try {
      on_atom_select(on_atom_select_changed);
      has_select_event = true;
    } catch (e) {
      console.warn("注册 on_atom_select 监听失败", e);
    }
  }

  if (files && (!has_option_event || !has_select_event)) {
    // 轮询只用来兜底“原子选择”的显示：面板收起时跳过，间隔放宽到 1s，
    // 避免宿主 console 被 Moles.get() 的“根据名称获取分子”日志刷屏
    const option_timer = window.setInterval(() => {
      if (!panel_shown()) return;
      sync_state();
    }, 1000);
    onUnmounted(() => window.clearInterval(option_timer));
  }

  // 监听文件列表选择(select)变化：选中的就是参考分子，用它实时刷新参考分子与 option（不弹窗）
  try {
    files?.on_select((name: string) => {
      sync_state(); // 会同步 select/option 与逐行显示的选中原子，并在 select 变化时重读参考分子几何
    });
  } catch (e) {
    console.warn("注册 on_select 监听失败", e);
  }

  wasmInit()
    .then(async () => {
      refs.value.wasmReady = true;
      // 进入面板时读参考分子(select)与待调节分子(option)
      try {
        await files?.wait_root();
      } catch (e) {
        console.warn("wait_root 失败", e);
      }
      reload();
      // 进入面板时静默读取参考分子，不弹“请先选择参考分子”提示
      read_ref(false);
      sync_state(); // 立刻填充逐行显示的选中原子（不必等轮询）
      add_log("WASM 就绪，请点击“开始对齐”把 option 分子对齐到参考分子");
    })
    .catch((e) => {
      console.error("WASM 初始化失败", e);
      ElMessage({ message: "WASM 模块加载失败", type: "error" });
    });
});
</script>
