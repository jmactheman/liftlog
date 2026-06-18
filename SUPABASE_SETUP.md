# Enabling cloud sync + agent access

The app works fully offline without this. Do these steps when you want finished
workouts to back up to the cloud so your **health agent** can read them.

## 1. Create a Supabase project
- Go to <https://supabase.com> → **New project**. Pick a name + a strong DB password.
- Wait for it to provision (~1 min).

## 2. Create the tables
- Dashboard → **SQL Editor** → **New query**.
- Paste the entire contents of [`SUPABASE_SETUP.sql`](SUPABASE_SETUP.sql) and click **Run**.
- This creates 5 tables (`exercises`, `workouts`, `sets`, `templates`, `settings`),
  each with Row-Level Security so users only ever see their own rows.

## 3. Wire up the app
- Dashboard → **Project Settings → API**.
- Copy the **Project URL** and the **publishable (anon)** key.
- Open [`auth.js`](auth.js) and replace the two placeholders near the top:
  ```js
  var SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
  var SUPABASE_KEY = 'your-publishable-anon-key';
  ```
  The anon key is **meant** to be public — RLS is what protects data. Never paste
  the *secret* key here.
- Bump the cache version so the change ships: in `index.html` bump every `?v=N`,
  and in `sw.js` bump `CACHE = 'liftlog-vN'`. Commit + push.

## 4. Allowlist the app URL (for sign-in)
- Dashboard → **Authentication → URL Configuration**.
- Set **Site URL** to `https://jmactheman.github.io/liftlog/`.
- Add the same to **Redirect URLs**. (Add `http://localhost:8137/` too if you want
  to test magic-link locally — note Google OAuth only works on the live URL.)
- For Google sign-in: **Authentication → Providers → Google** → enable + paste a
  Google OAuth client. (Email magic-link works out of the box on the test sender.)

## 5. Done
Sign in from the **Profile** tab. Your local data is adopted into the account on
first sign-in, then every finished workout pushes automatically.

---

## How the health agent reads workouts

Two options, easiest first:

### A. Direct query (no extra code)
Give the agent read access (a service-role key kept server-side, or a dedicated
read user). New finished workouts are rows in `workouts` with a non-null
`data->>'finishedAt'`; their sets are in `sets` keyed by `data->>'workoutId'`.

```sql
-- workouts finished since the agent last looked
select id, data
from workouts
where (data->>'finishedAt') is not null
  and (data->>'finishedAt')::timestamptz > :last_seen
order by (data->>'finishedAt')::timestamptz;

-- the sets for one workout
select data from sets where data->>'workoutId' = :workout_id;
```

Each `workouts.data` is the full workout object (`label`, `location`, `startedAt`,
`finishedAt`, `exerciseOrder`). Each `sets.data` has `exerciseName`, `weight`,
`reps`, `done`, `isPR`, `prTypes` (`1RM`/`VOL`/`WEIGHT`).

### B. A small MCP (nicer for the agent — later)
Wrap the queries above in an MCP server (like the existing quicken-cfo MCP) with
tools such as `get_recent_workouts(since)` and `get_exercise_history(name)`. Then a
scheduled agent can summarize each new session. Deferred until the data's flowing.
