# Between the Tiers

An animated brief and five-question quiz on **three-tier architectures**, built for the Group-03 presentation
(Database Applications and Data Warehousing, IIFT Kakinada), with a live leaderboard.

The project is itself a three-tier application:

| Tier | What | Where |
|---|---|---|
| 1 Client | The page: animated brief, quiz and leaderboard (vanilla HTML, CSS and JavaScript, one file) | `index.html` |
| 2 Application | One serverless function that validates input, hashes secrets and calls the database | `api/quiz.js` (Vercel) |
| 3 Database | PostgreSQL tables, a trigger and four stored procedures | `supabase/schema.sql`, `supabase/seed.sql` (Supabase) |

The browser never talks to the database. It posts to `/api/quiz`; the function calls a stored procedure with the
service-role key. Tables have row level security on and no policies, so the public anon key can read nothing.

## How the quiz is protected

- **The answer key stays in the database.** Questions are sent to the browser without their answers. Each pick is sent
  to the server, graded by `answer_question`, and only then does the browser learn what was right and why.
- **The database clock times every answer**, so the speed bonus cannot be faked from the browser.
- **Questions must be answered in order, once each**, and a run can be finished once.
- **A callsign belongs to one device.** The browser keeps a random secret in `localStorage`; only its salted SHA-256
  hash is stored. Nobody else can submit under your callsign. If you clear your browser data you lose that callsign.
- **Rate limits** inside `start_run`: at most 20 runs per 10 minutes per address and 10 per 10 minutes per player
  (addresses are stored only as salted hashes).
- **Scoring**: 100 points per correct answer plus up to 50 speed-bonus points that drain over 30 seconds. Maximum 750.
  The leaderboard keeps each player's best run (higher score first, then lower total time).

Limits to be aware of: this is a class project, not a bank. Someone with a script can still play many runs spread over
time, and `seed.sql` (the answer key) is in this repository, so anyone who reads the repo can read the answers. Keep the
repo private or remove `seed.sql` after seeding if that matters to you.

## Database design

```
players(id, handle, secret_hash, created_at)          unique on lower(handle)
questions(id, position, tag, prompt, options, correct_idx, explanation, slide)
runs(id, player_id -> players, ip_hash, started_at, finished_at, score, correct, total_ms)
run_answers(run_id -> runs, question_id -> questions, choice, is_correct, elapsed_ms, points, answered_at)
leaderboard(player_id -> players, best_score, correct, total_ms, attempts, updated_at)
```

- `start_run(handle, secret_hash, ip_hash)` claims or verifies a callsign, rate limits, opens a run, returns the questions.
- `answer_question(run, secret_hash, question, choice)` grades one answer and times it.
- `finish_run(run, secret_hash)` totals the run; a **trigger** (`runs_after_finish`) then updates `leaderboard`.
- `get_board(limit, secret_hash)` returns the ranked board; `rank()` gives tied scores the same place.

## Deploy (about 10 minutes)

1. **Supabase.** Create a project at supabase.com. Open **SQL Editor**, run `supabase/schema.sql`, then run
   `supabase/seed.sql`. Copy two values: the **Project URL** (**Project Settings > Data API**, it looks like
   `https://abcdxyz.supabase.co`) and the **Secret key** (**Project Settings > API Keys > Secret keys**, the one starting
   `sb_secret_`; click the eye icon to reveal it). The publishable key is not used by this app.
2. **Vercel.** Import this GitHub repository. Framework preset **Other**, no build command, no output directory.
   Add three environment variables (see `.env.example`):
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the Secret key (secret: only ever put it in Vercel, never in the repo or the page).
     Despite the variable's name, the new `sb_secret_...` key and a legacy `service_role` key both work.
   - `HASH_PEPPER`: a long random string, for example the output of `openssl rand -hex 32`
3. **Deploy**, open the site and play one run. Your callsign should appear on the leaderboard.

The leaderboard refreshes every 10 seconds and right after you finish a run (it polls the function instead of holding
a websocket open, which suits serverless hosting). Supabase Realtime could replace the polling later.

## Running it locally and testing

`index.html` needs `/api/quiz`, so open it through Vercel (`npx vercel dev` with the three variables set) or use the
test harness, which runs the real function against an in-memory PostgreSQL (PGlite):

```bash
npm install
npm test            # database + function tests (22 checks)
npx playwright install chromium   # once
npm run test:e2e    # drives the real page in a browser (13 checks)
```

## Everyday admin (Supabase SQL editor)

```sql
-- remove a player and all their runs
delete from players where lower(handle) = lower('SomeName');

-- wipe the leaderboard and every run, keep players and questions
truncate leaderboard, run_answers, runs cascade;

-- edit the questions: change seed.sql and run it again (it updates in place)
```

## Credits

Group-03, IIFT Kakinada. Built by Sai Kiran.
Source material: Hoffer, Ramesh and Topi, *Modern Database Management*.
