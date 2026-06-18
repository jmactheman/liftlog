# LiftLog MCP server

A local, **read-only** MCP server that exposes your finished workouts (synced to
Supabase by the LiftLog PWA) to an AI health agent.

## Tools
- `list_recent_workouts(since?, limit?)` — recent finished workouts with sets, volume, duration, PRs
- `get_workout(workout_id)` — full detail of one workout
- `get_exercise_history(exercise, location?, limit?)` — one lift over time (location-scoped optional)
- `list_exercises()` — your exercise library
- `get_personal_records(exercise?, limit?)` — sets flagged 1RM / VOL / WEIGHT
- `get_training_summary(since?)` — volume, set counts, body-part & location breakdown

## Setup
```bash
cd mcp
npm install
cp .env.example .env      # then paste your service_role key into .env
```
Get the **service_role** key from Supabase → **Settings → API**. It bypasses
Row-Level Security, so it stays **local only** (`.env` is gitignored). This server
never writes.

## Register with Claude Code
The server reads its config from the local `.env` above, so the registration
command holds no secrets:
```bash
claude mcp add liftlog -s user -- node /Volumes/EXCHANGE/liftlog/mcp/server.js
```
Then the health agent can call the tools above. Verify with `claude mcp list`.

## Notes
- Single-user by default (returns all rows). Set `LIFTLOG_USER_ID` to scope to one user.
- Requires Node 18+ (uses global `fetch`).
