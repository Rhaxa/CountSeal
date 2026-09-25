// sentinel.js — parse sentinel + status markers out of provider responses.

import { SENTINEL } from './config.js';

const STATUS_RE = /\[\[STATUS:\s*(IN_PROGRESS|DONE|BLOCKED)\s*(?::\s*([^\]]+))?\]\]/g;

// Turn raw provider output into { clean, status, reason, sentinelMissing, statusMissing }.
export function parseResponse(raw) {
  const text = (raw ?? '').trim();
  const idx = text.lastIndexOf(SENTINEL);

  let body = text;
  let tail = '';
  let sentinelMissing = false;
  if (idx === -1) {
    sentinelMissing = true;              // nothing to strip; keep whole text
  } else {
    body = text.slice(0, idx).trim();
    tail = text.slice(idx + SENTINEL.length);
  }

  const matches = [...tail.matchAll(STATUS_RE)];
  const last = matches.pop();            // spec: parse ONLY the last status marker
  if (!last) {
    return { clean: body, status: 'IN_PROGRESS', reason: null, sentinelMissing, statusMissing: true };
  }
  return { clean: body, status: last[1], reason: last[2]?.trim() || null, sentinelMissing, statusMissing: false };
}

// Phase 0 votes.
export function parseRatification(text) {
  const t = text ?? '';
  if (/\[\[RATIFY\]\]/.test(t)) return { verdict: 'RATIFY', detail: null };
  let m = t.match(/\[\[AMEND:\s*([^\]]+)\]\]/);
  if (m) return { verdict: 'AMEND', detail: m[1].trim() };
  m = t.match(/\[\[REJECT:\s*([^\]]+)\]\]/);
  if (m) return { verdict: 'REJECT', detail: m[1].trim() };
  return { verdict: null, detail: null };   // agent ignored the vote format
}

// Self-test: run with  node -e "import('./sentinel.js').then(m=>m.selfTest())"
export function selfTest() {
  let failures = 0;
  const check = (name, got, want) => {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) { console.log(`   got:  ${JSON.stringify(got)}`); console.log(`   want: ${JSON.stringify(want)}`); failures++; }
  };

  // 1. normal work response with DONE
  let r = parseResponse(`Here is my plan.\n\n${SENTINEL}\n[[STATUS: DONE]]`);
  check('strips sentinel+status', r.clean, 'Here is my plan.');
  check('reads DONE', r.status, 'DONE');
  check('no missing flags', [r.statusMissing, r.sentinelMissing], [false, false]);

  // 2. status missing -> default IN_PROGRESS, flagged
  r = parseResponse(`Thinking out loud.\n\n${SENTINEL}`);
  check('missing status defaults IN_PROGRESS', r.status, 'IN_PROGRESS');
  check('missing status flagged', r.statusMissing, true);

  // 3. sentinel missing entirely
  r = parseResponse('Just a plain reply with no markers at all.');
  check('sentinel missing flagged', r.sentinelMissing, true);
  check('body kept when sentinel missing', r.clean, 'Just a plain reply with no markers at all.');

  // 4. BLOCKED with reason, and LAST status wins
  r = parseResponse(`Stuck.\n\n${SENTINEL}\n[[STATUS: IN_PROGRESS]]\n[[STATUS: BLOCKED: no file access]]`);
  check('last status wins', r.status, 'BLOCKED');
  check('reason parsed', r.reason, 'no file access');

  // 5. ratification votes
  check('RATIFY', parseRatification('[[RATIFY]]').verdict, 'RATIFY');
  check('AMEND detail', parseRatification('[[AMEND: cap items at 5]]'), { verdict: 'AMEND', detail: 'cap items at 5' });
  check('REJECT detail', parseRatification('[[REJECT: item 3 is not verifiable]]').verdict, 'REJECT');
  check('no vote -> null', parseRatification('I agree with everything.').verdict, null);

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
}