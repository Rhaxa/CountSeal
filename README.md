# CountSeal

*A council of AI agents that counts its votes until it seals the deal.*

## What it does

You give it a brief with a Definition of Done. It opens three Firefox windows (persistent profiles, already logged in), has the agents ratify the DoD, then runs a round-robin work loop where each agent only receives the messages it hasn't seen yet (delta relay). The session ends when all agents unanimously mark DONE, or via a safety cap. Every run writes a human-readable transcript plus machine-readable ledger and metadata to `conversations/<session-id>/`.

## Requirements

- macOS 13+ (developed on Ventura; `playwright` is pinned to `1.57.0` because 1.58+ drops macOS 13)
- Node.js 22+ (`node -v` to check)
- Accounts on the three providers (log in manually, once — the tool never touches credentials)

## Setup

npm install
npx playwright install firefox   # only needed once per machine
Login is manual and happens on first run: when a browser window opens and the terminal says `>>> LOG IN NOW <<<`, log in normally and wait. The session is saved in `profiles/<provider>/` forever after.

## Run

node index.js --brief briefs/example-brief.md --max-turns 30

- `--brief` — path to a markdown file containing a `## Definition of Done` numbered list (3–7 verifiable items).
- `--max-turns` — safety cap, including ratification turns.

During a run the terminal may ask you questions (approve a DoD amendment, resolve a BLOCKED agent, retry/skip a failing provider). Answer there; the browsers keep working. Ctrl+C aborts cleanly and still saves everything.

## Outputs

`conversations/<session-id>/` — one folder per run, older runs are never touched:
- `transcript.md` — the meeting, regenerated after every turn
- `ledger.json` — one entry per turn (prompt, raw/clean response, status)
- `meta.json` — frozen DoD, agent states, termination reason
- `debug/` — screenshots + HTML dumps, written automatically on any failure

## Maintenance (the part you'll actually use)

Chat sites redesign their pages; when a selector breaks, a turn fails with `selector_error` and a screenshot/HTML dump lands in `debug/`.

1. Look at the `.png` in `debug/` (or paste the terminal error to a trusted helper).
2. Edit the provider's selectors in `config.js` (`input`, `messages`; `errorText` is an optional outage-banner detector).
3. `node diag.js` opens Qwen's profile and dumps which DOM elements contain the sentinel text — a permanent debugging tool for exactly this.

The send path is hardened (Enter → retries → force-click → JavaScript value injection → role=button click), so most transient page weirdness resolves itself; persistent failures land in the human-retry prompt instead of crashing.

## Layout

config.js     all provider URLs/selectors/roles — the ONLY file you should edit
providers.js  browser automation (one class, three providers)
index.js      orchestrator: ratification, delta relay, state machine, termination
sentinel.js   sentinel/status parser (self-test included)
ledger.js     transcript/ledger/meta writers
util.js       logging, sleeps, debug capture
diag.js       DOM diagnostic for selector fixes
briefs/       your meeting briefs
profiles/     browser login state (gitignored — never commit, never delete casually)
conversations/ session outputs (gitignored)

## Notes

- Roles and speaking order are set by the order of blocks in `PROVIDERS` in `config.js`.
- Token cost note: every turn is a real message in your provider accounts, billed to whichever account is logged into each profile.
- `node --check <file>` syntax-checks any edited file without running anything.