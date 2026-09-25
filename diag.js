// diag.js — TEMPORARY. Tells us exactly which elements hold the reply text. Delete when done.
import { firefox } from 'playwright';
import { PROVIDERS, SENTINEL } from './config.js';
import { log } from './util.js';

const ctx = await firefox.launchPersistentContext('profiles/qwen', {
  headless: false, viewport: { width: 1100, height: 800 },
});
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(PROVIDERS.qwen.startUrl, { waitUntil: 'domcontentloaded' });

log('Waiting for the sentinel text to appear somewhere on the page...');
log('If the window shows an empty/new chat, CLICK THE LATEST CHAT in the sidebar (the one with the probe).');

// Poll the whole page (piercing shadow DOM) until the sentinel text exists, up to 3 min.
const found = await page.waitForFunction((s) => {
  const deep = (root) => {
    let out = '';
    const walk = (el) => {
      if (el.nodeType === 3) { out += el.textContent; return; }
      if (el.shadowRoot) walk(el.shadowRoot);
      for (const c of el.childNodes || []) walk(c);
    };
    walk(root);
    return out;
  };
  return deep(document.body).includes(s);
}, SENTINEL, { timeout: 180000, polling: 2000 }).then(() => true).catch(() => false);

if (!found) {
  log('Sentinel never found on the page. Tell me what the window shows (screenshot description).');
  await ctx.close();
  process.exit(1);
}

const report = await page.evaluate((s) => {
  const deep = (root) => {
    let out = '';
    const walk = (el) => {
      if (el.nodeType === 3) { out += el.textContent; return; }
      if (el.shadowRoot) walk(el.shadowRoot);
      for (const c of el.childNodes || []) walk(c);
    };
    walk(root);
    return out;
  };
  const shadowHosts = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) shadowHosts.push(el.tagName + '.' + String(el.className).slice(0, 60));
  });
  const hocs = [...document.querySelectorAll('.message-hoc-container')].slice(0, 6).map((h) => ({
    children: h.querySelectorAll('*').length,
    childClasses: [...h.querySelectorAll('*')].slice(0, 10).map((e) => String(e.className).slice(0, 50)),
    deepTail: deep(h).slice(-200),
  }));
  const hits = [];
  document.querySelectorAll('body *').forEach((el) => {
    const t = deep(el);
    if (t.includes(s)) hits.push(el.tagName + '.' + String(el.className).slice(0, 70));
  });
  return { shadowHostCount: shadowHosts.length, shadowHosts: shadowHosts.slice(0, 10), hocs, hitCount: hits.length, hits: hits.slice(0, 25) };
}, SENTINEL);

console.log(JSON.stringify(report, null, 2));
log('frames: ' + JSON.stringify(page.frames().map((f) => f.url())));
await ctx.close();