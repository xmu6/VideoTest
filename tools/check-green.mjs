// 用当前判定器逐条测不同绿色（含偏青/偏黄/很暗），看哪些能命中
import { Analyzer } from '../src/classify.mjs';

const an = new Analyzer();
const colors = [
  ['H.264 经典绿 (0,160,0)', 0, 160, 0],
  ['NVIDIA 绿 (0,135,0)', 0, 135, 0],
  ['纯绿 (0,255,0)', 0, 255, 0],
  ['CSS green (0,128,0)', 0, 128, 0],
  ['深绿 (0,100,0)', 0, 100, 0],
  ['暗绿 (0,70,0)', 0, 70, 0],
  ['极暗绿 (0,60,0)', 0, 60, 0],
  ['近黑绿 (0,45,0)', 0, 45, 0],
  ['黄绿 (60,180,0)', 60, 180, 0],
  ['橄榄绿 (107,142,35)', 107, 142, 35],
  ['青绿/teal (0,180,150)', 0, 180, 150],
  ['低饱和绿 (100,150,100)', 100, 150, 100],
  ['带蓝的深绿 (0,90,20)', 0, 90, 20],
  ['墨绿 (20,90,40)', 20, 90, 40],
  ['偏黄绿 (100,160,40)', 100, 160, 40],
];

const s = (r, g, b, sd = 6) => ({ r, g, b, sd, sg: sd, sb: sd });
console.log('颜色'.padEnd(28), '判出类型');
for (const [name, r, g, b] of colors) {
  const t = an.classify(s(r, g, b));
  console.log(name.padEnd(30), t.length ? t.join(',') : '(无)');
}

// 带 UI 叠加/大块白字时的方差影响
console.log('\n同一批绿色，假设 G 通道方差 = 50（超过 45 的门槛）：');
for (const [name, r, g, b] of colors) {
  const t = an.classify({ r, g, b, sd: 20, sg: 50, sb: 20 });
  console.log(name.padEnd(30), t.length ? t.join(',') : '(无)');
}
