//! overlay-wasm
//!
//! 由原 Tauri 工程的 Rust 逻辑迁移到浏览器(WASM)后的核心实现：
//!
//! - `read_gjf`：解析 gjf / xyz 文本，返回原子符号与坐标
//! - `align`：把第二组分子旋转/平移到与第一组(参考分子)最接近，返回优化后的坐标与误差
//! - `save_xyz`：把多个分子拼成 xyz 文本
//!
//! 原实现见 `D:\code\overlay\src-tauri\src\{read,maths,lib}.rs`。

use serde::{Deserialize, Serialize};
use serde_wasm_bindgen::to_value;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
pub struct MoleJs {
    /// 每个原子的符号
    pub syms: Vec<String>,
    /// 每个原子的坐标 [x, y, z]
    pub xyzs: Vec<Vec<f64>>,
}

/// (符号, [x, y, z]) 的解析结果，与前端约定对齐
#[derive(Serialize, Deserialize)]
struct ParsedMole {
    syms: Vec<String>,
    xyzs: Vec<Vec<f64>>,
}

/// 对齐用：参考分子/被对齐分子 (idxs + xyzs)
#[derive(Serialize, Deserialize)]
pub struct AlignMole {
    pub idxs: Vec<u32>,
    pub xyzs: Vec<Vec<f64>>,
}

#[derive(Serialize, Deserialize)]
struct AlignResult {
    xyzs: Vec<Vec<f64>>,
    err: f64,
}

// ---------------------------------------------------------------------------
// 读取 gjf / xyz
// ---------------------------------------------------------------------------

/// 解析 gjf / xyz 文本中形如 `  C          1.234       2.345       3.456` 的行。
/// 忽略空行、注释、`$end` 等噪音行，仅取匹配"符号 + 三个数值"的行。
#[wasm_bindgen(js_name = readGjf)]
pub fn read_gjf(text: &str) -> Result<JsValue, JsValue> {
    let mut syms = Vec::new();
    let mut xyzs: Vec<Vec<f64>> = Vec::new();

    for line in text.lines() {
        // 去掉行首/行尾空白后再匹配
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        // 期望 [符号, x, y, z]，至少 4 个 token
        if tokens.len() < 4 {
            continue;
        }
        let sym = tokens[0];
        // 符号一般是字母开头，可带数字(如 H1)，但不要拿纯数字行(键长/电荷等)当原子
        if !sym
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
        {
            continue;
        }
        let x = match tokens[1].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let y = match tokens[2].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let z = match tokens[3].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        syms.push(sym.to_string());
        xyzs.push(vec![x, y, z]);
    }

    let parsed = ParsedMole { syms, xyzs };
    to_value(&parsed).map_err(|e| JsValue::from_str(&e.to_string()))
}

// ---------------------------------------------------------------------------
// 对齐（旋转 / 平移，最小化 MESD 或 RMSD）
// ---------------------------------------------------------------------------

/// 绕 x / y / z 旋转的矩阵
fn get_mat_rx(ang: f64) -> [[f64; 3]; 3] {
    [
        [1.0, 0.0, 0.0],
        [0.0, ang.cos(), -ang.sin()],
        [0.0, ang.sin(), ang.cos()],
    ]
}

fn get_mat_ry(ang: f64) -> [[f64; 3]; 3] {
    [
        [ang.cos(), 0.0, ang.sin()],
        [0.0, 1.0, 0.0],
        [-ang.sin(), 0.0, ang.cos()],
    ]
}

fn get_mat_rz(ang: f64) -> [[f64; 3]; 3] {
    [
        [ang.cos(), -ang.sin(), 0.0],
        [ang.sin(), ang.cos(), 0.0],
        [0.0, 0.0, 1.0],
    ]
}

fn mat_mul_vec(mat: [[f64; 3]; 3], vec: [f64; 3]) -> [f64; 3] {
    let mut result = [0.0; 3];
    for i in 0..3 {
        for j in 0..3 {
            result[i] += mat[i][j] * vec[j];
        }
    }
    result
}

fn rotat(dir: &str, ang: f64, xyzs: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mat = match dir {
        "x" => get_mat_rx(ang),
        "y" => get_mat_ry(ang),
        "z" => get_mat_rz(ang),
        _ => panic!("旋转轴只能是x、y或z"),
    };
    xyzs.iter().map(|v| mat_mul_vec(mat, *v)).collect()
}

fn shift(dir: &str, val: f64, xyzs: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut shifted = xyzs.to_vec();
    for v in shifted.iter_mut() {
        match dir {
            "x" => v[0] += val,
            "y" => v[1] += val,
            "z" => v[2] += val,
            _ => panic!("平移轴只能是x、y或z"),
        }
    }
    shifted
}

/// 平均绝对距离
fn mesd(xyzs1: &[[f64; 3]], xyzs2: &[[f64; 3]], idxs1: &[u32], idxs2: &[u32]) -> f64 {
    let n = idxs1.len();
    let mut sum = 0.0;
    for i in 0..n {
        let idx1 = idxs1[i] as usize;
        let idx2 = idxs2[i] as usize;
        let dx = xyzs1[idx1][0] - xyzs2[idx2][0];
        let dy = xyzs1[idx1][1] - xyzs2[idx2][1];
        let dz = xyzs1[idx1][2] - xyzs2[idx2][2];
        sum += (dx * dx + dy * dy + dz * dz).sqrt();
    }
    sum / n as f64
}

/// 均方根偏差
fn rmsd(xyzs1: &[[f64; 3]], xyzs2: &[[f64; 3]], idxs1: &[u32], idxs2: &[u32]) -> f64 {
    let n = idxs1.len();
    let mut sum = 0.0;
    for i in 0..n {
        let idx1 = idxs1[i] as usize;
        let idx2 = idxs2[i] as usize;
        let dx = xyzs1[idx1][0] - xyzs2[idx2][0];
        let dy = xyzs1[idx1][1] - xyzs2[idx2][1];
        let dz = xyzs1[idx1][2] - xyzs2[idx2][2];
        sum += dx * dx + dy * dy + dz * dz;
    }
    (sum / n as f64).sqrt()
}

fn vec2_to_xyz(xyzs: &[Vec<f64>]) -> Vec<[f64; 3]> {
    xyzs.iter().map(|v| [v[0], v[1], v[2]]).collect()
}

fn xyz_to_vec2(xyzs: &[[f64; 3]]) -> Vec<Vec<f64>> {
    xyzs.iter().map(|v| vec![v[0], v[1], v[2]]).collect()
}

/// 选中原子的质心
fn centroid(xyzs: &[[f64; 3]], idxs: &[u32]) -> [f64; 3] {
    let mut c = [0.0; 3];
    for idx in idxs {
        let p = xyzs[*idx as usize];
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
    }
    let n = idxs.len() as f64;
    [c[0] / n, c[1] / n, c[2] / n]
}

/// 4x4 对称阵的最大特征值对应的特征向量（Jacobi 旋转）。
/// 幂迭代在对称分子（特征值重根，如苯环）上不收敛，所以这里用 Jacobi。
fn largest_eigenvector_4x4(mat: &[[f64; 4]; 4]) -> [f64; 4] {
    let mut a = *mat;
    let mut v = [[0.0f64; 4]; 4];
    for i in 0..4 {
        v[i][i] = 1.0;
    }
    for _sweep in 0..100 {
        let mut off = 0.0;
        for p in 0..4 {
            for q in (p + 1)..4 {
                off += a[p][q] * a[p][q];
            }
        }
        if off < 1e-24 {
            break;
        }
        for p in 0..4 {
            for q in (p + 1)..4 {
                if a[p][q].abs() < 1e-18 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = if theta >= 0.0 {
                    1.0 / (theta + (theta * theta + 1.0).sqrt())
                } else {
                    -1.0 / (-theta + (theta * theta + 1.0).sqrt())
                };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..4 {
                    let akp = a[k][p];
                    let akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..4 {
                    let apk = a[p][k];
                    let aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for k in 0..4 {
                    let vkp = v[k][p];
                    let vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut best = 0;
    for i in 1..4 {
        if a[i][i] > a[best][best] {
            best = i;
        }
    }
    let mut q = [v[0][best], v[1][best], v[2][best], v[3][best]];
    let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if norm > 0.0 {
        for val in q.iter_mut() {
            *val /= norm;
        }
    }
    q
}

/// 四元数(w,x,y,z) -> 旋转矩阵
fn quat_to_mat(q: [f64; 4]) -> [[f64; 3]; 3] {
    let [w, x, y, z] = q;
    [
        [
            w * w + x * x - y * y - z * z,
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            w * w - x * x + y * y - z * z,
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            w * w - x * x - y * y + z * z,
        ],
    ]
}

/// Kabsch / Horn 闭式解：求把 xyzs2 叠合到 xyzs1 的最优刚体变换（让选中原子的 RMSD 最小）。
/// 结果作用在**全部**原子上（质心对齐到 xyzs1 的选中质心）。
fn kabsch(xyzs1: &[[f64; 3]], xyzs2: &[[f64; 3]], idxs1: &[u32], idxs2: &[u32]) -> Vec<[f64; 3]> {
    let c1 = centroid(xyzs1, idxs1);
    let c2 = centroid(xyzs2, idxs2);
    // 相关矩阵 R = Σ (q - c2)(p - c1)^T
    let mut r = [[0.0f64; 3]; 3];
    for n in 0..idxs1.len() {
        let p = xyzs1[idxs1[n] as usize];
        let q = xyzs2[idxs2[n] as usize];
        let pv = [p[0] - c1[0], p[1] - c1[1], p[2] - c1[2]];
        let qv = [q[0] - c2[0], q[1] - c2[1], q[2] - c2[2]];
        for i in 0..3 {
            for j in 0..3 {
                r[i][j] += qv[i] * pv[j];
            }
        }
    }
    let k = [
        [
            r[0][0] + r[1][1] + r[2][2],
            r[1][2] - r[2][1],
            r[2][0] - r[0][2],
            r[0][1] - r[1][0],
        ],
        [
            r[1][2] - r[2][1],
            r[0][0] - r[1][1] - r[2][2],
            r[0][1] + r[1][0],
            r[2][0] + r[0][2],
        ],
        [
            r[2][0] - r[0][2],
            r[0][1] + r[1][0],
            -r[0][0] + r[1][1] - r[2][2],
            r[1][2] + r[2][1],
        ],
        [
            r[0][1] - r[1][0],
            r[2][0] + r[0][2],
            r[1][2] + r[2][1],
            -r[0][0] - r[1][1] + r[2][2],
        ],
    ];
    let rot = quat_to_mat(largest_eigenvector_4x4(&k));
    xyzs2
        .iter()
        .map(|v| {
            let d = [v[0] - c2[0], v[1] - c2[1], v[2] - c2[2]];
            let rr = mat_mul_vec(rot, d);
            [rr[0] + c1[0], rr[1] + c1[1], rr[2] + c1[2]]
        })
        .collect()
}

/// 从给定起点做逐轴贪心下降（原 maths::align 的搜索方式），返回 (坐标, 误差)。
/// MESD 没有闭式解，只能这样迭代；起点越好越不容易卡在局部解。
fn greedy_refine(
    xyzs1: &[[f64; 3]],
    xyzs2_start: &[[f64; 3]],
    idxs1: &[u32],
    idxs2: &[u32],
    method: &str,
) -> (Vec<[f64; 3]>, f64) {
    let dirs = ["x", "y", "z"];
    let angs = [-1.0, 1.0];
    let vals = [-2.0, 2.0];
    let mut step = 0.1;
    let mut min_err = f64::MAX;
    let mut xyzs_opt = xyzs2_start.to_vec();

    for _ in 0..300 {
        let mut new_err = min_err;
        for dir in dirs.iter() {
            for ang in angs.iter() {
                let xyzs_rotat = rotat(dir, *ang * step, &xyzs_opt);
                let v1 = mesd(&xyzs1, &xyzs_rotat, &idxs1, &idxs2);
                let v2 = rmsd(&xyzs1, &xyzs_rotat, &idxs1, &idxs2);
                let err = match method {
                    "mesd" => v1,
                    "rmsd" => v2,
                    _ => v1,
                };
                if err < new_err {
                    new_err = err;
                    xyzs_opt = xyzs_rotat;
                }
            }
            for val in vals.iter() {
                let xyzs_shift = shift(dir, *val * step, &xyzs_opt);
                let v1 = mesd(&xyzs1, &xyzs_shift, &idxs1, &idxs2);
                let v2 = rmsd(&xyzs1, &xyzs_shift, &idxs1, &idxs2);
                let err = match method {
                    "mesd" => v1,
                    "rmsd" => v2,
                    _ => v1,
                };
                if err < new_err {
                    new_err = err;
                    xyzs_opt = xyzs_shift;
                }
            }
        }
        if (min_err - new_err).abs() < 1e-10 {
            if step < 1e-8 {
                min_err = new_err;
                break;
            } else {
                step *= 0.5;
            }
        }
        min_err = new_err;
    }
    (xyzs_opt, min_err)
}

/// 旋转或平移第二组坐标使两者差距最小。
///
/// - `rmsd`：用 Kabsch/Horn 闭式解，一步给出全局最优（最小二乘意义下的刚体叠合）；
/// - `mesd`：没有闭式解，用逐轴贪心下降，分别以“原始坐标”和“Kabsch 最优解”为起点各跑一次，取误差更小者
///   （纯从零开始的贪心实测有约 10% 的用例会卡在更差的局部解）。
///
/// 参数通过 JSON 传对象：{ mole1: {idxs, xyzs}, mole2: {idxs, xyzs}, method: "mesd"|"rmsd" }
#[wasm_bindgen(js_name = align)]
pub fn align(mole1: JsValue, mole2: JsValue, method: String) -> Result<JsValue, JsValue> {
    let m1: AlignMole =
        serde_wasm_bindgen::from_value(mole1).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let m2: AlignMole =
        serde_wasm_bindgen::from_value(mole2).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let xyzs1 = vec2_to_xyz(&m1.xyzs);
    let xyzs2 = vec2_to_xyz(&m2.xyzs);
    let idxs1 = m1.idxs;
    let idxs2 = m2.idxs;

    if method != "mesd" && method != "rmsd" {
        return Err(JsValue::from_str("请选择正确的方法"));
    }
    if idxs1.len() != idxs2.len() || idxs1.is_empty() {
        return Err(JsValue::from_str("两组分子选中的原子数必须相同且不为空"));
    }
    // 越界索引会 panic（WASM 里会直接让实例失效），这里先挡住
    if idxs1.iter().any(|i| *i as usize >= xyzs1.len()) || idxs2.iter().any(|i| *i as usize >= xyzs2.len()) {
        return Err(JsValue::from_str("原子索引超出范围"));
    }

    let (xyzs_opt, min_err) = if method == "rmsd" {
        // RMSD 直接用闭式解，不需要迭代
        let opt = kabsch(&xyzs1, &xyzs2, &idxs1, &idxs2);
        let err = rmsd(&xyzs1, &opt, &idxs1, &idxs2);
        (opt, err)
    } else {
        let from_scratch = greedy_refine(&xyzs1, &xyzs2, &idxs1, &idxs2, "mesd");
        let seed = kabsch(&xyzs1, &xyzs2, &idxs1, &idxs2);
        let from_seed = greedy_refine(&xyzs1, &seed, &idxs1, &idxs2, "mesd");
        if from_seed.1 < from_scratch.1 {
            from_seed
        } else {
            from_scratch
        }
    };

    let result = AlignResult {
        xyzs: xyz_to_vec2(&xyzs_opt),
        err: min_err,
    };
    to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

// ---------------------------------------------------------------------------
// 保存 xyz
// ---------------------------------------------------------------------------

/// 把分子列表拼成标准 xyz 文本，供前端写文件。
/// 参数是 JSON 数组：[{ syms: [...], xyzs: [[x,y,z], ...] }, ...]
#[wasm_bindgen(js_name = saveXyz)]
pub fn save_xyz(moles: JsValue) -> Result<String, JsValue> {
    let moles: Vec<MoleJs> =
        serde_wasm_bindgen::from_value(moles).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut text = String::new();
    for mole in moles.iter() {
        let natm = mole.syms.len();
        text += &format!("{}\n\n", natm);
        for i in 0..natm {
            let sym = &mole.syms[i];
            let xyz = &mole.xyzs[i];
            let x = if xyz.len() > 0 { xyz[0] } else { 0.0 };
            let y = if xyz.len() > 1 { xyz[1] } else { 0.0 };
            let z = if xyz.len() > 2 { xyz[2] } else { 0.0 };
            text += &format!("{:>3}           {:>14.8}{:>14.8}{:>14.8}\n", sym, x, y, z);
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // read_gjf 走 serde_wasm_bindgen 的 JsValue，只能在 wasm 目标下运行
    // （在宿主上 cargo test 会因缺少 JS 运行时 panic），所以这里限定目标
    #[cfg(target_arch = "wasm32")]
    fn read_gjf_parses_atoms() {
        let text = "# test\n\nC 0.0 0.0 0.0\nH 1.0 0.0 0.0\n\n--Link1--\n";
        let v = read_gjf(text).unwrap();
        let s: ParsedMole = serde_wasm_bindgen::from_value(v).unwrap();
        assert_eq!(s.syms.len(), 2);
        assert_eq!(s.syms[0], "C");
        assert_eq!(s.xyzs[0], vec![0.0, 0.0, 0.0]);
    }

    /// 绕单位轴旋转 + 平移（测试用，等价于罗德里格斯公式）
    fn rigid(pts: &[[f64; 3]], axis: [f64; 3], ang: f64, t: [f64; 3]) -> Vec<[f64; 3]> {
        let n = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
        let a = [axis[0] / n, axis[1] / n, axis[2] / n];
        let (c, s) = (ang.cos(), ang.sin());
        pts.iter()
            .map(|p| {
                let [x, y, z] = *p;
                let dot = a[0] * x + a[1] * y + a[2] * z;
                [
                    x * c + (a[1] * z - a[2] * y) * s + a[0] * dot * (1.0 - c) + t[0],
                    y * c + (a[2] * x - a[0] * z) * s + a[1] * dot * (1.0 - c) + t[1],
                    z * c + (a[0] * y - a[1] * x) * s + a[2] * dot * (1.0 - c) + t[2],
                ]
            })
            .collect()
    }

    fn test_mole() -> Vec<[f64; 3]> {
        vec![
            [0.3, 1.2, -0.7],
            [1.1, -0.4, 2.0],
            [-1.3, 0.9, 0.5],
            [0.8, 2.2, -1.4],
            [2.1, -1.7, 0.3],
            [-0.6, -2.3, 1.8],
            [0.0, 0.0, 0.0],
        ]
    }

    /// Kabsch 应能完全恢复已知刚体变换（RMSD≈0），包括大角度旋转 + 平移
    #[test]
    fn kabsch_recovers_known_rigid_transform() {
        let xyzs1 = test_mole();
        let idxs: Vec<u32> = (0..xyzs1.len() as u32).collect();
        for (ang, t) in [
            (0.2, [0.0, 0.0, 0.0]),
            (1.6, [3.0, -2.0, 1.0]),
            (3.0, [-5.0, 4.0, -1.5]),
        ] {
            let xyzs2 = rigid(&xyzs1, [0.3, -0.8, 0.52], ang, t);
            let aligned = kabsch(&xyzs1, &xyzs2, &idxs, &idxs);
            let err = rmsd(&xyzs1, &aligned, &idxs, &idxs);
            assert!(err < 1e-9, "ang={ang} 时 Kabsch 残差 {err} 应为 0");
        }
    }

    /// RMSD 的闭式解不会比贪心差（闭式解是全局最优）
    #[test]
    fn kabsch_is_no_worse_than_greedy_for_rmsd() {
        let xyzs1 = test_mole();
        let idxs: Vec<u32> = (0..xyzs1.len() as u32).collect();
        let mut seed = 20260924u64;
        let mut rnd = || {
            seed = (seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)) >> 11;
            (seed as f64) / (1u64 << 53) as f64
        };
        for _ in 0..50 {
            // 每个原子独立小扰动，模拟“不同构象”；再做整体刚体变换
            let deformed: Vec<[f64; 3]> = xyzs1
                .iter()
                .map(|p| [p[0] + (rnd() - 0.5) * 0.4, p[1] + (rnd() - 0.5) * 0.4, p[2] + (rnd() - 0.5) * 0.4])
                .collect();
            let xyzs2 = rigid(
                &deformed,
                [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5],
                rnd() * std::f64::consts::PI,
                [(rnd() - 0.5) * 8.0, (rnd() - 0.5) * 8.0, (rnd() - 0.5) * 8.0],
            );
            let greedy = greedy_refine(&xyzs1, &xyzs2, &idxs, &idxs, "rmsd");
            let kab = kabsch(&xyzs1, &xyzs2, &idxs, &idxs);
            let err_kab = rmsd(&xyzs1, &kab, &idxs, &idxs);
            assert!(
                err_kab <= greedy.1 + 1e-9,
                " Kabsch {err_kab} 应不大于贪心 {}",
                greedy.1
            );
        }
    }
}
