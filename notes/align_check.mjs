// 对齐算法对照脚本（不参与插件构建，仅用于复验 wasm/src/lib.rs 的 align()）
//
// 用法：node notes/align_check.mjs
// 内容：把 lib.rs 里的逐轴贪心下降算法照抄成 JS，与 Kabsch/Horn 闭式最优刚体叠合对比：
//   1) 同构型整体旋转/平移 —— 双方都应到 0；
//   2) 不同构型全原子对齐 —— 看贪心是否收敛到最优；
//   3) 只用部分原子对齐；
//   4) 坐标远离原点；
//   5) 400 组随机用例压力测试（记录 rmsd 模式未达最优的次数）。

// ---------- 插件现有算法（照抄 lib.rs 的逻辑） ----------
const rotMat = (dir, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  if (dir === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (dir === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
};
const matVec = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const rotat = (pts, dir, ang) => {
  const m = rotMat(dir, ang);
  return pts.map((v) => matVec(m, v));
};
const shift = (pts, dir, val) => pts.map((v) => {
  const w = v.slice();
  w[{ x: 0, y: 1, z: 2 }[dir]] += val;
  return w;
});
const mesd = (a, b, i1, i2) => {
  let sum = 0;
  for (let i = 0; i < i1.length; i++) {
    const p = a[i1[i]], q = b[i2[i]];
    sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }
  return sum / i1.length;
};
const rmsd = (a, b, i1, i2) => {
  let sum = 0;
  for (let i = 0; i < i1.length; i++) {
    const p = a[i1[i]], q = b[i2[i]];
    sum += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  }
  return Math.sqrt(sum / i1.length);
};
const pluginAlign = (xyzs1, xyzs2, idxs1, idxs2, method) => {
  const dirs = ["x", "y", "z"], angs = [-1, 1], vals = [-2, 2];
  let step = 0.1, minErr = Number.MAX_VALUE, opt = xyzs2.map((v) => v.slice());
  for (let it = 0; it < 300; it++) {
    let newErr = minErr;
    const err = (pts) => (method === "mesd" ? mesd(xyzs1, pts, idxs1, idxs2) : rmsd(xyzs1, pts, idxs1, idxs2));
    for (const dir of dirs) {
      for (const ang of angs) {
        const cand = rotat(opt, dir, ang * step);
        const e = err(cand);
        if (e < newErr) { newErr = e; opt = cand; }
      }
      for (const val of vals) {
        const cand = shift(opt, dir, val * step);
        const e = err(cand);
        if (e < newErr) { newErr = e; opt = cand; }
      }
    }
    if (Math.abs(minErr - newErr) < 1e-10) {
      if (step < 1e-8) { minErr = newErr; break; }
      step *= 0.5;
    }
    minErr = newErr;
  }
  return { xyzs: opt, err: minErr };
};

// ---------- Kabsch / Horn 四元数法（RMSD 的全局最优解） ----------
const centroid = (pts, idxs) => {
  const c = [0, 0, 0];
  for (const i of idxs) for (let k = 0; k < 3; k++) c[k] += pts[i][k];
  return c.map((v) => v / idxs.length);
};
const kabsch = (xyzs1, xyzs2, idxs1, idxs2) => {
  const c1 = centroid(xyzs1, idxs1), c2 = centroid(xyzs2, idxs2);
  const P = idxs1.map((i) => xyzs1[i].map((v, k) => v - c1[k]));
  const Q = idxs2.map((i) => xyzs2[i].map((v, k) => v - c2[k]));
  // 相关矩阵 R = sum Q_i P_i^T
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let n = 0; n < P.length; n++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i][j] += Q[n][i] * P[n][j];
  const [[Rxx, Rxy, Rxz], [Ryx, Ryy, Ryz], [Rzx, Rzy, Rzz]] = R;
  const K = [
    [Rxx + Ryy + Rzz, Ryz - Rzy, Rzx - Rxz, Rxy - Ryx],
    [Ryz - Rzy, Rxx - Ryy - Rzz, Rxy + Ryx, Rzx + Rxz],
    [Rzx - Rxz, Rxy + Ryx, -Rxx + Ryy - Rzz, Ryz + Rzy],
    [Rxy - Ryx, Rzx + Rxz, Ryz + Rzy, -Rxx - Ryy + Rzz],
  ];
  // Jacobi 特征分解（4x4 对称阵）取最大特征值对应的特征向量（四元数）
  // 幂迭代在对称分子（特征值重根）上会不收敛，所以这里用 Jacobi
  const A = K.map((row) => row.slice());
  let V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q2 = p + 1; q2 < 4; q2++) off += A[p][q2] * A[p][q2];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) {
      for (let q2 = p + 1; q2 < 4; q2++) {
        if (Math.abs(A[p][q2]) < 1e-18) continue;
        const theta = (A[q2][q2] - A[p][p]) / (2 * A[p][q2]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = A[k][p], akq = A[k][q2];
          A[k][p] = c * akp - s * akq;
          A[k][q2] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = A[p][k], aqk = A[q2][k];
          A[p][k] = c * apk - s * aqk;
          A[q2][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k][p], vkq = V[k][q2];
          V[k][p] = c * vkp - s * vkq;
          V[k][q2] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (A[i][i] > A[best][best]) best = i;
  let q = [V[0][best], V[1][best], V[2][best], V[3][best]];
  const qn = Math.hypot(...q);
  q = q.map((v) => v / qn);
  const [w, x, y, z] = q;
  const rot = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const moved = xyzs2.map((v) => {
    const d = [v[0] - c2[0], v[1] - c2[1], v[2] - c2[2]];
    const r = matVec(rot, d);
    return [r[0] + c1[0], r[1] + c1[1], r[2] + c1[2]];
  });
  return { xyzs: moved, rmsd: rmsd(xyzs1, moved, idxs1, idxs2), mesd: mesd(xyzs1, moved, idxs1, idxs2) };
};

// ---------- 造点：一个苯环 + 取代基的近似坐标 ----------
const ring = [];
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  ring.push([1.4 * Math.cos(a), 1.4 * Math.sin(a), 0]);
}
const subst = [[2.8, 0, 0], [4.1, 0.3, 0.2], [-2.8, 0, 0], [-4.1, -0.3, -0.2], [0, 0, 1.1]];
const base = ring.concat(subst, ring.map((p) => [p[0], p[1], 0.9])); // 17 个原子，带一点三维结构

const rotAxis = [0.3, -0.8, 0.52];
const axisLen = Math.hypot(...rotAxis);
const axis = rotAxis.map((v) => v / axisLen);
const angle = (deg) => (deg * Math.PI) / 180;
// 罗德里格斯旋转
const rotateAbout = (pts, axis, ang) => {
  const [ux, uy, uz] = axis, c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y, z]) => {
    const dot = ux * x + uy * y + uz * z;
    return [
      x * c + (uy * z - uz * y) * s + ux * dot * (1 - c),
      y * c + (uz * x - ux * z) * s + uy * dot * (1 - c),
      z * c + (ux * y - uy * x) * s + uz * dot * (1 - c),
    ];
  });
};

const allIdx = base.map((_, i) => i);

// 自检：已知刚体变换应当被完全恢复（RMSD≈0），用于验证 Kabsch 参考实现本身没问题
{
  const X = [[0.3, 1.2, -0.7], [1.1, -0.4, 2.0], [-1.3, 0.9, 0.5], [0.8, 2.2, -1.4], [2.1, -1.7, 0.3], [-0.6, -2.3, 1.8]];
  const Y = rotateAbout(X, axis, 1.1).map((p) => [p[0] + 2, p[1] - 1, p[2] + 3]);
  const id = X.map((_, i) => i);
  console.log(`[自检] Kabsch 恢复已知刚体变换 RMSD = ${kabsch(X, Y, id, id).rmsd.toFixed(6)}`);
}
const run = (deg, offset) => {
  const moved = rotateAbout(base, axis, angle(deg)).map((p) => [p[0] + offset, p[1] - offset * 0.4, p[2] + offset * 0.7]);
  const opt = kabsch(base, moved, allIdx, allIdx);
  const pM = pluginAlign(base, moved, allIdx, allIdx, "mesd");
  const pR = pluginAlign(base, moved, allIdx, allIdx, "rmsd");
  const before = rmsd(base, moved, allIdx, allIdx);
  console.log(`\n--- 初始旋转 ${deg}°，平移 ${offset} Å ---`);
  console.log(`对齐前 RMSD            : ${before.toFixed(4)}`);
  console.log(`Kabsch(理论最优) RMSD  : ${opt.rmsd.toFixed(4)}   (MESD ${opt.mesd.toFixed(4)})`);
  console.log(`插件 mesd 模式 RMSD    : ${rmsd(base, pM.xyzs, allIdx, allIdx).toFixed(4)}   (它报告的 err=${pM.err.toFixed(4)})`);
  console.log(`插件 rmsd 模式 RMSD    : ${rmsd(base, pR.xyzs, allIdx, allIdx).toFixed(4)}   (它报告的 err=${pR.err.toFixed(4)})`);
};

run(5, 0);
run(30, 0);
run(90, 0);
run(150, 3);
run(180, 6);

// ---------- 更贴近真实使用：构型不同 / 只对齐部分原子 / 坐标远离原点 ----------
const conformer = (deg) => {
  // 把取代基那 5 个原子绕 z 轴转一点，模拟不同构象（键长键角基本一致，只是扭转不同）
  const out = base.map((p) => p.slice());
  for (let i = 6; i < 11; i++) {
    const a = angle(deg), c = Math.cos(a), s = Math.sin(a);
    out[i] = [out[i][0] * c - out[i][1] * s, out[i][0] * s + out[i][1] * c, out[i][2]];
  }
  return out;
};

const compare = (title, mol1, mol2, idxs1, idxs2) => {
  const opt = kabsch(mol1, mol2, idxs1, idxs2);
  const pM = pluginAlign(mol1, mol2, idxs1, idxs2, "mesd");
  const pR = pluginAlign(mol1, mol2, idxs1, idxs2, "rmsd");
  const rM = rmsd(mol1, pM.xyzs, idxs1, idxs2), rR = rmsd(mol1, pR.xyzs, idxs1, idxs2);
  const mPlugin = mesd(mol1, pM.xyzs, idxs1, idxs2), mKabsch = mesd(mol1, opt.xyzs, idxs1, idxs2);
  const maxDev = (pts) => Math.max(...idxs1.map((i, n) => Math.hypot(
    mol1[i][0] - pts[idxs2[n]][0], mol1[i][1] - pts[idxs2[n]][1], mol1[i][2] - pts[idxs2[n]][2])));
  console.log(`\n--- ${title} ---`);
  console.log(`用 ${idxs1.length} 个原子对齐`);
  console.log(`Kabsch 最优   : RMSD ${opt.rmsd.toFixed(4)}  MESD ${opt.mesd.toFixed(4)}  最大偏差 ${maxDev(opt.xyzs).toFixed(3)}`);
  console.log(`插件 rmsd 模式: RMSD ${rR.toFixed(4)}  MESD ${mesd(mol1, pR.xyzs, idxs1, idxs2).toFixed(4)}  最大偏差 ${maxDev(pR.xyzs).toFixed(3)}`);
  console.log(`插件 mesd 模式: RMSD ${rM.toFixed(4)}  MESD ${mPlugin.toFixed(4)}  最大偏差 ${maxDev(pM.xyzs).toFixed(3)}`);
};

// 1) 同一构型、整体刚体变换（应该能对齐）
compare("同一构型 + 整体旋转 120°/平移 4Å", base,
  rotateAbout(base, axis, angle(120)).map((p) => [p[0] + 4, p[1] - 1, p[2] + 2]), allIdx, allIdx);

// 2) 构型不同（取代基扭转 40°），全原子对齐
const conf = conformer(40);
compare("构型不同（扭转40°）+ 整体旋转 100°", base,
  rotateAbout(conf, axis, angle(100)).map((p) => [p[0] + 3, p[1] + 2, p[2] - 1]), allIdx, allIdx);

// 3) 构型不同，只对齐苯环那 6 个原子
compare("构型不同，只用苯环 6 个原子对齐", base,
  rotateAbout(conf, axis, angle(100)).map((p) => [p[0] + 3, p[1] + 2, p[2] - 1]),
  [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5]);

// 4) 坐标远离原点（分子整体平移 20Å 后再旋转）
compare("坐标远离原点（+20Å 后再旋转 90°）", base,
  rotateAbout(base.map((p) => [p[0] + 20, p[1] + 0, p[2] + 0]), axis, angle(90)), allIdx, allIdx);

// ---------- 随机压力测试：插件 rmsd/mesd 收敛结果 vs 理论最优 ----------
let seed = 20260924;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let worstR = 0, worstM = 0, nR = 0, nM = 0, caseR = null, caseM = null;
let sumDevM = 0, sumDevR = 0, sumDevOpt = 0, worstDevM = 0, caseDevM = null;
let stalls = 0, stallGain = 0;
for (let t = 0; t < 400; t++) {
  const n = 6 + Math.floor(rnd() * 14);
  const mol1 = [];
  for (let i = 0; i < n; i++) mol1.push([(rnd() - 0.5) * 6, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6]);
  const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const al = Math.hypot(...ax) || 1;
  const deg = rnd() * 180;
  // 变形 + 刚体变换，模拟“不同构象”
  const mol2raw = mol1.map((p) => [p[0] + (rnd() - 0.5) * 0.6, p[1] + (rnd() - 0.5) * 0.6, p[2] + (rnd() - 0.5) * 0.6]);
  // 注意：平移必须是“整分子一个”，写在 map 里逐原子随机会把分子打散（之前就踩过这个坑）
  const [tx, ty, tz] = [(rnd() - 0.5) * 10, (rnd() - 0.5) * 10, (rnd() - 0.5) * 10];
  const mol2 = rotateAbout(mol2raw, ax.map((v) => v / al), angle(deg)).map((p) => [p[0] + tx, p[1] + ty, p[2] + tz]);
  // 一半的用例只用部分原子对齐
  let idxs = mol1.map((_, i) => i);
  if (t % 2 === 1 && n > 6) idxs = idxs.filter(() => rnd() < 0.6);
  const opt = kabsch(mol1, mol2, idxs, idxs);
  const pR = pluginAlign(mol1, mol2, idxs, idxs, "rmsd");
  const pM = pluginAlign(mol1, mol2, idxs, idxs, "mesd");
  const gapR = rmsd(mol1, pR.xyzs, idxs, idxs) - opt.rmsd;
  const gapM = mesd(mol1, pM.xyzs, idxs, idxs) - opt.mesd;
  if (t < 3) {
    console.log(`  [debug t=${t}] n=${n} deg=${deg.toFixed(1)} idxs=${idxs.length} 对齐前 ${rmsd(mol1, mol2, idxs, idxs).toFixed(3)} 最优 ${opt.rmsd.toFixed(4)} 插件 ${rmsd(mol1, pR.xyzs, idxs, idxs).toFixed(4)}`);
    console.log(`     变形后(未做刚体变换)目标残差 ${rmsd(mol1, mol2raw, idxs, idxs).toFixed(3)}（这就是刚体对齐能达到的最优值）`);
  }
  const maxDev = (pts) => Math.max(...idxs.map((i, n2) => Math.hypot(
    mol1[i][0] - pts[idxs[n2]][0], mol1[i][1] - pts[idxs[n2]][1], mol1[i][2] - pts[idxs[n2]][2])));
  const dM = maxDev(pM.xyzs), dR = maxDev(pR.xyzs), dOpt = maxDev(opt.xyzs);
  sumDevM += dM; sumDevR += dR; sumDevOpt += dOpt;
  if (dM > worstDevM) {
    worstDevM = dM;
    caseDevM = { n, deg: deg.toFixed(1), idxs: idxs.length, rmsdGot: rmsd(mol1, pM.xyzs, idxs, idxs), rmsdOpt: opt.rmsd };
  }
  // mesd 模式用 Kabsch 解做初值再细化，检验“从零开始的贪心”是否卡在更差的局部解
  const pMSeeded = pluginAlign(mol1, opt.xyzs, idxs, idxs, "mesd");
  const mesdScratch = mesd(mol1, pM.xyzs, idxs, idxs);
  const mesdSeeded = mesd(mol1, pMSeeded.xyzs, idxs, idxs);
  if (mesdScratch > mesdSeeded + 1e-9) { stalls++; stallGain += mesdScratch - mesdSeeded; }
  if (gapR > worstR) { worstR = gapR; caseR = { n, deg: deg.toFixed(1), idxs: idxs.length, opt: opt.rmsd, got: rmsd(mol1, pR.xyzs, idxs, idxs) }; }
  if (gapM > worstM) { worstM = gapM; caseM = { n, deg: deg.toFixed(1), idxs: idxs.length, opt: opt.mesd, got: mesd(mol1, pM.xyzs, idxs, idxs) }; }
  if (gapR > 1e-6) nR++;
  if (gapM > 1e-6) nM++;
}
console.log("\n=== 随机压力测试（400 组：随机分子 + 随机旋转 0~180° + 位移 + 变形 0.6Å；一半只用部分原子）===");
console.log(`rmsd 模式没到理论最优的次数: ${nR}/400，最大差距 RMSD +${worstR.toFixed(5)}`);
console.log(`  最差用例: 原子数 ${caseR.n}, 旋转 ${caseR.deg}°, 对齐原子 ${caseR.idxs} 个, 最优 ${caseR.opt.toFixed(4)} → 插件 ${caseR.got.toFixed(4)}`);
console.log(`mesd 模式相对“RMSD最优解”的 MESD 差距最大: +${worstM.toFixed(5)}（mesd 目标本身与 RMSD 最优解不同，单独看）`);
console.log(`平均“最大单原子偏差”: rmsd 模式 ${(sumDevR / 400).toFixed(3)} Å | mesd 模式 ${(sumDevM / 400).toFixed(3)} Å | 理论最优 ${(sumDevOpt / 400).toFixed(3)} Å`);
console.log(`mesd 模式最坏的单原子偏差: ${worstDevM.toFixed(3)} Å`);
if (caseDevM) {
  console.log(`  （最坏用例：${caseDevM.n} 原子 / 旋转 ${caseDevM.deg}° / 对齐 ${caseDevM.idxs} 个；mesd 模式 RMSD ${caseDevM.rmsdGot.toFixed(3)} vs 最优 ${caseDevM.rmsdOpt.toFixed(3)}）`);
}
console.log(`mesd 模式“从零开始贪心”卡在更差局部解的次数: ${stalls}/400（平均 MESD 差 ${(stalls ? stallGain / stalls : 0).toFixed(4)}）`);

// ---------- 用真实编译的 wasm 校验（wasm/pkg 存在时） ----------
try {
  const { readFile } = await import("node:fs/promises");
  const wasmJs = new URL("../wasm/pkg/overlay_wasm.js", import.meta.url);
  const mod = await import(wasmJs.href);
  await mod.default(await readFile(new URL("../wasm/pkg/overlay_wasm_bg.wasm", import.meta.url)));

  let seed2 = 987654321;
  const rnd2 = () => ((seed2 = (seed2 * 48271) % 2147483647) / 2147483647);
  let rmsdMismatch = 0, worstRmsdGap = 0, mesdWorse = 0, mesdBetter = 0, mesdSame = 0, worstMesdGap = 0;
  for (let t = 0; t < 200; t++) {
    const n = 6 + Math.floor(rnd2() * 14);
    const mol1 = [];
    for (let i = 0; i < n; i++) mol1.push([(rnd2() - 0.5) * 6, (rnd2() - 0.5) * 6, (rnd2() - 0.5) * 6]);
    const ax = [rnd2() - 0.5, rnd2() - 0.5, rnd2() - 0.5];
    const al = Math.hypot(...ax) || 1;
    const axn = ax.map((v) => v / al);
    const deg = rnd2() * 180;
    const deformed = mol1.map((p) => [p[0] + (rnd2() - 0.5) * 0.6, p[1] + (rnd2() - 0.5) * 0.6, p[2] + (rnd2() - 0.5) * 0.6]);
    const [tx, ty, tz] = [(rnd2() - 0.5) * 10, (rnd2() - 0.5) * 10, (rnd2() - 0.5) * 10];
    const mol2 = rotateAbout(deformed, axn, angle(deg)).map((p) => [p[0] + tx, p[1] + ty, p[2] + tz]);
    const idxs = t % 2 === 1 && n > 6 ? mol1.map((_, i) => i).filter(() => rnd2() < 0.6) : mol1.map((_, i) => i);
    const m1 = { xyzs: mol1, idxs };
    const m2 = { xyzs: mol2, idxs };

    const gotR = mod.align(m1, m2, "rmsd");
    const opt = kabsch(mol1, mol2, idxs, idxs);
    const gapR = Math.abs(gotR.err - opt.rmsd);
    if (gapR > 1e-6) rmsdMismatch++;
    if (gapR > worstRmsdGap) worstRmsdGap = gapR;

    const gotM = mod.align(m1, m2, "mesd");
    const oldM = pluginAlign(mol1, mol2, idxs, idxs, "mesd"); // 改动前的算法（从零开始贪心）
    const newMesd = gotM.err, oldMesd = oldM.err;
    if (newMesd > oldMesd + 1e-9) { mesdWorse++; worstMesdGap = Math.max(worstMesdGap, newMesd - oldMesd); }
    else if (newMesd < oldMesd - 1e-9) mesdBetter++;
    else mesdSame++;
  }
  console.log("\n=== 真实 wasm（wasm/pkg）校验：200 组 ===");
  console.log(`rmsd 结果与理论最优不一致的次数: ${rmsdMismatch}/200（最大差 ${worstRmsdGap.toExponential(2)}）`);
  console.log(`mesd 结果 vs 改动前“从零贪心”: 更差 ${mesdWorse} | 相同 ${mesdSame} | 更好 ${mesdBetter}（更差情形最大差 ${worstMesdGap.toExponential(2)}）`);
} catch (e) {
  console.log(`\n（未能加载 wasm/pkg 做真实校验，跳过：${e.message}）`);
}
