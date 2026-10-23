# Build Prompt: "Bot or Not" — LAN Web Game

Build a small, LAN-hosted web application called **Bot or Not**. Participants are shown a random image (which may be AI-generated or a real photo) and guess by clicking one of two buttons: **Bot** (AI-generated) or **Not** (real). The app tracks every guess, scores accuracy, and has a password-protected admin dashboard.

Keep everything **as simple as possible**. No frameworks beyond what's specified. No build step. No database — just the filesystem. No CSS animations, no fancy UI — a clean, minimal, functional interface only (system fonts, basic layout, no shadows/gradients/transitions beyond a simple hover state at most).

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Plain HTML + vanilla JS + minimal CSS (no React, no build tools, no CSS frameworks)
- **Storage:** Filesystem only — JSON config files, an append-only JSONL log file, and a static image folder
- **Auth:** Simple session-cookie-based auth for admin only (no auth needed for participants beyond entering a username)
- **Password hashing:** Use some simple hash to store the admin password in an .env file
- **Env config:** dotenv, for the admin password — never hardcode secrets in source

---

## Folder Structure

```
bot-or-not/
├── server.js                  # Express app entry point
├── .env                       # ADMIN_PASSWORD_HASH lives here (simple hash and gitignored)
├── .env.example                # template, no real secret
├── .gitignore                  # must include .env, node_modules, data/responses.jsonl, images/
├── config.json                 # runtime-tweakable settings (session duration etc.)
├── data/
│   ├── manifest.json            # ground truth: image id -> label -> filename
│   └── responses.jsonl          # append-only log of every answer ever given
├── images/datasets
│   ├── not/                    # real photos, anonymized filenames
│   └── bot/                      # AI images, anonymized filenames
├── public/
│   ├── index.html                # login screen
│   ├── game.html                 # main gameplay screen
│   ├── results.html              # end-of-session summary + leaderboard link
│   ├── leaderboard.html          # public leaderboard view
│   ├── admin-login.html          # admin password entry
│   ├── admin.html                 # admin dashboard (protected)
│   └── style.css                  # one shared minimal stylesheet
└── scripts/
    └── build-manifest.js         # one-time script to scan images/datasets/bot and images/datasets/bot,
                                    # assign anonymized IDs along with Private IP addresses, and generate manifest.json
```

---

## Step 0: Anonymizing the dataset (critical — do this first)

Before serving any images, write `scripts/build-manifest.js` to:

1. Scan `images/datasets/bot/` and `images/datasets/bot/` for image files.
2. For each file, generate a random opaque ID (e.g. `crypto.randomUUID()` or a random 8-char hex string) — **do not use the original filename or any label-revealing string as the ID.**
3. Copy or rename each file to `images/datasets/bot/<id>.jpg` / `images/datasets/bot/<id>.jpg` (preserve original extension - the images can be of different extensions (webp, png , gif ,.. anything and the website should be able to handle it)).
4. Write `data/manifest.json` as an array:
   ```json
   [
     { "private_ip" : "172.41.0.156", "id": "a1b2c3d4", "label": "bot", "filename": "a1b2c3d4.jpg" },
     { "private_ip" : "172.41.0.157", "id": "9f8e7d6c", "label": "not", "filename": "9f8e7d6c.jpg"  },
   ]
   ```

This step matters because **the client must never be able to infer the label from the URL, filename, folder path, or any HTTP response**. Images must be served through a single route like `GET /api/image/:id` that looks up the file by ID and streams it — the client never sees `/images/datasets/bot/...` or `/images/datasets/not/...` directly, and the label is never present in any response the client receives until after they've submitted their answer (see below).

---

## Data Files

### `config.json` (admin-editable at runtime)
```json
{
  "sessionDurationMinutes": 10
}
```
Read fresh from disk on every login (don't cache in memory at server startup) so admin edits take effect for new sessions without a server restart.

### `data/responses.jsonl` (append-only, one JSON object per line)
```json
{"username":"prajwal","imageId":"a1b2c3d4","trueLabel":"bot","choice":"not","correct":true,"timestamp":"2026-07-14T10:32:01.000Z","responseTimeMs":2140}
```
Every answer submission appends exactly one line via `fs.appendFile` — never read-modify-write the whole file, to avoid race conditions if multiple participants answer simultaneously.

### `.env`
```
ADMIN_PASSWORD=<bcrypt hash, generated once via a small setup script or node -e>
SESSION_SECRET=<random string for signing the admin session cookie>
```
Provide a short one-off Node snippet or npm script (`npm run set-admin-password -- "mypassword"`) that hashes a plaintext password with bcrypt and prints the hash, so the developer can paste it into `.env` without ever storing plaintext anywhere.

---

## Backend: API Endpoints

### Participant flow

**`POST /api/login`**
Body: `{ "username": "string" }`
- Trim/validate username (non-empty, reasonable length, maybe alphanumeric + spaces).
- If this username is already an active session (in-memory), reject with a clear error ("username taken this session, pick another") — prevents two people colliding.
- Create an in-memory session: `{ username, startTime: now, endTime: now + config.sessionDurationMinutes * 60000, servedImageIds: Set(), }`
- **Important:** read `sessionDurationMinutes` from `config.json` fresh at this moment and lock it into `endTime` for this session. Later admin changes to config must not affect already-started sessions.
- Set a simple cookie or return a session token identifying this username to use on subsequent requests (also include the private IP if possible).
- Response: `{ endTime: <ISO timestamp>, sessionDurationMinutes: <number> }`

**`GET /api/next-image`**
- Requires valid active session (via cookie/token).
- If `now > session.endTime`, return `{ sessionEnded: true }` — don't serve another image.
- Pick a random image from the manifest whose ID is not in `session.servedImageIds` (if the whole pool is exhausted, either allow repeats or return a "no more images" flag — allowing repeats is fine for a small pool).
- Add it to `servedImageIds`.
- Response: `{ imageId: "a1b2c3d4", imageUrl: "/api/image/a1b2c3d4" }` — **never include `label` here.**

**`GET /api/image/:id`**
- Look up the ID in the manifest, stream the corresponding file from `images/datasets/bot/` or `images/datasets/not/` with correct content-type. 404 if not found.

**`POST /api/answer`**
Body: `{ "imageId": "a1b2c3d4", "choice": "bot" | "not", "responseTimeMs": 2140 }`
- Requires valid active session.
- If `now > session.endTime`, reject — no late answers.
- Look up the true label from the manifest.
- `correct = (choice === "bot" && trueLabel === "bot") || (choice === "not" && trueLabel === "not")`
- Append one line to `data/responses.jsonl` with all fields (see schema above).
- Response: `{ correct: true/false, trueLabel: "bot"|"not" }` — **now it's fine to reveal the label, since they've already answered.** This lets the frontend show immediate right/wrong feedback if you want it (nice touch, keep it simple — a small text flash, not an animation).

**`GET /api/session-status`**
- Returns `{ remainingMs: number, active: boolean }` for the current session — used by the frontend to keep its countdown honest even after tab refocus/reload.

**`GET /api/leaderboard`**
- Read and parse `data/responses.jsonl` fully (fine at this scale — no need to optimize).
- Group by `username` and `private_ip`, compute `{ username, totalAnswered, correctCount, accuracyPercent }`.
- Sort by `accuracyPercent` descending, tiebreak by `totalAnswered` descending.
- Response: sorted array. Public endpoint, no auth needed.

### Admin flow

**`POST /api/admin/login`**
Body: `{ "password": "string" }`
- Compare against `bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH)`.
- On success, set a signed httpOnly session cookie (using `SESSION_SECRET`) marking this browser as admin-authenticated.
- On failure, generic error, no hints.

**`GET /api/admin/logs`** (protected — check admin cookie, 401 if missing/invalid)
- Return the full parsed contents of `responses.jsonl` as JSON array, plus summary stats (total participants, total answers, overall accuracy).

**`GET /api/admin/config`** (protected)
- Return current `config.json` contents.

**`POST /api/admin/config`** (protected)
Body: `{ "sessionDurationMinutes": number }`
- Validate it's a positive number, write to `config.json`.
- Does NOT affect already-active sessions (see login logic above).

**`GET /api/admin/active-sessions`** (protected)
- Return current in-memory sessions: `[{ username, startTime, endTime, remainingMs }]` — lets the admin see who's currently playing live.

**`GET /api/admin/export`** (protected)
- Stream `responses.jsonl` as a file download (or convert to CSV — either is fine, pick whichever is less code).

All `/api/admin/*` routes except `/api/admin/login` must go through an Express middleware that checks the signed admin cookie and returns 401 if invalid/missing.

---

## Frontend Pages

### `index.html` — Login
- Single text input for username, one "Start" button.
- On submit, `POST /api/login`. On success, redirect to `game.html` (store username + endTime in `sessionStorage` for the game page to read, alongside relying on the server-set cookie for actual auth).
- Show inline error if username taken or empty.

### `game.html` — Gameplay
- Big centered image (`<img>` tag, fetched from `/api/next-image` then pointed at `/api/image/:id`).
- Two large buttons below: **Bot** and **Not**. (You can use some simple and minimal styling)
- Small countdown timer visible at top (e.g. `MM:SS`), driven by `endTime` from login response, corrected periodically via `/api/session-status` in case of clock drift or reload.
- On button click:
  - Record `responseTimeMs` (time since image was displayed).
  - `POST /api/answer`.
  - Fetch next image automatically.
- When `sessionEnded: true` comes back from `/api/next-image` (or the countdown hits zero), stop the game and redirect to `results.html`.
- Disable both buttons while a request is in-flight (prevent double-submits on one image).

### `results.html` — Session summary
- Show this participant's own stats for the session just played (fetch from `/api/leaderboard`, find their row — or add a small `/api/my-stats?username=` endpoint if simpler).
- Link/button to `leaderboard.html`.

### `leaderboard.html` — Public leaderboard
- Simple table: rank, private_ip, username, accuracy %, total answered.
- Sorted server-side already; just render as-is.
- Auto-refresh every ~10s via `setInterval` + refetch, or a manual refresh button — either is fine, keep it simple.

### `admin-login.html`
- Password field, submit button, `POST /api/admin/login`, redirect to `admin.html` on success.

### `admin.html` — Admin dashboard (protected)
- Section 1: **Live sessions** — table of currently active participants and their remaining time (`/api/admin/active-sessions`, poll every few seconds).
- Section 2: **Full logs** — table or scrollable list of all answers ever logged (`/api/admin/logs`), with basic columns: username, image id, true label, choice, correct, timestamp.
- Section 3: **Settings** — a single number input for session duration in minutes, pre-filled from `/api/admin/config`, a "Save" button that `POST`s the update. Show a note: "Changes apply to new sessions only, not sessions already in progress."
- Section 4: **Export** — a button/link to download the full JSONL/CSV log.
- If the admin cookie is missing/invalid on page load, redirect to `admin-login.html`.

---

## Styling (`style.css`)

Minimal and functional only:
- System font stack (`font-family: system-ui, sans-serif` or any other minimal font that should work offline (without internet))
- Centered, max-width container (~600-800px) for readability
- Buttons: large, clearly tappable (this may be used on various devices), simple border + background color, one subtle `:hover`/`:active` state change — no transitions beyond maybe `transition: background-color 0.1s`
- No gradients, no box-shadows, no keyframe animations, no icon libraries
- Use whitespace and font-size hierarchy to create structure rather than decoration

---

## LAN Hosting Requirements

- `server.js` must bind to `0.0.0.0`, not `localhost`, so other devices on the LAN can reach it.
- Log the LAN-reachable URL to console on startup (or at least remind the developer to run `ip a` / `ipconfig` to find their LAN IP and share `http://<ip>:<port>` with participants).
- No HTTPS needed — closed LAN, plain HTTP is fine.
- Default port `6767`, configurable via `PORT` env var.

---

## package.json — required dependencies

```
express
bcryptjs
dotenv
cookie-parser
cookie-signature  (or use Express's built-in signed cookies via cookie-parser + a secret)
```

No React, no webpack/vite, no nodemon required (though fine as a devDependency for convenience).

---

## Edge Cases to Handle

- Username with only whitespace → reject.
- Two tabs logging in as the same username simultaneously → second one gets a clear rejection message, not a silent overwrite.
- Participant refreshes `game.html` mid-session → session should resume correctly (server still has it in memory; re-fetch `/api/session-status` and `/api/next-image` on page load rather than assuming a fresh state).
- Server restarts mid-competition → active in-memory sessions are lost (acceptable, mention this as a known limitation in a code comment), but `responses.jsonl` is untouched and all *past* answers remain safe.
- Image pool exhausted before time runs out → allow repeats rather than erroring (still useful data — mention this as intentional in a comment).
- Manifest has zero images in one category (e.g. someone forgot to run `build-manifest.js`) → server should fail fast at startup with a clear error message, not silently serve broken data.

---

## Deliverable

A working local Node/Express app, runnable via:
```
npm install
node scripts/build-manifest.js   # one-time, after images/datasets/bot and images/datasets/not are populated
node server.js
```
that a developer can then open at `http://localhost:6767` locally, or `http://<lan-ip>:6767` from any device on the same LAN/Ethernet network.

---

- If you can think of something that would make this better (Like a feature or smth) - You can add that too.
- Make sure to include the participants private_ip in the logs and everything.
- This website is going to be hosted in my machine (ThinkPad E16 - Ryzen 5 7353U , 16GB RAM 512GB SSD) , So, if there's anything that I should be worried about like whether my pc can handle the requests or not, just tell me.
- Make sure that everything here is okay. and feel free to add modifications on your own if you think that it's a better choice
- Feel free to ask any doubts and make sure every instructions are clear. 