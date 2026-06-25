#!/usr/bin/env node
// Reference importer: a ManyChat / Chatfuel audience CSV -> PostStack contacts.
// Maps each row to a contact (handle as placeholder sender id), batches them through
// POST /api/v1/contacts (idempotent: re-runs update, never duplicate), and reports per-row failures.
//
// Plain Node 18+ (built-in fetch), no dependencies. Adapt the header aliases below to your export.
// The contacts CRM is a Pro feature — the endpoint requires a Pro license. See docs/migration/from-manychat.md.
//
//   export POSTSTACK_URL="https://your-instance"
//   export POSTSTACK_KEY="sk_live_your_key"
//   export POSTSTACK_CHANNEL_ID="<the IG/FB channel id these contacts belong to>"
//   node import-contacts.mjs path/to/audience.csv

import { readFile } from "node:fs/promises";

const BASE = process.env.POSTSTACK_URL;
const KEY = process.env.POSTSTACK_KEY;
const CHANNEL_ID = process.env.POSTSTACK_CHANNEL_ID;
const FILE = process.argv[2];

if (!BASE || !KEY || !CHANNEL_ID || !FILE) {
  console.error("Set POSTSTACK_URL, POSTSTACK_KEY, POSTSTACK_CHANNEL_ID and pass a CSV path.");
  process.exit(1);
}

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
    else if (c === "\r") { /* handled on \n */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// Known columns map to fields; everything else is carried into metadata.
const ALIASES = {
  display_name: ["name", "full name", "first name", "display name"],
  email: ["email", "e-mail"],
  username: ["instagram username", "username", "handle", "ig username", "instagram"],
  subscribed: ["subscribed", "opt-in", "opt in", "status"],
  tags: ["tags", "labels"],
};

function buildHeaderMap(header) {
  const lower = header.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = lower.findIndex((h) => names.includes(h));
    if (i !== -1) map[key] = i;
  }
  return { map, lower };
}

const TRUTHY = new Set(["true", "1", "yes", "y", "subscribed", "active"]);

const rows = parseCsv(await readFile(FILE, "utf8"));
if (rows.length < 2) { console.error("CSV has no data rows."); process.exit(1); }
const { map, lower } = buildHeaderMap(rows[0]);
if (map.username === undefined) { console.error("Could not find a username/handle column."); process.exit(1); }

const known = new Set(Object.values(map));
const contacts = [];
const skipped = [];

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const get = (key) => (map[key] !== undefined ? (row[map[key]] ?? "").trim() : "");
  const username = get("username");
  if (!username) { skipped.push(`row ${r + 1}: no username`); continue; }

  // Every column that isn't a known field becomes a metadata entry.
  const metadata = {};
  for (let c = 0; c < row.length; c++) {
    if (known.has(c)) continue;
    const key = (lower[c] || `col_${c}`).replace(/\s+/g, "_");
    const val = (row[c] ?? "").trim();
    if (val) metadata[key] = val;
  }

  contacts.push({
    channel_id: CHANNEL_ID,
    platform_username: username,
    display_name: get("display_name") || undefined,
    email: get("email") || undefined,
    is_subscribed: map.subscribed !== undefined ? TRUTHY.has(get("subscribed").toLowerCase()) : undefined,
    tags: get("tags") ? get("tags").split(/[,|]/).map((t) => t.trim()).filter(Boolean) : undefined,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  });
}

// POST in batches of 500 (endpoint accepts up to 1000 per request).
let created = 0, updated = 0, failed = 0;
for (let i = 0; i < contacts.length; i += 500) {
  const batch = contacts.slice(i, i + 500);
  const res = await fetch(`${BASE}/api/v1/contacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`batch ${i / 500 + 1} failed: ${res.status} ${JSON.stringify(json.error ?? json)}`);
    failed += batch.length;
    continue;
  }
  created += json.data.created;
  updated += json.data.updated;
  failed += json.data.failed;
  for (const x of json.data.results.filter((r) => r.status === "error")) {
    skipped.push(`batch row ${i + x.index + 1}: ${x.error}`);
  }
}

console.log(`\nDone. ${created} created, ${updated} updated, ${failed} failed, ${skipped.length} skipped.`);
if (skipped.length) console.log(skipped.map((e) => `  - ${e}`).join("\n"));
