// 诊断：在 fixture 页上单独跑探针，打印标定出的 OSD ROI 与心跳序列
import { chromium } from 'playwright-core';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const PORT = 8790;
const server = http.createServer(async (req, res) => {
  const p = path.join(ROOT, 'test', decodeURIComponent(req.url.split('?')[0]));
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
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const agentSrc = await fs.readFile(path.join(ROOT, 'src', 'agent.js'), 'utf8');
await page.addInitScript({ content: `window.__VT_CFG={fps:4,osdCalMs:${process.argv[2] || 5000}};\n${agentSrc}` });
await page.goto(`http://127.0.0.1:${PORT}/fixture.html`);
await page.waitForTimeout(7000);

const vids = await page.evaluate(() => window.__VT.videos());
console.log('videos:', JSON.stringify(vids, null, 1));
console.log('diag:', JSON.stringify(await page.evaluate(() => window.__VT.diag()), null, 1));

const rows = [];
for (let i = 0; i < 12; i++) {
  const d = await page.evaluate(() => {
    const p = window.__VT.drain();
    return p.samples.map((s) => ({ t: s.t, v: s.v, hb: s.hb, eq: s.eq }));
  });
  rows.push(...d);
  await page.waitForTimeout(400);
}
console.log('samples:');
for (const r of rows.slice(0, 40)) console.log(`  t=${(r.t / 1000).toFixed(2)} v=${r.v} hb=${r.hb} eq=${r.eq}`);
await browser.close();
server.close();
