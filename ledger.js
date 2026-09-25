// ledger.js — per-session outputs: ledger.json, transcript.md, meta.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SENTINEL } from './config.js';

export class Ledger {
  constructor(sessionId, briefPath, maxTurns) {
    this.dir = path.join('conversations', sessionId);
    mkdirSync(this.dir, { recursive: true });
    this.turns = [];
    this.meta = {
      session_id: sessionId,
      started_at: new Date().toISOString(),
      ended_at: null,
      brief_path: briefPath,
      sentinel: SENTINEL,
      max_turns: maxTurns,
      playwright_version: '1.57.0',
      browser: 'firefox',
      definition_of_done: null,
      dod_frozen_at_turn: null,
      agent_states: {},
      agents: {},
      termination_reason: null,
    };
    this.saveAll();
  }

  addTurn(turn) { this.turns.push(turn); this.saveAll(); }
  updateMeta(patch) { Object.assign(this.meta, patch); this.saveAll(); }

  saveAll() {
    writeFileSync(path.join(this.dir, 'ledger.json'), JSON.stringify(this.turns, null, 2), 'utf8');
    writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2), 'utf8');
    writeFileSync(path.join(this.dir, 'transcript.md'), this.renderTranscript(), 'utf8');
  }

  renderTranscript() {
    const m = this.meta;
    const lines = [
      `# Session ${m.session_id}`,
      `**Brief:** ${m.brief_path}`,
      `**Started:** ${m.started_at}`,
      `**Termination:** ${m.termination_reason ?? 'in progress'}`,
      `**Final agent states:** ${Object.entries(m.agent_states).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
      '',
    ];
    if (m.definition_of_done) {
      lines.push(`## Definition of Done (frozen at turn ${m.dod_frozen_at_turn})`);
      m.definition_of_done.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
      lines.push('', '---', '');
    }
    for (const t of this.turns) {
      const marker = t.phase === 'ratification' ? (t.vote ?? 'no vote') : t.declared_status;
      lines.push(`## Turn ${t.turn} — ${t.role} (${t.phase})`);
      lines.push(`*${t.timestamp}* — status: \`${marker}\``, '');
      lines.push(t.response_clean || `_${t.status}${t.error ? ': ' + t.error : ''}_`, '', '---', '');
    }
    return lines.join('\n');
  }
}