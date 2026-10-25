// 走真实判定链测试分区判色：局部绿屏 / 局部黑屏 / 全屏绿 / 黑屏带 OSD 文字块
import { Analyzer } from '../src/classify.mjs';

const NORMAL = { r: 126, g: 126, b: 125, sd: 12, sg: 12, sb: 12 };
const GREEN = [0, 160, 0];
const BLACK = [1, 1, 1];
const WHITE = [245, 245, 245];

function blocksOf(fill, n) {
  // 从左上角开始连续填 n 块（模拟“左上 / 上半部分”变色）
  return Array.from({ length: n }, (_, i) => [i, ...fill, 1, 1, 1]);
}

function run(label, sample) {
  const an = new Analyzer();
  for (let k = 0; k < 8; k++) {
    an.ingest({ samples: [{ t: k * 250, v: 1, ct: 10 + k * 0.25, pl: 0, rs: 4, hb: 0, pr: 100 + k, ...sample }] }, 0);
  }
  const s = an.summary();
  const eps = s.episodes.map((e) => `${e.type}${e.area ? ` ${(e.area.frac * 100).toFixed(0)}%` : ''}`);
  console.log(label.padEnd(34), eps.length ? eps.join(', ') : '(无)');
}

console.log('== 局部/全局判色（每块 = 画面的 5.6%）==');
for (const n of [0, 1, 2, 3, 6, 9, 12, 18]) {
  run(`绿色占 ${n} 块 (${((n / 18) * 100).toFixed(0)}%)`, { ...NORMAL, cb: n ? blocksOf(GREEN, n) : undefined });
}
console.log('');
run('全屏绿（全局统计也是绿）', { r: 0, g: 160, b: 0, sd: 0.5, sg: 0.5, sb: 0.5 });
run('黑屏 + 1 块白字（OSD）', { ...NORMAL, r: 1, g: 1, b: 1, sd: 0.5, sg: 0.5, sb: 0.5, cb: blocksOf(WHITE, 1) });
run('黑屏 + 2 块白字（大 UI）', { r: 1, g: 1, b: 1, sd: 0.5, sg: 0.5, sb: 0.5, cb: blocksOf(WHITE, 2) });
run('正常画面 + 2 块黑（局部无信号）', { ...NORMAL, cb: blocksOf(BLACK, 2) });
run('正常画面 + 3 块黑', { ...NORMAL, cb: blocksOf(BLACK, 3) });
