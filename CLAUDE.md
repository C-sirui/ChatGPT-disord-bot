# Repository notes for Claude

This branch (`token-relay`) holds **Token Relay** in `token-relay/`. The rest
of the repo is an older Discord bot (`discord-bot.py`, `chatgpt.py`) that is
unrelated.

Before working on Token Relay, read `token-relay/HANDOFF.md`. It has the
current state, standing decisions (including the rule on consumer-quota
resale), questionnaire answers and next steps.

* Work inside `token-relay/`: `npm install`, `npm test`, `npm run typecheck`.
* Keep tests green on SQLite and Postgres (`TEST_DATABASE_URL`).
* Money is integer micro-USD. Ledger transactions must balance.
