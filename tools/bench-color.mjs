// 颜色统计的性能对比：当前（中位数/MAD 稳健统计） vs 分区统计
const W = 48, H = 27, N = W * H;
const data = new Uint8ClampedArray(N * 4);
// 造一张有点内容的图：渐变 + 噪声 + 角落一块亮斑（模拟 OSD）
for (let y = 0, i = 0; y < H; y++) {
  for (let x = 0; x < W; x++, i += 4) {
    const v = 60 + ((x * 3 + y * 2) % 90);
    data[i] = v + ((i % 7) - 3);
    data[i + 1] = v + 10 + ((i % 5) - 2);
    data[i + 2] = v - 5;
    data[i + 3] = 255;
  }
}
// 左上角 8×2 格子当成白色 OSD
for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
  const p = (y * W + x) * 4;
  data[p] = data[p + 1] = data[p + 2] = 245;
}

const med = (a) => {
  const s = Array.from(a).sort((x, y) => x - y);
  return s[s.length >> 1];
};

// A：当前实现（每帧 6 次 1296 元素排序）
function statsRobust(d) {
  const rv = new Float32Array(N), gv = new Float32Array(N), bv = new Float32Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) { rv[i] = d[p]; gv[i] = d[p + 1]; bv[i] = d[p + 2]; }
  const mR = med(rv), mG = med(gv), mB = med(bv);
  const madOf = (a, m) => { const x = new Float32Array(a.length); for (let i = 0; i < a.length; i++) x[i] = Math.abs(a[i] - m); return med(x); };
  const tR = Math.max(45, 5 * madOf(rv, mR)), tG = Math.max(45, 5 * madOf(gv, mG)), tB = Math.max(45, 5 * madOf(bv, mB));
  let n = 0, sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    if (Math.abs(r - mR) > tR || Math.abs(g - mG) > tG || Math.abs(b - mB) > tB) continue;
    n++; sr += r; sg += g; sb += b; sr2 += r * r; sg2 += g * g; sb2 += b * b;
  }
  return [sr / n, sg / n, sb / n];
}

// B：分区统计（6×5 区块，一遍求和，无排序）
const BX = 6, BY = 5, CW = W / BX, CH = H / BY;
function statsBlocks(d) {
  const out = new Float32Array(BX * BY * 6);
  const cnt = new Float32Array(BX * BY);
  for (let y = 0, i = 0; y < H; y++) {
    const by = (y / CH) | 0;
    for (let x = 0; x < W; x++, i += 4) {
      const bi = by * BX + ((x / CW) | 0);
      const r = d[i], g = d[i + 1], b = d[i + 2];
      out[bi * 6] += r; out[bi * 6 + 1] += g; out[bi * 6 + 2] += b;
      out[bi * 6 + 3] += r * r; out[bi * 6 + 4] += g * g; out[bi * 6 + 5] += b * b;
      cnt[bi]++;
    }
  }
  for (let bi = 0; bi < BX * BY; bi++) {
    const c = cnt[bi];
    if (c) for (let k = 0; k < 6; k++) out[bi * 6 + k] /= c;
  }
  return out;
}

function bench(fn, label, iters = 3000) {
  for (let i = 0; i < 200; i++) fn(data);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(data);
  const ms = (performance.now() - t0) / iters;
  console.log(label.padEnd(28), (ms * 1000).toFixed(1).padStart(7), 'µs/帧');
  return ms;
}

const a = bench(statsRobust, 'A 当前：中位数/MAD 稳健');
const b = bench(statsBlocks, 'B 分区：6×5 区块');

console.log('');
console.log('参考：drawImage(2880×1620) 实测 ≈ 13 ms/帧，getImageData ≈ 0.01–0.25 ms');
for (const [hz, ch] of [[4, 16], [1, 16], [4, 4], [1, 1]]) {
  const per = hz * ch;
  console.log(
    `${ch} 路 × ${hz}Hz = ${String(per).padStart(2)} 帧/s → ` +
      `A ${(a * per).toFixed(1)} ms/s (${((a * per) / 10).toFixed(1)}%) · ` +
      `B ${(b * per).toFixed(1)} ms/s (${((b * per) / 10).toFixed(1)}%)`
  );
}
