// 在已开的 Chrome 上暂停/恢复正在播放的视频，用来在真实流上制造一次“画面停住”
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:9333';
const holdMs = Number(process.argv[3] || 6000);
const b = await chromium.connectOverCDP(url);
const p = b.contexts()[0].pages().find((x) => x.url().includes('tplinkcloud'));
if (!p) {
  console.log('no page');
  process.exit(1);
}
const st = await p.evaluate(() => {
  const v = document.querySelector('video');
  v.pause();
  return { ct: +v.currentTime.toFixed(2), paused: v.paused };
});
console.log('paused', JSON.stringify(st), 'hold', holdMs, 'ms');
await new Promise((r) => setTimeout(r, holdMs));
await p.evaluate(() => document.querySelector('video').play());
console.log('resumed');
await b.close();
