#!/usr/bin/env node
// Reference importer: a scheduler CSV (Buffer / Hootsuite / Later / Publer / SocialBee) -> PostStack.
// For each row it creates editorial content, a post, then schedules/publishes it. Rows that fail
// validation are skipped and reported; a stable sourceRef per row makes re-runs idempotent.
//
// Plain Node 18+ (built-in fetch), no dependencies. This is an example you own and adapt — not a
// product feature with a support contract. See docs/migration/from-buffer.md.
//
//   export POSTSTACK_URL="https://your-instance"
//   export POSTSTACK_KEY="sk_live_your_key"
//   export POSTSTACK_CHANNEL_ID="<channelId>"   # default channel to publish to
//   node import-scheduled-posts.mjs path/to/export.csv

import { readFile } from "node:fs/promises";

const BASE = process.env.POSTSTACK_URL;
const KEY = process.env.POSTSTACK_KEY;
const CHANNEL_ID = process.env.POSTSTACK_CHANNEL_ID;
const FILE = process.argv[2];

if (!BASE || !KEY || !CHANNEL_ID || !FILE) {
  console.error("Set POSTSTACK_URL, POSTSTACK_KEY, POSTSTACK_CHANNEL_ID and pass a CSV path.");
  process.exit(1);
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas/newlines, and "" escapes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* ignore, handle on \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Map varied header names to our canonical keys (case-insensitive).
const ALIASES = {
  caption: ["caption", "message", "text", "content", "post"],
  date: ["date"],
  time: ["time"],
  datetime: ["datetime", "scheduled", "scheduled_at", "scheduled at", "due", "dueat"],
  media: ["media url", "media", "image url", "image", "photo", "link to media"],
  platform: ["platform", "channel", "profile", "network"],
  firstComment: ["first comment", "firstcomment"],
  hashtags: ["hashtags", "tags"],
};

function indexHeaders(header) {
  const lower = header.map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const found = lower.findIndex((h) => names.includes(h));
    if (found !== -1) idx[key] = found;
  }
  return idx;
}

function toIsoUtc(dateStr, timeStr, dateTimeStr) {
  const raw = (dateTimeStr || `${dateStr || ""} ${timeStr || ""}`).trim();
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json.data;
}

const rows = parseCsv(await readFile(FILE, "utf8"));
if (rows.length < 2) { console.error("CSV has no data rows."); process.exit(1); }
const idx = indexHeaders(rows[0]);
if (idx.caption === undefined) { console.error("Could not find a caption/message column."); process.exit(1); }

let ok = 0;
const errors = [];

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const get = (key) => (idx[key] !== undefined ? (row[idx[key]] ?? "").trim() : "");
  const caption = get("caption");
  if (!caption) { errors.push(`row ${r + 1}: empty caption, skipped`); continue; }

  const media = get("media");
  const mediaUrls = media ? media.split(/[,|]/).map((s) => s.trim()).filter(Boolean) : undefined;
  const scheduledDate = toIsoUtc(get("date"), get("time"), get("datetime"));
  const platform = (get("platform") || "instagram").toLowerCase();
  const sourceRef = `import:${FILE.split("/").pop()}:row-${r + 1}`;

  try {
    const content = await api("/api/v1/content", {
      title: caption.slice(0, 200),
      baseDescription: caption,
      baseHashtags: get("hashtags") || undefined,
      mediaUrls,
      sourceRef,
    });
    const post = await api("/api/v1/posts", {
      contentId: content.id,
      platform,
      description: caption,
      hashtags: get("hashtags") || undefined,
      firstComment: get("firstComment") || undefined,
      mediaUrls,
      scheduledDate,
      sourceRef,
    });
    await api(`/api/v1/posts/${post.id}/publish`, {
      channelId: CHANNEL_ID,
      when: scheduledDate || "now",
    });
    ok++;
    console.log(`row ${r + 1}: imported "${caption.slice(0, 40)}"`);
  } catch (err) {
    errors.push(`row ${r + 1}: ${err.message}`);
  }
}

console.log(`\nDone. ${ok} imported, ${errors.length} skipped.`);
if (errors.length) console.log(errors.map((e) => `  - ${e}`).join("\n"));
