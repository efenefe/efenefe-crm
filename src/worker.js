// efenefe CRM: API for the call tracker. Static screens are served from ./public.

const STATUSES = ["to_call", "called", "interested", "follow_up", "proposal", "won", "lost"];
const OUTCOMES = ["no_answer", "voicemail", "call_back", "interested", "not_interested", "wrong_number"];
const FLAGS = ["unknown", "none", "social", "weak", "good"];

const LEAD_FIELDS = [
  "business", "category", "phone", "email", "contact", "website", "address", "city",
  "site_flag", "site_issues", "status", "next_follow_up", "notes", "source", "place_id", "later",
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    business TEXT NOT NULL,
    category TEXT, phone TEXT, email TEXT, contact TEXT, website TEXT,
    address TEXT, city TEXT,
    site_flag TEXT NOT NULL DEFAULT 'unknown',
    site_issues TEXT,
    status TEXT NOT NULL DEFAULT 'to_call',
    next_follow_up TEXT,
    notes TEXT,
    source TEXT,
    place_id TEXT UNIQUE,
    last_called_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    called_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS calls_lead ON calls(lead_id, called_at)`,
];

// Columns added after the first release. Each runs once; "duplicate column" means it is already there.
const MIGRATIONS = ["ALTER TABLE leads ADD COLUMN later INTEGER NOT NULL DEFAULT 0"];
let migrateDb = null;
async function migrate() {
  for (const sql of MIGRATIONS) {
    try {
      await migrateDb.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    }
  }
}

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    migrateDb = db;
    schemaReady = db.batch(SCHEMA.map((s) => db.prepare(s))).then(migrate).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const user = await authenticate(request, env);
      if (!user) return json({ error: "Sign in required." }, 401);
      if (user.error) return json({ error: user.error }, 503);

      await ensureSchema(env.DB);
      return await route(request, env, url, user);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function route(request, env, url, user) {
  const db = env.DB;
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (parts[0] === "me" && method === "GET") return json({ email: user.email });

  // Call times for the last 15 days. The screen buckets them by local day.
  if (parts[0] === "stats" && method === "GET") {
    const since = new Date(Date.now() - 15 * 864e5).toISOString();
    const { results } = await db.prepare("SELECT c.called_at, c.outcome, l.business FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.called_at >= ? ORDER BY c.called_at").bind(since).all();
    return json({ calls: results });
  }

  if (parts[0] === "leads") {
    const id = parts[1];
    if (!id && method === "GET") {
      const { results } = await db.prepare("SELECT * FROM leads ORDER BY updated_at DESC").all();
      return json({ leads: results.map(decodeLead) });
    }
    if (!id && method === "POST") return json({ lead: await createLead(db, await body(request)) }, 201);

    if (id && parts[2] === "calls") {
      if (method === "GET") {
        const { results } = await db
          .prepare("SELECT * FROM calls WHERE lead_id = ? ORDER BY called_at DESC")
          .bind(id)
          .all();
        return json({ calls: results });
      }
      if (method === "POST") return json(await logCall(db, id, await body(request)), 201);
    }

    if (id && !parts[2]) {
      if (method === "GET") return json({ lead: await getLead(db, id) });
      if (method === "PATCH") return json({ lead: await updateLead(db, id, await body(request)) });
      if (method === "DELETE") {
        await db.batch([
          db.prepare("DELETE FROM calls WHERE lead_id = ?").bind(id),
          db.prepare("DELETE FROM leads WHERE id = ?").bind(id),
        ]);
        return json({ ok: true });
      }
    }
  }

  if (parts[0] === "search" && method === "POST") return json(await searchPlaces(env, db, await body(request)));
  if (parts[0] === "check-site" && method === "POST") {
    const { url: site } = await body(request);
    return json(await checkSite(String(site || "")));
  }

  if (parts[0] === "calls" && parts[1] && method === "DELETE") {
    await db.prepare("DELETE FROM calls WHERE id = ?").bind(parts[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, "Not found.");
}

// ---------- leads ----------

function cleanLead(input, { partial }) {
  const out = {};
  for (const f of LEAD_FIELDS) {
    if (!(f in input)) continue;
    let v = input[f];
    if (f === "later") {
      v = v === true || v === 1 || v === "1" || v === "true" ? 1 : 0;
    } else if (f === "site_issues") {
      v = Array.isArray(v) ? JSON.stringify(v.map(String).slice(0, 20)) : null;
    } else if (v === null || v === undefined) {
      v = null;
    } else {
      v = String(v).trim().slice(0, f === "notes" ? 5000 : 500);
      if (v === "") v = null;
    }
    out[f] = v;
  }
  if (!partial || "business" in out) {
    if (!out.business) throw new HttpError(400, "Business name is required.");
  }
  if ("status" in out && !STATUSES.includes(out.status ?? "")) throw new HttpError(400, "Unknown status.");
  if ("site_flag" in out && !FLAGS.includes(out.site_flag ?? "")) throw new HttpError(400, "Unknown website flag.");
  if (out.next_follow_up && !/^\d{4}-\d{2}-\d{2}$/.test(out.next_follow_up)) {
    throw new HttpError(400, "Follow-up date must look like 2026-11-30.");
  }
  return out;
}

async function createLead(db, input) {
  const lead = cleanLead(input, { partial: false });
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    status: "to_call",
    site_flag: lead.website ? "unknown" : "none",
    source: "manual",
    ...lead,
    created_at: now,
    updated_at: now,
  };
  const cols = Object.keys(row);
  try {
    await db
      .prepare(`INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "That business is already in your tracker.");
    throw e;
  }
  return getLead(db, row.id);
}

async function getLead(db, id) {
  const row = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Lead not found. It may have been deleted.");
  return decodeLead(row);
}

async function updateLead(db, id, input) {
  const lead = cleanLead(input, { partial: true });
  const cols = Object.keys(lead);
  if (!cols.length) return getLead(db, id);
  const res = await db
    .prepare(`UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => lead[c]), new Date().toISOString(), id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Lead not found. It may have been deleted.");
  return getLead(db, id);
}

function decodeLead(row) {
  let issues = [];
  try {
    issues = row.site_issues ? JSON.parse(row.site_issues) : [];
  } catch {}
  return { ...row, site_issues: issues, later: !!row.later };
}

// ---------- calls ----------

async function logCall(db, leadId, input) {
  const outcome = String(input.outcome || "");
  if (!OUTCOMES.includes(outcome)) throw new HttpError(400, "Pick a call outcome.");
  await getLead(db, leadId);

  const now = new Date().toISOString();
  const call = {
    id: crypto.randomUUID(),
    lead_id: leadId,
    called_at: now,
    outcome,
    note: input.note ? String(input.note).trim().slice(0, 5000) || null : null,
  };
  const update = cleanLead(
    {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.next_follow_up !== undefined ? { next_follow_up: input.next_follow_up } : {}),
    },
    { partial: true },
  );
  const cols = Object.keys(update);

  await db.batch([
    db
      .prepare("INSERT INTO calls (id, lead_id, called_at, outcome, note) VALUES (?, ?, ?, ?, ?)")
      .bind(call.id, call.lead_id, call.called_at, call.outcome, call.note),
    db
      .prepare(
        `UPDATE leads SET ${cols.map((c) => `${c} = ?, `).join("")}last_called_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(...cols.map((c) => update[c]), now, now, leadId),
  ]);
  return { call, lead: await getLead(db, leadId) };
}

// ---------- lead search (Google Places API, New) ----------

const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "fb.me", "instagram.com", "linktr.ee", "linkedin.com", "tiktok.com", "twitter.com",
  "x.com", "yelp.com", "yelp.ca", "youtube.com", "business.site", "sites.google.com", "wa.me", "linkin.bio",
];

async function searchPlaces(env, db, input) {
  const category = String(input.category || "").trim().slice(0, 100);
  const city = String(input.city || "").trim().slice(0, 100);
  if (!category || !city) throw new HttpError(400, "Enter a category and a city.");
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new HttpError(503, "Google search isn't set up. Add GOOGLE_PLACES_API_KEY as a secret on the Worker, then try again.");
  }

  const fields = [
    "places.id", "places.displayName", "places.formattedAddress", "places.addressComponents",
    "places.nationalPhoneNumber", "places.internationalPhoneNumber", "places.websiteUri",
    "places.googleMapsUri", "places.businessStatus", "places.primaryTypeDisplayName", "nextPageToken",
  ].join(",");

  const places = [];
  let pageToken;
  let requests = 0;
  do {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
      body: JSON.stringify({ textQuery: `${category} in ${city}`, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
    });
    requests++;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `status ${res.status}`;
      throw new HttpError(502, `Google rejected the search: ${msg}`);
    }
    places.push(...(data.places || []));
    pageToken = data.nextPageToken;
  } while (pageToken && requests < 3);

  const { results: existing } = await db.prepare("SELECT place_id FROM leads WHERE place_id IS NOT NULL").all();
  const known = new Set(existing.map((r) => r.place_id));

  const results = places
    .filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY")
    .map((p) => {
      const comp = (t) => p.addressComponents?.find((c) => c.types?.includes(t))?.longText;
      const website = p.websiteUri || null;
      let flag = "unknown";
      if (!website) flag = "none";
      else if (isSocial(website)) flag = "social";
      return {
        place_id: p.id,
        business: p.displayName?.text || "Unnamed business",
        category: p.primaryTypeDisplayName?.text || category,
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
        address: p.formattedAddress || null,
        city: comp("locality") || comp("sublocality") || comp("postal_town") || city,
        website,
        maps_url: p.googleMapsUri || null,
        site_flag: flag,
        site_issues: [],
        in_tracker: known.has(p.id),
        temporarily_closed: p.businessStatus === "CLOSED_TEMPORARILY",
      };
    });
  return { query: { category, city }, requests, results };
}

function isSocial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Quick health check of a business website. Any issue marks it as a weak site.
async function checkSite(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "That website address isn't valid.");
  }
  if (isSocial(url.href)) return { site_flag: "social", site_issues: ["Social page only"] };

  const issues = [];
  const httpsUrl = `https://${url.host}${url.pathname}${url.search}`;
  const httpUrl = `http://${url.host}${url.pathname}${url.search}`;

  let page = await fetchPage(httpsUrl);
  if (!page.ok) {
    const plain = await fetchPage(httpUrl);
    if (!plain.ok) return { site_flag: "weak", site_issues: ["Site is down or unreachable"] };
    page = plain;
  }
  if (!page.finalUrl.startsWith("https://")) issues.push("No HTTPS");
  if (page.ms > 4000) issues.push("Slow to load");

  const html = page.html;
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) issues.push("Not mobile friendly");

  const year = new Date().getUTCFullYear();
  const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)[^<]{0,40}?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)]
    .map((m) => Number(m[2] || m[1]))
    .filter((y) => y <= year);
  if (years.length && Math.max(...years) <= year - 3) issues.push(`Copyright ${Math.max(...years)}`);

  if (/<frameset|<marquee|<font[\s>]|\.swf["']/i.test(html)) issues.push("Outdated code");
  if (/content=["']?(?:WordPress [1-4]\.|Microsoft FrontPage|iWeb|Adobe Dreamweaver)/i.test(html)) issues.push("Old site builder");

  return { site_flag: issues.length ? "weak" : "good", site_issues: issues };
}

async function fetchPage(target) {
  const started = Date.now();
  try {
    const res = await fetch(target, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; efenefe-site-check/1.0)", accept: "text/html" },
      signal: AbortSignal.timeout(9000),
    });
    if (res.status >= 400) return { ok: false };
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      while (html.length < 300_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    }
    return { ok: true, finalUrl: res.url || target, html, ms: Date.now() - started };
  } catch {
    return { ok: false };
  }
}

// ---------- auth (Cloudflare Access) ----------

let jwksCache = { at: 0, keys: null, domain: null };

async function authenticate(request, env) {
  if (env.DEV_ALLOW_NO_AUTH === "true") return { email: "dev@localhost" };

  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = env.ACCESS_AUD || "";
  if (!team || !aud) {
    return { error: "Login isn't set up yet. Add ACCESS_TEAM_DOMAIN and ACCESS_AUD to the Worker's variables." };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const payload = await verifyAccessJwt(token, team, aud);
  return payload ? { email: payload.email || "" } : null;
}

async function verifyAccessJwt(token, team, aud) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlText(h));
    payload = JSON.parse(b64urlText(p));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;

  let key = await findKey(team, header.kid, false);
  if (!key) key = await findKey(team, header.kid, true);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return ok ? payload : null;
}

async function findKey(team, kid, refresh) {
  const stale = Date.now() - jwksCache.at > 3600_000 || jwksCache.domain !== team;
  if (refresh || stale || !jwksCache.keys) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const { keys } = await res.json();
    jwksCache = { at: Date.now(), keys, domain: team };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}

// ---------- helpers ----------

async function body(request) {
  try {
    const data = await request.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  throw new HttpError(400, "Request body must be a JSON object.");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
