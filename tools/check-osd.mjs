// 诊断：fixture 顶部条带在 1.3 秒内到底变了没有（验证 OSD 秒位是否真的在跳）
import { chromium } from 'playwright-core';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';

const ROOT = 'D:/CODE/VideoTest';
const server = http.createServer(async (req, res) => {
  try {
    const b = await fs.readFile(path.join(ROOT, 'test', req.url.split('?')[0]));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(b);
  } catch {
    res.writeHead(404).end('x');
  }
});
await new Promise((r) => server.listen(8784, '127.0.0.1', r));
const br = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await br.newPage();
await p.goto('http://127.0.0.1:8784/fixture.html');
await p.waitForTimeout(1500);

const grab = () =>
  p.evaluate(() => {
    const v = document.querySelector('#v0');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const x = c.getContext('2d');
    x.drawImage(v, 0, 0);
    return Array.from(x.getImageData(0, 0, c.width, 30).data);
  });

const a = await grab();
await p.waitForTimeout(1300);
const b = await grab();
let n = 0, sum = 0;
for (let i = 0; i < a.length; i += 4) {
  const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  if (d > 18) n++;
  sum += d;
}
console.log('top-strip(320x30) changed px:', n, ' meanAbsDiff:', (sum / a.length).toFixed(3));
// 逐列统计变化，定位秒位大概在哪
const cols = new Array(320).fill(0);
for (let i = 0; i < a.length; i += 4) {
  const px = (i / 4) % 320;
  const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  if (d > 18) cols[px]++;
}
const hot = cols.map((c, i) => [i, c]).filter(([, c]) => c > 0);
console.log('changed columns (x,count):', JSON.stringify(hot.slice(0, 40)));
await br.close();
server.close();
