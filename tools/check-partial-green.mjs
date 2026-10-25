// 部分绿屏：按当前判定链（48×27 采样 + 中位数/MAD 稳健统计）扫一遍占比
import { Analyzer } from '../src/classify.mjs';

const W = 48, H = 27, N = W * H;
const SCENE = [126, 126, 125];
const GREEN = [0, 160, 0];

// 复刻 agent.js 里的稳健统计
function stats(cells) {
  const med = (a) => {
    const s = Array.from(a).sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const madOf = (a, m) => med(a.map((v) => Math.abs(v - m)));
  const ch = [0, 1, 2].map((k) => cells.map((c) => c[k]));
  const meds = ch.map(med);
  const ths = ch.map((c, k) => Math.max(45, 5 * madOf(c, meds[k])));
  const keep = [];
  for (let i = 0; i < cells.length; i++) {
    let ok = true;
    for (let k = 0; k < 3; k++) if (Math.abs(cells[i][k] - meds[k]) > ths[k]) ok = false;
    if (ok) keep.push(cells[i]);
  }
  const m = Math.max(1, keep.length);
  const mean = [0, 1, 2].map((k) => keep.reduce((a, c) => a + c[k], 0) / m);
  const sd = [0, 1, 2].map((k) => Math.sqrt(Math.max(0, keep.reduce((a, c) => a + c[k] * c[k], 0) / m - mean[k] ** 2)));
  return { r: +mean[0].toFixed(1), g: +mean[1].toFixed(1), b: +mean[2].toFixed(1), sd: +sd[0].toFixed(1), sg: +sd[1].toFixed(1), sb: +sd[2].toFixed(1), kept: keep.length };
}

const an = new Analyzer();
console.log('绿色占比'.padEnd(10), '统计(R/G/B, sg)'.padEnd(34), '保留格', ' 判定');
for (const p of [0, 0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const cells = [];
  const nGreen = Math.round(N * p);
  for (let i = 0; i < N; i++) {
    const base = i < nGreen ? GREEN : SCENE;
    const noise = (i % 3) - 1; // ±1 抖动，模拟真实码流
    cells.push([base[0] + noise, base[1] + noise, base[2] + noise]);
  }
  const st = stats(cells);
  const t = an.classify(st);
  const stat = `(${st.r}/${st.g}/${st.b}, sg=${st.sg})`;
  console.log(
    `${(p * 100).toFixed(0).padStart(4)}%     `.padEnd(12),
    stat.padEnd(34),
    String(st.kept).padEnd(6),
    t.length ? t.join(',') : '(无)'
  );
}
