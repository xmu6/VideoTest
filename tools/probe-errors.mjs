// 抓页面里的运行时报错（注入 agent.js 后跑 fixture）
import { chromium } from 'playwright-core';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';

const ROOT = 'D:/CODE/VideoTest';
const PORT = 8791;
const server = http.createServer(async (req, res) => {
  try {
    const b = await fs.readFile(path.join(ROOT, 'test', req.url.split('?')[0]));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(b);
  } catch {
    res.writeHead(404).end('x');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const br = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const p = await br.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message, '\n', (e.stack || '').split('\n').slice(0, 4).join('\n')));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
const src = await fs.readFile(path.join(ROOT, 'src', 'agent.js'), 'utf8');
await p.addInitScript({ content: `window.__VT_CFG={fps:4,osd:''};\n${src}` });
await p.goto(`http://127.0.0.1:${PORT}/fixture.html`);
await p.waitForTimeout(4000);
const n = await p.evaluate(() => (window.__VT ? window.__VT.drain().samples.length : -1));
console.log('samples after 4s:', n);
await br.close();
server.close();
