# Between the Tiers

An animated brief and five-question quiz on **three-tier architectures**, built for the Group-03 presentation
(Database Applications and Data Warehousing, IIFT Kakinada).

## What is inside

- **Start page**: boot preloader, chrome title, isometric three-tier stack, scroll-driven brief, stacking tier cards,
  a pinned seven-step "Place Order" request flow, the four presentation parts, key numbers and a live top-5.
- **Quiz** (`#quiz`): five multiple-choice questions taken from the presentation. 100 points per correct answer
  plus up to 50 speed-bonus points (max 750). Answers are shuffled on every run.
- **Leaderboard** (`#leaderboard`): best run per player, ranked by score and then total time.

Everything lives in a single file, `index.html` (HTML, CSS and vanilla JavaScript, no build step).
Fonts (Unbounded, JetBrains Mono, Manrope) load from Google Fonts.

## Running it

Open `index.html` in a browser, or serve the folder with any static server:

```bash
python3 -m http.server 8000
```

## About the leaderboard

The leaderboard uses the `db` and `user` runtime capabilities of a claude.ai Artifact. In that environment scores are
stored in a `scores` collection, one document per signed-in player (`scores/<player id>`) with the fields
`handle`, `best`, `correct`, `ms`, `attempts`, `last` and `updatedAt`. Access rules:

```json
{ "db": { "rules": [
  { "path": "scores", "read": "view", "write": "owner" },
  { "path": "scores/{self}", "write": "interact" }
] }, "user": { "scopes": ["profile"] } }
```

When the page is opened outside claude.ai (for example from GitHub Pages or a local file) those capabilities are not
available. The brief and the quiz work normally, and the leaderboard shows an "offline" message instead of scores.
To get a leaderboard on a normal website, replace the data layer (`initData`, `saveScore` and `renderBoard` in the
script) with calls to your own backend or a hosted database.

## Credits

Group-03, IIFT Kakinada. Built by Sai Kiran.
Source material: Hoffer, Ramesh and Topi, *Modern Database Management*.
