#!/usr/bin/env node
/**
 * build-manifest.js
 * -----------------
 * One-time script to anonymize image access and generate data/manifest.json.
 *
 * IMPORTANT: This script does NOT copy or rename any files.
 * Instead, it assigns each image a random opaque ID and records the actual
 * file path internally. The server uses the ID → path mapping to serve images
 * without ever revealing the real path, folder name ("bot"/"not"), or label to clients.
 *
 * This approach:
 *   - Uses zero extra disk space (no copies)
 *   - Handles any number of images instantly
 *   - Keeps the original dataset intact
 *
 * Usage:
 *   node scripts/build-manifest.js
 *   node scripts/build-manifest.js --force   # regenerate (changes all IDs, breaks active sessions)
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT          = path.resolve(__dirname, '..');
const BOT_DIR       = path.join(ROOT, 'datasets', 'bot');
const NOT_DIR       = path.join(ROOT, 'datasets', 'not');
const DATA_DIR      = path.join(ROOT, 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');

// Supported image extensions (lowercase)
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif']);

const force = process.argv.includes('--force');

// ── Helpers ────────────────────────────────────────────────────────────────

function randomId() {
  return crypto.randomBytes(8).toString('hex'); // 16-char hex string
}

/**
 * Recursively walk a directory and collect all image file paths.
 */
function walkImages(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    console.warn(`[WARN] Directory does not exist, skipping: ${dir}`);
    return results;
  }

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden/dot directories (e.g. .FAKE) — rename a folder to .name to exclude it
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

(function main() {
  // Guard against accidental re-run
  if (fs.existsSync(MANIFEST_PATH) && !force) {
    console.error(
      `[ERROR] ${MANIFEST_PATH} already exists.\n` +
      `  Run with --force to regenerate (WARNING: changes all IDs — breaks active sessions).\n` +
      `  Or delete data/manifest.json manually.`
    );
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[INFO] Scanning image directories...');
  const botFiles = walkImages(BOT_DIR);
  const notFiles = walkImages(NOT_DIR);

  console.log(`[INFO] Found ${botFiles.length} bot images, ${notFiles.length} real images.`);

  if (botFiles.length === 0) {
    console.error('[ERROR] No bot images found. Check images/datasets/bot/ is populated.');
    process.exit(1);
  }
  if (notFiles.length === 0) {
    console.error('[ERROR] No real images found. Check images/datasets/not/ is populated.');
    process.exit(1);
  }

  // Build manifest — each entry maps a random ID to the real file path (server-side only)
  const usedIds  = new Set();
  const manifest = [];

  function addEntries(files, label) {
    for (const filePath of files) {
      let id;
      // Extremely unlikely to collide, but guard it
      do { id = randomId(); } while (usedIds.has(id));
      usedIds.add(id);

      const ext      = path.extname(filePath).toLowerCase();
      const filename = id + ext; // the "virtual" filename the server uses for content-type

      manifest.push({
        id,
        label,     // "bot" or "not" — NEVER sent to clients pre-answer
        filename,  // used only to determine MIME type
        // _path is the actual file on disk — stored in manifest, never exposed to clients
        _path: path.relative(ROOT, filePath),
      });
    }
  }

  console.log('[INFO] Assigning IDs to bot images...');
  addEntries(botFiles, 'bot');

  console.log('[INFO] Assigning IDs to real images...');
  addEntries(notFiles, 'not');

  console.log('[INFO] Writing manifest.json...');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest), 'utf8');
  // Note: no pretty-printing — at 141k entries this keeps file size manageable

  const botCount = manifest.filter(e => e.label === 'bot').length;
  const notCount = manifest.filter(e => e.label === 'not').length;
  console.log(`[DONE] Manifest written: ${manifest.length} total entries.`);
  console.log(`       ${botCount} bot, ${notCount} real.`);
  console.log(`       File size: ${(fs.statSync(MANIFEST_PATH).size / 1024 / 1024).toFixed(1)} MB`);
  console.log('\nNo files were copied or renamed. Your dataset is untouched.');
  console.log('You can now run: node server.js');
})();
