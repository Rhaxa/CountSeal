# 🦭 CountSeal

**A council of AI agents that counts its votes until it seals the deal.**

![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![Playwright](https://img.shields.io/badge/playwright-1.57.0-45ba4b)
![Browser](https://img.shields.io/badge/browser-Firefox-ff7139)
![Cost](https://img.shields.io/badge/API%20cost-%240-2ea44f)
![License](https://img.shields.io/badge/license-MIT-blue)

&lt;/div&gt;

---

## The elevator pitch

&gt; **CountSeal is a multi-agent AI orchestrator where a council of AI agents debates, votes, and reaches consensus to "seal the deal" on decisions.** It drives three real, logged-in browser sessions (DeepSeek, Kimi, Qwen) through Playwright, relays only unseen messages between them (delta relay), and terminates the moment every agent commits to DONE against a frozen, human-approved Definition of Done.

No APIs. No subscriptions. The orchestrator is ~800 lines of dependency-light Node.js; the "database" is each provider's native chat history.

## Demo



https://github.com/user-attachments/assets/53ea09db-2f65-48c6-943a-0298e34ab0d9


&lt;div align="center"&gt;

```text
[11:53:55] DeepSeek: vote → RATIFY
[11:54:32] Kimi: vote → RATIFY
[11:55:33] DoD ratified unanimously — frozen. Work loop begins.
[11:56:16] Kimi: marked DONE
[11:56:55] Qwen: marked DONE
[11:58:58] DeepSeek: marked DONE
[11:59:01] session complete — unanimous_done
```

## Why I built it

Single LLM calls hallucinate and self-validate. I wanted to explore whether **multi-agent architectures with role separation and explicit consensus gates** produce more reliable decisions than one model talking to itself — a QA agent that can *revoke* DONE citing a specific unverified item is a structural check no prompt wrapper provides.

Just as interesting to me: could this be built with **zero API spend**? Instead of paid endpoints, CountSeal treats commercial chat UIs as the transport layer. That constraint forced the hard, fun engineering — protocol design over brittle DOMs, message-boundary detection, and graceful human-in-the-loop failure handling — which is where most of the value of this project lives.

## How it works

Every reply is framed by a machine-readable protocol, so a chat UI becomes a reliable IPC channel:

- **Sentinel protocol** — each agent must end every response with `[[END_7f3a]]` + exactly one status line: `[[STATUS: IN_PROGRESS | DONE | BLOCKED: reason]]`.
- **Phase 0 ratification** — the orchestrator proposes a candidate Definition of Done; each agent votes `[[RATIFY]] / [[AMEND: ...]] / [[REJECT: ...]]`. Amendments route to a human for approval; the DoD is then frozen and re-injected verbatim into every prompt.
- **Delta relay** — agents receive *only* messages they haven't seen, prefixed by role, keeping context small and conversations coherent across three independent chat histories.
- **Sticky DONE + revocation** — DONE is a commitment; revoking it must cite the specific unmet DoD item, and the revocation is injected into every other agent's next prompt.
- **Six distinguishable termination reasons** — `unanimous_done`, `max_turns_reached`, `dod_rejected`, `human_abort`, `error`, `stuck_no_progress`.

```mermaid
sequenceDiagram
    autonumber
    participant O as Orchestrator
    participant D as DeepSeek (Product Owner)
    participant K as Kimi (Technical Lead)
    participant Q as Qwen (QA)

    Note over O,Q: Phase 0 — DoD ratification
    O-&gt;&gt;D: Brief + candidate DoD
    D--&gt;&gt;O: Position + [[RATIFY]]
    O-&gt;&gt;K: Brief + candidate DoD
    K--&gt;&gt;O: Position + [[RATIFY]]
    O-&gt;&gt;Q: Brief + candidate DoD
    Q--&gt;&gt;O: Risks + [[AMEND: add data-model item]]
    Note over O: Human approves amendment — DoD frozen

    Note over O,Q: Work loop — round-robin, delta relay
    O-&gt;&gt;D: Frozen DoD + unseen messages
    D--&gt;&gt;O: Proposal draft
    O-&gt;&gt;K: Frozen DoD + [PO] message
    K--&gt;&gt;O: Technical critique
    O-&gt;&gt;Q: Frozen DoD + [PO] + [TL]
    Q--&gt;&gt;O: Verification — [[STATUS: DONE]]
    Note over O: All agents DONE — seal the deal
```

## Quickstart

Requires macOS and Node ≥ 22.

```bash
git clone https://github.com/YOUR-USERNAME/countseal.git
cd countseal
npm install
npx playwright install firefox     # once per machine
node index.js --brief briefs/example-brief.md --max-turns 30
```

On first run, three Firefox windows open (persistent, isolated profiles). Log in to each provider manually once — credentials are never touched by the tool; login state lives in `profiles/` and persists forever. From then on, every run is one command.

### Why no Docker?

CountSeal's execution model *is* your desktop: three headful browsers carrying your real authenticated sessions. A container would launch three browsers with no identity and nothing to orchestrate. The project deliberately trades `docker-compose up` for `npm install` + one command — no services, no build step, no daemons.

## Every run produces

`conversations/&lt;session-id&gt;/`, written incrementally (crash-safe), older runs never touched:

| File | Contents |
|---|---|
| `transcript.md` | Human-readable meeting, regenerated every turn |
| `ledger.json` | Full audit trail: prompt sent, raw + cleaned response, declared status, DoD snapshot |
| `meta.json` | Frozen DoD, per-agent state and last-seen cursor, termination reason |
| `debug/` | Auto-captured screenshot + HTML dump on any failure |

## Engineering challenges → solutions

The hard part of this project is trusting a chat UI as a message bus. Highlights:

| Challenge | Solution |
|---|---|
| No message-boundary API | Sentinel + status-line protocol; completion = marker present **and** text stable across two polls |
| Stale replies mistaken for fresh ones | Pre-send signature set of all completed replies; candidates matching any are rejected |
| Chat UIs collapse/truncate sent messages | Never match on prompt text — locate replies by protocol shape alone |
| Silent send failures (overlays, disabled inputs, React-controlled fields) | 5-level fallback: Enter → retry → force-click → JS native-value injection → `role=button` Send click, with DOM-growth verification |
| Provider outages ("high demand" banners) | Fail-fast banner detection instead of burning 3-minute timeouts; human retry/skip/abort gate |
| Agents echoing votes or looping | Phase-aware prompts, one-shot protocol-violation re-prompts, similarity-based stuck-loop detection with escalation |
| Third-party DOM drift | All selectors in one `config.js`; `diag.js` tool dumps which elements actually contain protocol markers |

## Project layout

```
config.js     provider URLs, selectors, roles — the only file you edit when a site changes
providers.js  browser automation (one hardened driver, three providers)
index.js      orchestrator: ratification, delta relay, state machine, termination
sentinel.js   protocol parser (with self-tests)
ledger.js     transcript / ledger / meta writers
util.js       logging, debug capture
diag.js       DOM diagnostic for selector maintenance
briefs/       meeting briefs with a Definition of Done
```

## Roadmap

- Thinking-block filtering for cleaner transcripts
- Resume/inspect mode from `meta.json` chat URLs
- Pluggable council sizes (2–5 agents)
- Headless mode once provider ToS allows it

## License

MIT
