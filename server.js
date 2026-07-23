'use strict';

/**
 * server.js — Bot or Not LAN game server
 *
 * KNOWN LIMITATIONS:
 * - Active participant sessions are held in memory. If the server restarts mid-competition,
 *   all in-progress sessions are lost. Past answers in responses.jsonl remain safe.
 *
 * IMAGE POOL EXHAUSTION:
 * - When a participant has seen every image in the pool, repeats are allowed intentionally.
 *   This is useful data — a participant may still answer differently on repeat.
 *
 * TEXT CHALLENGE MIXING:
 * - Along with images, text snippets from human-ai-text.csv are served at random intervals.
 * - The probability of getting a text vs image is weighted (TEXT_CHALLENGE_PROBABILITY).
 * - Text IDs are tracked per session to avoid immediate repeats, just like images.
 */

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
// bcryptjs removed — plaintext password comparison used for LAN simplicity
const os           = require('os');

// ── Config & Paths ─────────────────────────────────────────────────────────

const PORT           = parseInt(process.env.PORT || '6768', 10);
const ROOT           = __dirname;
const DATA_DIR       = path.join(ROOT, 'data');
const MANIFEST_PATH    = path.join(DATA_DIR, 'manifest.json');
const RESPONSES_PATH   = path.join(DATA_DIR, 'responses.jsonl');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');
const CONFIG_PATH      = path.join(ROOT, 'config.json');
const PUBLIC_DIR       = path.join(ROOT, 'public');
const TEXT_CSV_PATH    = path.join(ROOT, 'datasets', 'human-ai-text.csv');

// Points awarded per correct answer
const POINTS_PER_CORRECT = 10;

// Probability (0–1) that a challenge is a text snippet instead of an image.
// With ~54k images and ~1000 texts, 0.15 gives text a fair but not dominant presence.
const TEXT_CHALLENGE_PROBABILITY = 0.15;

// ── Startup Checks ─────────────────────────────────────────────────────────

if (!process.env.ADMIN_PASSWORD) {
  console.error('[ERROR] ADMIN_PASSWORD is not set in .env');
  console.error('  Add:  ADMIN_PASSWORD=yourpassword  to your .env file');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('[ERROR] SESSION_SECRET is not set in .env');
  process.exit(1);
}

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('[ERROR] data/manifest.json not found. Run: node scripts/build-manifest.js');
  process.exit(1);
}

// Load manifest once at startup (it never changes at runtime)
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const manifestMap = new Map(manifest.map(e => [e.id, e])); // O(1) lookups

// Validate manifest has both categories
const botCount = manifest.filter(e => e.label === 'bot').length;
const notCount = manifest.filter(e => e.label === 'not').length;
if (botCount === 0 || notCount === 0) {
  console.error(`[ERROR] Manifest has ${botCount} bot images and ${notCount} real images.`);
  console.error('  At least one of each category is required. Re-run build-manifest.js.');
  process.exit(1);
}
console.log(`[INFO] Manifest loaded: ${botCount} bot, ${notCount} real images.`);

// ── Text Dataset Loading ────────────────────────────────────────────────────

/**
 * Parse the human-ai-text CSV into an in-memory array.
 * Each entry: { id, text, label: 'bot'|'not' }
 * author_type 'AI' → label 'bot', 'Human' → label 'not'
 */
function parseTextCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.warn('[WARN] Text dataset not found at:', csvPath, '— text challenges disabled.');
    return [];
  }
  const raw   = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  // Parse header to find column indices robustly
  const header  = lines[0].split(',').map(h => h.trim().replace(/\r/g, ''));
  const idxId   = header.indexOf('text_id');
  const idxText = header.indexOf('content_text');
  const idxType = header.indexOf('author_type');

  if (idxId === -1 || idxText === -1 || idxType === -1) {
    console.warn('[WARN] Text CSV is missing expected columns (text_id, content_text, author_type). Text challenges disabled.');
    return [];
  }

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV split — fields have no embedded commas/quotes in this dataset
    const cols       = lines[i].split(',');
    const textId     = (cols[idxId]   || '').trim().replace(/\r/g, '');
    const contentRaw = (cols[idxText] || '').trim().replace(/\r/g, '');
    const authorType = (cols[idxType] || '').trim().replace(/\r/g, '');

    if (!textId || !contentRaw) continue;

    const label = authorType === 'AI' ? 'bot' : 'not';
    entries.push({ id: textId, text: contentRaw, label });
  }
  return entries;
}

const textDataset    = parseTextCsv(TEXT_CSV_PATH);
const textDatasetMap = new Map(textDataset.map(e => [e.id, e]));
const textBotCount   = textDataset.filter(e => e.label === 'bot').length;
const textNotCount   = textDataset.filter(e => e.label === 'not').length;
console.log(`[INFO] Text dataset loaded: ${textDataset.length} entries (${textBotCount} AI, ${textNotCount} human).`);

// Ensure data dir and data files exist
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RESPONSES_PATH)) {
  fs.writeFileSync(RESPONSES_PATH, '', 'utf8');
}
if (!fs.existsSync(LEADERBOARD_PATH)) {
  fs.writeFileSync(LEADERBOARD_PATH, '{}', 'utf8');
}

// ── Leaderboard Helpers ────────────────────────────────────────────────────

/**
 * Read leaderboard from disk. Returns a plain object keyed by username.
 */
function readLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Update one player's entry in leaderboard.json and write to disk.
 * Node.js is single-threaded so this synchronous read-modify-write is safe.
 */
function updateLeaderboard(username, privateIp, correct) {
  const lb = readLeaderboard();
  if (!lb[username]) {
    lb[username] = {
      username,
      privateIp,
      totalAnswered: 0,
      correctCount:  0,
      points:        0,
      lastUpdated:   null,
    };
  }
  const entry = lb[username];
  entry.privateIp    = privateIp; // update in case IP changed
  entry.totalAnswered++;
  if (correct) {
    entry.correctCount++;
    entry.points += POINTS_PER_CORRECT;
  }
  entry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(lb, null, 2), 'utf8');
}

/**
 * Return leaderboard as a sorted array (by points desc, then totalAnswered desc).
 */
function getSortedLeaderboard() {
  const lb = readLeaderboard();
  return Object.values(lb).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return b.totalAnswered - a.totalAnswered;
  });
}

// ── In-memory Sessions ─────────────────────────────────────────────────────

/**
 * Map<username, { username, privateIp, startTime, endTime, servedImageIds: Set, servedTextIds: Set }>
 */
const activeSessions = new Map();

// ── Express Setup ──────────────────────────────────────────────────────────

const app = express();

app.use(express.json());
app.use(cookieParser(process.env.SESSION_SECRET));

// Serve static public files (HTML, CSS, JS)
// Cache static assets aggressively in the browser (1 hour) — they never change mid-game.
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

// ── Utility Functions ──────────────────────────────────────────────────────

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getClientIp(req) {
  // X-Forwarded-For not needed for LAN, but handle it just in case
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Middleware: requires a valid active participant session cookie.
 * Attaches session to req.session on success.
 */
function requireSession(req, res, next) {
  const username = req.cookies['bon_user'];
  if (!username) return res.status(401).json({ error: 'Not logged in' });

  const session = activeSessions.get(username);
  if (!session) return res.status(401).json({ error: 'Session not found or expired' });

  req.session = session;
  next();
}

/**
 * Middleware: requires a valid admin session cookie.
 */
function requireAdmin(req, res, next) {
  const token = req.signedCookies['bon_admin'];
  if (token !== 'authenticated') {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

/**
 * Pick a random image from the manifest.
 * Tries to avoid repeats by excluding servedIds.
 * If all images have been served, falls back to any random (intentional repeats allowed).
 */
function pickImage(servedIds) {
  const unserved = manifest.filter(e => !servedIds.has(e.id));
  const pool     = unserved.length > 0 ? unserved : manifest;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Pick a random text entry from the text dataset.
 * Tries to avoid repeats; falls back to full pool if exhausted.
 */
function pickText(servedTextIds) {
  if (textDataset.length === 0) return null;
  const unserved = textDataset.filter(e => !servedTextIds.has(e.id));
  const pool     = unserved.length > 0 ? unserved : textDataset;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Decide whether to serve a text or image challenge.
 * Picks text with TEXT_CHALLENGE_PROBABILITY, but falls back to image if no texts available.
 */
function pickChallengeType() {
  if (textDataset.length === 0) return 'image';
  return Math.random() < TEXT_CHALLENGE_PROBABILITY ? 'text' : 'image';
}

/**
 * Get MIME type from file extension.
 */
function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.avif': 'image/avif',
  };
  return mimes[ext] || 'application/octet-stream';
}

// ── Participant API ─────────────────────────────────────────────────────────

/**
 * POST /api/login
 * Body: { username: string }
 */
app.post('/api/login', (req, res) => {
  let { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username is required' });
  }
  username = username.trim();
  if (username.length === 0) {
    return res.status(400).json({ error: 'Username cannot be blank' });
  }
  if (username.length > 32) {
    return res.status(400).json({ error: 'Username too long (max 32 chars)' });
  }
  if (!/^[a-zA-Z0-9 _\-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, spaces, - and _' });
  }

  if (activeSessions.has(username)) {
    return res.status(409).json({ error: `Username "${username}" is already in use this session. Pick another.` });
  }

  const config    = readConfig(); // read fresh so new sessions get current duration
  const now       = Date.now();
  const endTime   = now + config.sessionDurationMinutes * 60_000;
  const privateIp = getClientIp(req);

  activeSessions.set(username, {
    username,
    privateIp,
    startTime: now,
    endTime,
    servedImageIds: new Set(),
    servedTextIds:  new Set(),
  });

  // Simple cookie — just the username. Auth is checked server-side against activeSessions.
  // HttpOnly prevents JS snooping; SameSite=Lax is fine for LAN.
  res.cookie('bon_user', username, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: config.sessionDurationMinutes * 60_000 + 60_000, // a little extra
  });

  res.json({
    username,
    privateIp,
    endTime: new Date(endTime).toISOString(),
    sessionDurationMinutes: config.sessionDurationMinutes,
  });
});

/**
 * GET /api/next-image
 * Legacy endpoint — kept for backward compatibility. Delegates to next-challenge.
 * NEVER reveals the label.
 */
app.get('/api/next-image', requireSession, (req, res) => {
  const session = req.session;
  const now     = Date.now();

  if (now > session.endTime) {
    return res.json({ sessionEnded: true });
  }

  const entry = pickImage(session.servedImageIds);
  session.servedImageIds.add(entry.id);

  res.json({
    challengeType: 'image',
    imageId:       entry.id,
    imageUrl:      `/api/image/${entry.id}`,
  });
});

/**
 * GET /api/next-challenge
 * Returns the next challenge — either an image or a text snippet — chosen at random.
 * The type is indicated by challengeType: 'image' | 'text'.
 * NEVER reveals the label.
 */
app.get('/api/next-challenge', requireSession, (req, res) => {
  const session = req.session;
  const now     = Date.now();

  if (now > session.endTime) {
    return res.json({ sessionEnded: true });
  }

  const type = pickChallengeType();

  if (type === 'text') {
    const entry = pickText(session.servedTextIds);
    if (!entry) {
      // Fallback to image if text dataset is somehow empty
      const img = pickImage(session.servedImageIds);
      session.servedImageIds.add(img.id);
      return res.json({ challengeType: 'image', imageId: img.id, imageUrl: `/api/image/${img.id}` });
    }
    session.servedTextIds.add(entry.id);
    return res.json({
      challengeType: 'text',
      textId:        entry.id,
      // text content is fetched separately so it isn't cached with the label
      textUrl:       `/api/text/${entry.id}`,
    });
  }

  // Image challenge
  const entry = pickImage(session.servedImageIds);
  session.servedImageIds.add(entry.id);
  res.json({
    challengeType: 'image',
    imageId:       entry.id,
    imageUrl:      `/api/image/${entry.id}`,
  });
});

/**
 * GET /api/text/:id
 * Returns the text content for a text challenge. NEVER reveals the label.
 */
app.get('/api/text/:id', requireSession, (req, res) => {
  const entry = textDatasetMap.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Text not found' });

  // Return only the text — label stays server-side
  res.json({ textId: entry.id, text: entry.text });
});

/**
 * GET /api/image/:id
 * Streams the image file. The client NEVER sees the original path, folder, or label.
 *
 * Bandwidth optimizations:
 * - ETag + Last-Modified: browser caches by image ID, avoids re-download on repeat.
 * - Cache-Control: immutable for 1 hour — ID is opaque, content never changes.
 */
app.get('/api/image/:id', (req, res) => {
  const entry = manifestMap.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Image not found' });

  const filePath = path.join(ROOT, entry._path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Image file missing on disk' });
  }

  const stat     = fs.statSync(filePath);
  const mime     = getMime(entry.filename);
  const etag     = `"${entry.id}"`;
  const lastMod  = stat.mtime.toUTCString();

  // Conditional GET — if browser already has it, send 304 Not Modified (saves bandwidth!)
  if (req.headers['if-none-match'] === etag ||
      req.headers['if-modified-since'] === lastMod) {
    return res.status(304).end();
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastMod);
  res.setHeader('Cache-Control', 'public, max-age=3600, immutable');

  fs.createReadStream(filePath).pipe(res);
});

/**
 * POST /api/answer
 * Accepts answers for both image and text challenges.
 * Body: { imageId?, textId?, choice: "bot"|"not", responseTimeMs }
 * Exactly one of imageId or textId must be provided.
 */
app.post('/api/answer', requireSession, (req, res) => {
  const session = req.session;
  const now     = Date.now();

  if (now > session.endTime) {
    return res.status(403).json({ error: 'Session has ended — answer not accepted' });
  }

  const { imageId, textId, choice, responseTimeMs } = req.body;

  if (!choice) {
    return res.status(400).json({ error: 'choice is required' });
  }
  if (choice !== 'bot' && choice !== 'not') {
    return res.status(400).json({ error: 'choice must be "bot" or "not"' });
  }
  if (!imageId && !textId) {
    return res.status(400).json({ error: 'imageId or textId is required' });
  }

  let trueLabel, challengeType, challengeId;

  if (textId) {
    // Text challenge
    const entry = textDatasetMap.get(textId);
    if (!entry) return res.status(404).json({ error: 'Unknown textId' });
    trueLabel     = entry.label;
    challengeType = 'text';
    challengeId   = textId;
  } else {
    // Image challenge
    const entry = manifestMap.get(imageId);
    if (!entry) return res.status(404).json({ error: 'Unknown imageId' });
    trueLabel     = entry.label;
    challengeType = 'image';
    challengeId   = imageId;
  }

  const correct = choice === trueLabel;

  const record = {
    username:       session.username,
    privateIp:      session.privateIp,
    challengeType,
    challengeId,
    // Keep imageId field for backward compatibility with existing exports
    imageId:        challengeType === 'image' ? challengeId : null,
    textId:         challengeType === 'text'  ? challengeId : null,
    trueLabel,
    choice,
    correct,
    timestamp:      new Date().toISOString(),
    responseTimeMs: typeof responseTimeMs === 'number' ? responseTimeMs : null,
  };

  // Append-only — no read-modify-write, safe for concurrent participants
  fs.appendFile(RESPONSES_PATH, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('[ERROR] Failed to write response:', err);
  });

  // Update the live leaderboard.json
  try {
    updateLeaderboard(session.username, session.privateIp, correct);
  } catch (err) {
    console.error('[ERROR] Failed to update leaderboard:', err);
  }

  // Reveal the true label ONLY after they've committed their answer
  res.json({ correct, trueLabel, challengeType });
});

/**
 * GET /api/session-status
 * Returns remaining time for the current participant session.
 */
app.get('/api/session-status', requireSession, (req, res) => {
  const session     = req.session;
  const remainingMs = Math.max(0, session.endTime - Date.now());
  res.json({
    active:      remainingMs > 0,
    remainingMs,
    endTime:     new Date(session.endTime).toISOString(),
    username:    session.username,
    privateIp:   session.privateIp,
  });
});

/**
 * GET /api/leaderboard
 * Public — no auth required.
 * Reads from leaderboard.json (maintained live as answers come in).
 */
app.get('/api/leaderboard', (req, res) => {
  res.json(getSortedLeaderboard());
});

/**
 * POST /api/quit
 * Participant chooses to end their session early.
 */
app.post('/api/quit', requireSession, (req, res) => {
  const session = req.session;
  // Mark session as ended by setting endTime to now
  session.endTime = Date.now();
  res.clearCookie('bon_user');
  res.json({ ok: true, username: session.username });
});

// ── Admin API ───────────────────────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Body: { password }
 */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Signed cookie — tamper-evident
  res.cookie('bon_admin', 'authenticated', {
    signed:   true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours
  });

  res.json({ ok: true });
});

/**
 * GET /api/admin/logs
 * Returns all responses + summary stats.
 */
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const raw   = fs.readFileSync(RESPONSES_PATH, 'utf8').trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];

  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const participants = new Set(entries.map(e => e.username)).size;
  const totalAnswers = entries.length;
  const correct      = entries.filter(e => e.correct).length;
  const overallAccuracy = totalAnswers > 0 ? Math.round((correct / totalAnswers) * 100) : 0;

  res.json({
    summary: { participants, totalAnswers, correct, overallAccuracy },
    entries,
  });
});

/**
 * GET /api/admin/config
 */
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json(readConfig());
});

/**
 * POST /api/admin/config
 * Body: { sessionDurationMinutes: number }
 */
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { sessionDurationMinutes } = req.body;
  if (typeof sessionDurationMinutes !== 'number' || sessionDurationMinutes <= 0 || !isFinite(sessionDurationMinutes)) {
    return res.status(400).json({ error: 'sessionDurationMinutes must be a positive number' });
  }
  const config = { sessionDurationMinutes };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  res.json({ ok: true, config });
});

/**
 * GET /api/admin/active-sessions
 */
app.get('/api/admin/active-sessions', requireAdmin, (req, res) => {
  const now  = Date.now();
  const list = Array.from(activeSessions.values()).map(s => ({
    username:     s.username,
    privateIp:    s.privateIp,
    startTime:    new Date(s.startTime).toISOString(),
    endTime:      new Date(s.endTime).toISOString(),
    remainingMs:  Math.max(0, s.endTime - now),
    imagesServed: s.servedImageIds.size,
    textsServed:  s.servedTextIds.size,
  }));
  res.json(list);
});

/**
 * GET /api/admin/export
 * Downloads responses.jsonl as a CSV.
 */
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const raw   = fs.readFileSync(RESPONSES_PATH, 'utf8').trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const header = 'username,privateIp,imageId,textId,trueLabel,choice,correct,timestamp,responseTimeMs\n';
  const rows   = entries.map(e =>
    [e.username, e.privateIp, e.imageId, e.textId, e.trueLabel, e.choice, e.correct, e.timestamp, e.responseTimeMs ?? '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');

  const csv = header + rows;
  const ts  = new Date().toISOString().replace(/[:.]/g, '-');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bot-or-not-export-${ts}.csv"`);
  res.send(csv);
});

// ── LAN Info ────────────────────────────────────────────────────────────────

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│         Bot or Not — Server Running          │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Local:   http://localhost:${PORT}              │`);
  console.log(`│  LAN:     http://${lanIp}:${PORT}           │`);
  console.log(`│  Admin:   http://${lanIp}:${PORT}/admin-login.html │`);
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Images: ${manifest.length} total (${botCount} bot, ${notCount} real)      │`);
  console.log(`│  Texts:  ${textDataset.length} total (${textBotCount} AI, ${textNotCount} human)            │`);
  console.log(`│  Text challenge rate: ${Math.round(TEXT_CHALLENGE_PROBABILITY * 100)}%                    │`);
  console.log('└─────────────────────────────────────────────┘\n');
  console.log('Share the LAN URL with participants. Press Ctrl+C to stop.\n');
});
