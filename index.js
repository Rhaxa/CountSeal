// index.js — CLI entry: round-robin orchestrator.
// Usage: node index.js --brief briefs/example-brief.md --max-turns 30
import path from 'node:path';
import readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { PROVIDERS, ROLE_CARDS, ROLE_REMINDERS, SENTINEL_PROMPT } from './config.js';
import { Provider } from './providers.js';
import { parseResponse, parseRatification } from './sentinel.js';
import { Ledger } from './ledger.js';
import { log, captureDebug } from './util.js';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const briefPath = arg('brief', 'briefs/example-brief.md');
const maxTurns = Number(arg('max-turns', 30));
const KEYS = Object.keys(PROVIDERS);

function parseDod(text) {
  const m = text.match(/##\s+Definition of Done\s*\n([\s\S]*?)(?=\n##|\s*$)/i);
  if (!m) return null;
  const items = [...m[1].matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((x) => x[1].trim()).filter(Boolean);
  return items.length ? items : null;
}
const dodText = (dod, title) => `## ${title}\n${dod.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;

// crude word-set similarity for stuck-loop detection
const similarity = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const B = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
};

async function main() {
  const brief = readFileSync(briefPath, 'utf8');
  let dod = parseDod(brief);
  if (!dod) { log('error: no "## Definition of Done" numbered list in the brief'); process.exit(1); }

  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  const ledger = new Ledger(sessionId, briefPath, maxTurns);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const providers = {};
  const states = Object.fromEntries(KEYS.map((k) => [k, 'IN_PROGRESS']));
  const lastSeen = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const pendingRevs = Object.fromEntries(KEYS.map((k) => [k, []]));
  const notices = Object.fromEntries(KEYS.map((k) => [k, []]));
  const objections = [];
  const lastClean = {};
  const stuck = {};
  const violations = {};
  let turn = 0;
  let freezeTurn = null;
  let termination = null;
  const setTerm = (r) => { if (!termination) termination = r; };

  process.on('SIGINT', () => {
    ledger.updateMeta({ ended_at: new Date().toISOString(), termination_reason: 'human_abort', agent_states: states });
    log('\nCtrl+C — session saved (termination_reason: human_abort)');
    process.exit(130);
  });

    const chatUrl = (k) => { try { return providers[k].page.url(); } catch { return (ledger.meta.agents[k] ?? {}).chat_url ?? 'closed'; } };

  try {
    for (const key of KEYS) {
      const p = new Provider(key);
      providers[key] = p;
      await p.open();
      await p.ensureLoggedIn();
      await p.newThread();
      log(`${p.cfg.label}: ready — ${p.page.url()}`);
    }
    ledger.updateMeta({
      agents: Object.fromEntries(KEYS.map((k) => [k, { last_seen_turn: 0, chat_url: providers[k].page.url() }])),
      agent_states: states,
    });

    async function runTurn(key, phase, prompt) {
      const p = providers[key];
      turn++;
      log(`[turn ${turn}] ${p.cfg.label} (${phase}) → ${prompt.length} chars`);
      const entry = {
        turn, agent: key, role: p.cfg.role, phase,
        timestamp: new Date().toISOString(),
        prompt_sent: prompt, response_raw: '', response_clean: '',
        declared_status: 'IN_PROGRESS', blocked_reason: null, vote: null,
        dod_snapshot: [...dod], status: 'ok', error: null,
      };
      try {
        await p.sendMessage(prompt);
        const raw = await p.awaitResponse();
        const r = parseResponse(raw);
        entry.response_raw = raw;
        entry.response_clean = r.clean;
        entry.declared_status = r.status;
        entry.blocked_reason = r.reason;
        if (r.statusMissing) entry.status = 'status_missing';
        if (r.sentinelMissing) entry.status = 'sentinel_missing';
      } catch (e) {
        entry.status = e.code === 'TIMEOUT' ? 'timeout'
          : e.code === 'SEND' ? 'send_failed'
          : e.code === 'PROVIDER_ERROR' ? 'provider_error'
          : 'selector_error';
        entry.error = e.message;
        await captureDebug(p.page, path.join(ledger.dir, 'debug'), `${key}-turn${turn}`);
        log(`${p.cfg.label}: ${entry.status} — evidence in debug/`);
      }
      if (phase === 'ratification') {
        const v = parseRatification(entry.response_clean);
        entry.vote = v.verdict ? (v.detail ? `${v.verdict}: ${v.detail}` : v.verdict) : 'no vote';
        log(`${p.cfg.label}: vote → ${entry.vote}`);
      }
      ledger.addTurn(entry);
      lastSeen[key] = turn;
      ledger.updateMeta({
        agents: Object.fromEntries(KEYS.map((k) => [k, { last_seen_turn: lastSeen[k], chat_url: providers[k].page.url() }])),
      });
      return entry;
    }

    // ---- Phase 0: ratification (3 rounds max, then human decides) ----
    const POSITIONS = {
      'Product Owner': 'state your initial vision and 2-3 success criteria beyond the DoD.',
      'Technical Lead': 'sketch your initial technical approach, the main constraint, and the first implementation steps.',
      'QA': 'name the 2-3 biggest risks to meeting this DoD and what you will watch for.',
    };
    let frozen = false;
    for (let round = 1; round <= 3 && !frozen && !termination; round++) {
      const votes = {};
      for (const key of KEYS) {
        const p = providers[key];
        const objText = objections.length
          ? `\n\n## Objections raised in previous rounds — address these\n${objections.map((o) => `- ${o.by}: ${o.reason}`).join('\n')}`
          : '';
        const prompt = `## Phase: RATIFICATION
You are the ${p.cfg.role}. ${ROLE_CARDS[p.cfg.role]}

The brief:
${brief}

${dodText(dod, 'Definition of Done (candidate)')}

What you are voting on: whether each item is ACHIEVABLE and VERIFIABLE as a completion criterion. The work has NOT started — no deliverables exist yet, and that is expected. Rejecting because "the proposal doesn't exist yet" is a category error; the proposal is what the work will produce. Only REJECT an item that is impossible, out of scope, or unverifiable even after the work completes.

First, write 4-8 sentences of substance for the work phase: ${POSITIONS[p.cfg.role]} The other agents will see this, so make it concrete enough to react to.

Then vote with EXACTLY one token:
[[RATIFY]]
[[AMEND: <one specific change>]]
[[REJECT: <reason>]]${objText}

${SENTINEL_PROMPT}`;
    let rt = await runTurn(key, 'ratification', prompt);
    while (['send_failed', 'selector_error', 'provider_error'].includes(rt.status) && !termination) {
        const ans = await rl.question(`${PROVIDERS[key].label}: ${rt.status}. Evidence in debug/. [r] retry / [s] skip this agent (counts as RATIFY) / [a] abort: `);
        const a = ans.trim().toLowerCase();
        if (a.startsWith('s')) { votes[key] = { verdict: 'RATIFY', detail: null }; break; }
        if (!a.startsWith('r')) { setTerm('error'); break; }
        rt = await runTurn(key, 'ratification', prompt);
    }
    if (termination) break;
    if (votes[key] === undefined) votes[key] = parseRatification(rt.response_clean);
      }
      const rejecters = KEYS.filter((k) => votes[k].verdict === 'REJECT');
      const amenders = KEYS.filter((k) => votes[k].verdict === 'AMEND');
      if (rejecters.length) {
        for (const k of rejecters) {
          const reason = votes[k].detail ?? 'no reason';
          log(`Objection from ${PROVIDERS[k].label}: ${reason}`);
          const ans = await rl.question(`Incorporate into the DoD? [y] append as a new item / [n] ignore and re-vote / [a] abort session: `);
          const a = ans.trim().toLowerCase();
          if (a.startsWith('y') && dod.length < 7) {
            dod.push(`Addressed concern (${PROVIDERS[k].label}): ${reason}`);
            log('Objection added as a DoD item');
          } else if (a.startsWith('a')) {
            setTerm('dod_rejected');
          } else {
            objections.push({ by: PROVIDERS[k].label, reason });
          }
        }
      } else if (amenders.length) {
        for (const k of amenders) {
          const detail = votes[k].detail ?? '';
          const m = detail.match(/^(\d+)\s*[:.)]\s*([\s\S]+)$/);
          if (m && dod[Number(m[1]) - 1] !== undefined) {
            dod[Number(m[1]) - 1] = m[2].trim();
            log(`AMEND from ${PROVIDERS[k].label}: item ${m[1]} replaced`);
          } else if (dod.length < 7) {
            const quoted = detail.match(/"([^"]+)"/);
            const itemText = (quoted ? quoted[1] : detail).trim().replace(/\.$/, '');
            const ans = await rl.question(`AMEND from ${PROVIDERS[k].label}: "${itemText.slice(0, 160)}" — apply as a NEW item? [y/n] `);
            if (ans.trim().toLowerCase().startsWith('y')) { dod.push(itemText); log('AMEND applied (new item)'); }
            else log('AMEND declined');
          } else log('AMEND declined (DoD already at 7 items)');
        }
      } else {
        frozen = true;
        freezeTurn = turn;
        ledger.updateMeta({ definition_of_done: [...dod], dod_frozen_at_turn: turn });
        log('DoD ratified unanimously — frozen. Work loop begins.');
      }
    }
    if (!frozen && !termination) {
      const ans = await rl.question('Ratification deadlocked after 3 rounds. [y] freeze as-is and continue, [a] abort: ');
      if (ans.trim().toLowerCase().startsWith('y')) {
        frozen = true;
        freezeTurn = turn;
        ledger.updateMeta({ definition_of_done: [...dod], dod_frozen_at_turn: turn });
        log('DoD frozen by human decision.');
      } else setTerm('dod_rejected');
    }

    // ---- Work loop: round-robin + delta relay ----
    let rr = 0;
    while (!termination) {
      if (ledger.turns.length >= maxTurns) { setTerm('max_turns_reached'); break; }
      let key = null;
      for (let i = 0; i < KEYS.length; i++) {
        const cand = KEYS[(rr + i) % KEYS.length];
        if (states[cand] !== 'SKIPPED') { key = cand; rr = (rr + i + 1) % KEYS.length; break; }
      }
      if (!key) { setTerm('max_turns_reached'); break; }

      const seen = lastSeen[key];
      const deltas = ledger.turns.filter((t) => t.turn > seen && t.agent !== key);
      const revs = pendingRevs[key]; pendingRevs[key] = [];
      const notes = notices[key]; notices[key] = [];
      const stateLines = KEYS.map((k) => `- ${PROVIDERS[k].role}: ${states[k]}`).join('\n');
      const revText = revs.length ? revs.map((r) => `[${r.role} revoked DONE: ${r.reason}]`).join('\n') + '\n\n' : '';
      const deltaText = deltas.length
        ? deltas.map((d) => `[${d.role}]: ${d.response_clean}`).join('\n\n')
        : '(your first work turn — kick things off)';
      const noteText = notes.length ? `## Notice from the orchestrator\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '';
      const skipped = KEYS.filter((k) => states[k] === 'SKIPPED');
      const coverText = skipped.length
        ? `## Session note: ${skipped.map((k) => `${PROVIDERS[k].role} (${PROVIDERS[k].label})`).join(' and ')} ${skipped.length > 1 ? 'have' : 'has'} left the session. The remaining agents MUST cover their duties: make their contributions too, and say clearly when you speak for another role. The DoD is unchanged — a smaller team must still satisfy every item.\n\n`
        : '';
      const prompt = `## Phase: WORK — ratification is complete; the DoD below is FROZEN (frozen at turn ${freezeTurn})
Voting tokens ([[RATIFY]]/[[AMEND]]/[[REJECT]]) are meaningless now and must NOT appear in your response. Produce your actual contribution to the deliverable: react to the other agents' messages, propose content, refine theirs.

${coverText}${dodText(dod, 'Definition of Done (frozen)')}

## Current state
${stateLines}

${revText}## New messages since your last turn
${deltaText}

${noteText}${ROLE_REMINDERS[PROVIDERS[key].role]}

${SENTINEL_PROMPT}`;

      let t = await runTurn(key, 'work', prompt);
      // send/selector failure: give the human the wheel
      while (['send_failed', 'selector_error', 'provider_error'].includes(t.status) && !termination) {
        const ans = await rl.question(`${PROVIDERS[key].label}: ${t.status}. Evidence in debug/. [r] retry / [s] skip this agent for the session / [a] abort: `);
        const a = ans.trim().toLowerCase();
        if (a.startsWith('s')) {
          states[key] = 'SKIPPED';
          ledger.updateMeta({ agent_states: { ...states } });
          log(`${PROVIDERS[key].label}: SKIPPED by human`);
          break;
        }
        if (!a.startsWith('r')) { setTerm('error'); break; }
        t = await runTurn(key, 'work', prompt);
      }
      if (termination) break;
      if (states[key] === 'SKIPPED') continue;

      // ratification tokens during work = protocol violation: re-prompt once
      const looksLikeVote = /\[\[(?:RATIFY|AMEND|REJECT)[^\]]*\]\]/.test(t.response_clean) && t.response_clean.trim().length < 400;
      if (t.status === 'ok' && looksLikeVote) {
        violations[key] = (violations[key] ?? 0) + 1;
        const orig = ledger.turns.find((x) => x.turn === t.turn);
        if (orig) { orig.status = 'protocol_violation'; ledger.saveAll(); }
        log(`${PROVIDERS[key].label}: protocol_violation — re-prompting once`);
        t = await runTurn(key, 'work', `## Phase: WORK — PROTOCOL CORRECTION
You answered with a ratification voting token, but ratification ended at turn ${freezeTurn}. The DoD is frozen. Voting tokens are forbidden in this phase.
Produce your real contribution to the deliverable now: react to the other agents' messages, propose or refine content.\n\n${SENTINEL_PROMPT}`);
        if (termination) break;
      }

      // stuck-loop detection
      if (t.status === 'ok' && similarity(lastClean[key] ?? '', t.response_clean) >= 0.85) {
        stuck[key] = (stuck[key] ?? 0) + 1;
      } else {
        stuck[key] = 0;
      }
      lastClean[key] = t.response_clean;
      if (stuck[key] === 2) {
        notices[key].push('You have repeated yourself — the conversation is not progressing. Produce genuinely new content, or mark BLOCKED with a specific reason, or DONE if the DoD is truly satisfied.');
        log(`${PROVIDERS[key].label}: repeating itself — warning injected`);
      }
      if (stuck[key] >= 3) { setTerm('stuck_no_progress'); log(`${PROVIDERS[key].label}: still repeating — halting`); break; }

      const prev = states[key];
      if (t.declared_status === 'BLOCKED') {
        states[key] = 'BLOCKED';
        ledger.updateMeta({ agent_states: { ...states } });
        const ans = await rl.question(`${PROVIDERS[key].label} is BLOCKED: ${t.blocked_reason ?? 'no reason'}. Press Enter to continue, 'skip' to skip this agent, or 'a' to abort the session: `);
        const a = ans.trim().toLowerCase();
        if (a === 'skip') { states[key] = 'SKIPPED'; log(`${PROVIDERS[key].label}: SKIPPED by human`); }
        else if (a.startsWith('a')) { setTerm('human_abort'); }
        else states[key] = 'IN_PROGRESS';
        ledger.updateMeta({ agent_states: { ...states } });
        continue;
      }
      if (t.declared_status === 'DONE') {
        if (prev !== 'DONE') log(`${PROVIDERS[key].label}: marked DONE`);
        states[key] = 'DONE';
      } else {
        if (prev === 'DONE') {
          const m = t.response_clean.match(/item\s*(\d+)/i);
          const reason = m ? `item ${m[1]} unmet` : (t.response_clean.split('\n').find((l) => l.trim()) ?? '').slice(0, 140);
          for (const k of KEYS) if (k !== key && states[k] !== 'SKIPPED') pendingRevs[k].push({ role: PROVIDERS[key].role, reason });
          log(`${PROVIDERS[key].label}: revoked DONE (${reason})`);
        }
        states[key] = 'IN_PROGRESS';
      }
      ledger.updateMeta({ agent_states: { ...states } });

      const active = KEYS.filter((k) => states[k] !== 'SKIPPED');
      if (active.length > 0 && active.every((k) => states[k] === 'DONE')) {
        if (active.length === KEYS.length) {
          setTerm('unanimous_done');
        } else {
          const ans = await rl.question(`All remaining agents are DONE, but ${KEYS.length - active.length} agent(s) were skipped. Accept unanimous_done? [y/n] `);
          if (ans.trim().toLowerCase().startsWith('y')) setTerm('unanimous_done');
          else {
            for (const k of active) { states[k] = 'IN_PROGRESS'; notices[k].push('The human rejected an early unanimous_done. Keep working — satisfy every DoD item concretely.'); }
            ledger.updateMeta({ agent_states: { ...states } });
          }
        }
      }
    }

    // ---- wrap up ----
    ledger.addTurn({
      turn: turn + 1, agent: '(orchestrator)', role: '—', phase: 'termination',
      timestamp: new Date().toISOString(), prompt_sent: '', response_raw: '',
      response_clean: `termination_reason: ${termination}`,
      declared_status: '—', blocked_reason: null, vote: null, dod_snapshot: [...dod], status: 'ok', error: null,
    });
    ledger.updateMeta({ ended_at: new Date().toISOString(), termination_reason: termination, agent_states: { ...states } });
    log(`session complete — ${termination}`);
    log(`outputs: ${ledger.dir}/{transcript.md,ledger.json,meta.json}`);
  } finally {
    rl.close();
    for (const p of Object.values(providers)) await p.close().catch(() => {});
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });