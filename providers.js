// providers.js — one headful Firefox per provider, driven via Playwright.

import { firefox } from 'playwright';
import path from 'node:path';
import { PROVIDERS, ROLE_CARDS, SENTINEL, SENTINEL_PROMPT } from './config.js';
import { log, sleep, captureDebug } from './util.js';
import { parseResponse } from './sentinel.js';

const RESPONSE_TIMEOUT_MS = 180000; // 3 min cap per reply
const POLL_MS = 1500;
const DEBUG_DIR = path.join('conversations', '_selftest', 'debug');

export class Provider {
  constructor(key) {
    this.key = key;
    this.cfg = PROVIDERS[key];
    this.context = null;
    this.page = null;
    this.lastPrompt = '';
  }

  async open() {
    this.context = await firefox.launchPersistentContext(
      path.join('profiles', this.key),
      { headless: false, viewport: { width: 1100, height: 800 } }
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.goto(this.cfg.startUrl);
    log(`${this.cfg.label}: browser opened`);
  }

  async ensureLoggedIn() {
    try {
      await this.page.waitForSelector(this.cfg.input, { timeout: 8000 });
    } catch {
      log(`${this.cfg.label}: >>> LOG IN NOW in the open browser window, then wait <<<`);
      await this.page.waitForSelector(this.cfg.input, { timeout: 600000 });
    }
    log(`${this.cfg.label}: ready (logged in)`);
  }

  async newThread() {
    await this.goto(this.cfg.startUrl);   // landing page = fresh thread
    await this.page.waitForSelector(this.cfg.input, { timeout: 20000 });
    await this.page.locator(this.cfg.input).first().click();
    await sleep(800);
  }

  async sendMessage(text) {
    this.lastPrompt = text;
    const msgs = this.page.locator(this.cfg.messages);
    this.msgCountBefore = await msgs.count();
    this.prevReplies = await this.collectReplies(msgs);   // freshness guard baseline
    const box = this.page.locator(this.cfg.input).first();
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      await this.page.keyboard.press('Escape').catch(() => {});   // dismiss any overlay
      await box.click({ timeout: 10000 }).catch(async () => {
        await box.focus().catch(() => {});                          // skip actionability
        await box.click({ force: true }).catch(() => {});
      });
      await box.fill(text).catch(async () => {
        // React-controlled fallback: native setter + input event
        await box.evaluate((el, v) => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          if (setter) setter.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, text);
      });
      await sleep(400);
      if (attempt < 2) {
        await this.page.keyboard.press('Enter');
      } else {
        // last resort: click the first button after the input (the Send button, whatever its class)
        // DeepSeek renders <div role="button">, not <button> — match by role; Send is the last one
        await this.page.locator(`${this.cfg.input} >> xpath=following::*[@role="button"]`).last().click().catch(() => {});
      }
      const waits = attempt < 2 ? 8 : 12;   // up to 4s, then 6s on the final attempt
      for (let i = 0; i < waits; i++) {
        await sleep(500);
        if ((await msgs.count()) > this.msgCountBefore) { sent = true; break; }
      }
      if (!sent) log(`${this.cfg.label}: send attempt ${attempt + 1} failed — retrying`);
    }
    if (!sent) {
      const err = new Error('send failed: message never appeared in the thread');
      err.code = 'SEND';
      throw err;
    }
    log(`${this.cfg.label}: sent ${text.length} chars`);
  }

  // signatures of ALL completed replies present before the send (freshness guard)
  async collectReplies(msgs) {
    const sigs = new Set();
    const n = await msgs.count();
    for (let k = 0; k < n; k++) {
      const t = await msgs.nth(k).innerText().catch(() => '');
      const s = (t ?? '').trimEnd();
      if (/\[\[END_7f3a\]\]\s*\n\s*\[\[STATUS:[^\]]*\]\]/.test(s) || s.endsWith(SENTINEL)) sigs.add(t);
    }
    return sigs;
  }

  // A reply is DONE when a message shows the sentinel then the status on consecutive
  // lines (or ends with the sentinel), and that text is identical across two polls.
  // The sent prompt matches neither pattern, so it can never be mistaken for a reply.
  async awaitResponse() {
    const msgs = this.page.locator(this.cfg.messages);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    const DONE_RE = /\[\[END_7f3a\]\]\s*\n\s*\[\[STATUS:[^\]]*\]\]/;

    let previous = null, stable = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const n = await msgs.count();
        if (this.cfg.errorText) {
          const body = await this.page.locator('body').innerText().catch(() => '');
          if (body.includes(this.cfg.errorText)) {
            const err = new Error(`provider error banner detected ("${this.cfg.errorText}")`);
            err.code = 'PROVIDER_ERROR';
            throw err;
        }
      }
      let candidate = null;
      for (let k = n - 1; k >= 0; k--) {           // bottom-up: most recent reply wins
        const t = await msgs.nth(k).innerText().catch(() => '');
        const s = (t ?? '').trimEnd();
        if (DONE_RE.test(s) || s.endsWith(SENTINEL)) {
          if (this.prevReplies !== null && this.prevReplies.has(t)) continue; // any pre-send reply
          candidate = t; break;
        }
      }
      if (candidate === null) { previous = null; stable = 0; continue; }
      if (candidate === previous) stable++;
      else { previous = candidate; stable = 0; }
      if (stable >= 1) return candidate;           // two identical polls (~3s) = finished
    }
    const err = new Error('response timeout'); err.code = 'TIMEOUT';
    throw err;
  }

  // goto with retries: restored tabs may still be navigating (NS_BINDING_ABORTED).
  async goto(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        await sleep(1500);
      }
    }
  }
  async close() {
    await this.context?.close().catch(() => {});
  }
}

// ---- Step 4 test: log in to each provider, send one probe, verify the protocol ----
export async function selfTest(only = null) {
  const probe = `Connectivity test. Reply with exactly one line containing OK, ` +
    `then end with the sentinel and [[STATUS: IN_PROGRESS]].\n\n${SENTINEL_PROMPT}`;
  for (const key of Object.keys(PROVIDERS)) {
    if (only && key !== only) continue;
    const p = new Provider(key);
    try {
      await p.open();
      await p.ensureLoggedIn();
      await p.newThread();
      const card = ROLE_CARDS[p.cfg.role];
      await p.sendMessage(`${card}\n\n${probe}`);
      const raw = await p.awaitResponse();
      const r = parseResponse(raw);
      log(`${p.cfg.label}: reply parsed -> status=${r.status} sentinelMissing=${r.sentinelMissing}`);
      if (r.statusMissing || r.sentinelMissing) {
        log(`${p.cfg.label}: WARNING — markers missing, selectors may need tuning`);
      }
    } catch (e) {
      log(`${p.cfg.label}: FAILED — ${e.message}`);
      if (p.page) {
        const files = await captureDebug(p.page, DEBUG_DIR, `${key}-error`);
        log(`${p.cfg.label}: evidence saved: ${files.shot} + ${files.dom}`);
      }
    } finally {
      await p.close();
      await sleep(3000);
    }
  }
  log('self-test complete');
}