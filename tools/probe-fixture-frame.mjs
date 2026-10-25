// 诊断：把 fixture 页里第一路视频的一帧存成 PNG，检查 OSD 是否真的画进了码流
import { chromium } from 'playwright-core';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..', 'test');
const PORT = 8782;
const server = http.createServer(async (req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  try {
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://127.0.0.1:${PORT}/fixture.html`);
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const v = document.querySelector('#v0');
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const x = c.getContext('2d');
  x.drawImage(v, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  // 统计左上角 OSD 区域的像素
  let dark = 0, bright = 0;
  for (let y = 4; y < 20; y++) for (let xx = 4; xx < 108; xx++) {
    const p = (y * c.width + xx) * 4;
    const l = (d[p] + d[p + 1] + d[p + 2]) / 3;
    if (l < 60) dark++; else if (l > 180) bright++;
  }
  return { w: c.width, h: c.height, dark, bright, url: c.toDataURL('image/png') };
});
const raw = Buffer.from(info.url.split(',')[1], 'base64');
const out = path.join(HERE, '..', 'out', 'fixture-frame.png');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, raw);
console.log(JSON.stringify({ w: info.w, h: info.h, dark: info.dark, bright: info.bright, out: path.resolve(out), bytes: raw.length }));
await browser.close();
server.close();
