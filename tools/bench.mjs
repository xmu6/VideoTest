/** 采样成本基准：读视频帧 vs 整页截图 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEST = path.resolve(HERE, '..', 'test');
const PORT = 8789;
const server = http.createServer(async (req, res) => {
  const p = path.join(TEST, decodeURIComponent(req.url.split('?')[0]));
  try {
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto(`http://127.0.0.1:${PORT}/fixture.html`);
await p.waitForTimeout(1500);
console.log('page:', p.url(), 'videos:', await p.evaluate(() => document.querySelectorAll('video').length));

const measure = async (w, h, n) =>
  p.evaluate(
    ({ w, h, n }) => {
      const v = document.querySelector('video');
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < 30; i++) {
        ctx.drawImage(v, 0, 0, w, h);
        ctx.getImageData(0, 0, w, h);
      }
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        ctx.drawImage(v, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let s = 0;
        for (let k = 0; k < d.length; k += 4) s += d[k];
      }
      return (performance.now() - t0) / n;
    },
    { w, h, n }
  );

const small = await measure(48, 27, 300);
const mid = await measure(160, 90, 100);
const full = await measure(320, 180, 60);

const t1 = Date.now();
for (let i = 0; i < 5; i++) await p.screenshot();
const pageShot = (Date.now() - t1) / 5;

const t2 = Date.now();
for (let i = 0; i < 5; i++) await p.screenshot({ clip: { x: 10, y: 60, width: 400, height: 240 } });
const clipShot = (Date.now() - t2) / 5;

console.log(JSON.stringify({ small: +small.toFixed(3), mid: +mid.toFixed(3), full: +full.toFixed(3), pageShot: +pageShot.toFixed(1), clipShot: +clipShot.toFixed(1) }, null, 2));
await b.close();
server.close();
