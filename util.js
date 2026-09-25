// util.js — tiny shared helpers.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Pause for ms milliseconds. Browsers need breathing room between actions.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [14:32:11] message — one consistent log format for everything.
export function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

// Error evidence: screenshot + HTML dump into the session's debug/ folder.
// For a non-developer, these files are what you send me when something breaks.
export async function captureDebug(page, dir, name) {
  try {
    mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, `${name}.png`);
    await page.screenshot({ path: shot });
    const dom = path.join(dir, `${name}.html`);
    writeFileSync(dom, await page.content());
    return { shot, dom };
  } catch {
    return { shot: null, dom: null };   // page/browser may be closed
  }
}

// Self-test: run with  node -e "import('./util.js').then(m=>m.selfTest())"
export async function selfTest() {
  log('self-test: log() works');
  const t0 = Date.now();
  await sleep(120);
  const ok = Date.now() - t0 >= 100;
  log(`self-test: sleep(120) waited properly: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}