// 在已开的 Chrome(9333) 上接管真实 VMS 页面，注入探针，打印自动标定出的 OSD 区域与心跳序列
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT = 'D:/CODE/VideoTest';
const CDP = process.argv[2] || 'http://127.0.0.1:9333';
const MATCH = process.argv[3] || 'tplinkcloud';
const CAL = Number(process.argv[4] || 8000);

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes(MATCH)) || ctx.pages()[0];
if (!page) {
  console.log('no page');
  process.exit(1);
}
console.log('attach:', page.url());

// 1) 换新文档：旧探针还挂在同一个文档上，必须换文档才能注入新版
const NAV = process.argv[5] || '';
if (NAV) await page.goto(NAV, { waitUntil: 'domcontentloaded' }).catch(() => {});
else await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

// 2) 没有在播的画面时，点开“最近查看”里的第一张卡
const has = await page.evaluate(() => {
  const v = document.querySelector('video');
  return !!(v && v.videoWidth > 0);
});
if (!has) {
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.img-cover, .jump-item')].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('click camera card at', JSON.stringify(box));
  if (box) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(7000);
}
console.log('video state:', JSON.stringify(await page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { vw: v.videoWidth, vh: v.videoHeight, rs: v.readyState, ct: +v.currentTime.toFixed(1) } : null;
})));

const src = await fs.readFile(path.join(ROOT, 'src', 'agent.js'), 'utf8');
const cfg = JSON.stringify({ fps: 4, osdCalMs: CAL });
await page.evaluate(`window.__VT_CFG=${cfg};\n${src}`);
await page.waitForTimeout(CAL + 6000);

console.log('videos:', JSON.stringify(await page.evaluate(() => window.__VT.videos()), null, 1));
console.log('diag:', JSON.stringify(await page.evaluate(() => window.__VT.diag()), null, 1));

const rows = [];
for (let i = 0; i < 8; i++) {
  const d = await page.evaluate(() => (window.__VT ? window.__VT.drain() : null));
  if (d) rows.push(...d.samples.map((s) => ({ t: s.t, v: s.v, hb: s.hb, ct: s.ct, w: s.w, h: s.h, r: s.r, g: s.g, b: s.b })));
  await page.waitForTimeout(400);
}
console.log('samples tail:');
for (const r of rows.slice(-24)) console.log(`  t=${(r.t / 1000).toFixed(2)} v=${r.v} hb=${r.hb} ct=${r.ct} ${r.w}x${r.h} rgb=${r.r}/${r.g}/${r.b}`);
await browser.close();
