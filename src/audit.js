// Website audit reports: a queue of audits in D1, worked through by the scheduled trigger.
// Each audit runs Google PageSpeed Insights (mobile), ranks the 3 biggest issues in code,
// then has Claude write a short title and impact line for each. The report never says how to fix an issue.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { HttpError } from "./http.js";
import { isSocial, inspectSite } from "./site.js";

export const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    url TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    scores TEXT,
    issues TEXT,
    screenshot TEXT,
    writer TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS reports_lead ON reports(lead_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at)`,
];

const MAX_ATTEMPTS = 2;
const STALE_MS = 5 * 60_000; // a running audit older than this was cut off and goes back in the queue
const PER_RUN = 3; // audits started in parallel by each scheduled run
const MODEL = "claude-opus-5-5";

// ---------- queue ----------

export async function queueAudits(db, input) {
  const ids = Array.isArray(input.lead_ids) ? [...new Set(input.lead_ids.map(String))].slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, "Select at least one lead to audit.");

  const out = { queued: 0, skipped: [], already: 0 };
  const now = new Date().toISOString();
  const stmts = [];
  for (const id of ids) {
    const lead = await db.prepare("SELECT id, business, website FROM leads WHERE id = ?").bind(id).first();
    if (!lead) continue;
    const busy = await db
      .prepare("SELECT 1 FROM reports WHERE lead_id = ? AND status IN ('queued', 'running') LIMIT 1")
      .bind(id)
      .first();
    if (busy) {
      out.already++;
      continue;
    }
    let reason = "";
    if (!lead.website) reason = "No website to audit";
    else if (isSocial(/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`)) reason = "Only a social page, nothing to audit";
    const status = reason ? "skipped" : "queued";
    if (reason) out.skipped.push({ lead_id: id, business: lead.business, reason });
    else out.queued++;
    stmts.push(
      db
        .prepare("INSERT INTO reports (id, lead_id, status, url, error, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, status, lead.website || null, reason || null, now, reason ? now : null),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return out;
}

// Latest audit per lead (any state), plus the latest finished one, without screenshots.
export async function listReports(db) {
  const { results } = await db
    .prepare("SELECT id, lead_id, status, url, score, scores, issues, error, created_at, finished_at FROM reports ORDER BY created_at DESC")
    .all();
  const byLead = new Map();
  for (const r of results) {
    const row = decode(r);
    let e = byLead.get(r.lead_id);
    if (!e) byLead.set(r.lead_id, (e = { lead_id: r.lead_id, latest: row, done: null }));
    if (!e.done && r.status === "done") e.done = row;
  }
  return [...byLead.values()];
}

export async function getReport(db, id) {
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Report not found. It may have been replaced by a newer audit.");
  return decode(row);
}

function decode(r) {
  const parse = (v) => {
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  return { ...r, scores: parse(r.scores), issues: parse(r.issues) || [] };
}

// Called by the scheduled trigger. Puts stale audits back in the queue, then runs a few.
export async function processQueue(env, deps = {}) {
  const db = env.DB;
  const now = Date.now();
  const staleBefore = new Date(now - STALE_MS).toISOString();
  await db.batch([
    db
      .prepare("UPDATE reports SET status = 'queued' WHERE status = 'running' AND started_at < ? AND attempts < ?")
      .bind(staleBefore, MAX_ATTEMPTS),
    db
      .prepare("UPDATE reports SET status = 'failed', error = 'The audit timed out twice.', finished_at = ? WHERE status = 'running' AND started_at < ? AND attempts >= ?")
      .bind(new Date(now).toISOString(), staleBefore, MAX_ATTEMPTS),
  ]);
  const runs = [];
  for (let i = 0; i < PER_RUN; i++) {
    const job = await claim(db);
    if (!job) break;
    runs.push(runJob(env, job, deps));
  }
  await Promise.all(runs);
  return runs.length;
}

async function claim(db) {
  return db
    .prepare(
      `UPDATE reports SET status = 'running', started_at = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM reports WHERE status = 'queued' ORDER BY created_at LIMIT 1) AND status = 'queued'
       RETURNING *`,
    )
    .bind(new Date().toISOString())
    .first();
}

async function runJob(env, job, deps) {
  const db = env.DB;
  try {
    const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(job.lead_id).first();
    if (!lead) {
      await db.prepare("DELETE FROM reports WHERE id = ?").bind(job.id).run();
      return;
    }
    const result = await runAudit(env, lead, deps);
    const finished = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          `UPDATE reports SET status = 'done', url = ?, score = ?, scores = ?, issues = ?, screenshot = ?, writer = ?, error = NULL, finished_at = ? WHERE id = ?`,
        )
        .bind(result.url, result.score, JSON.stringify(result.scores), JSON.stringify(result.issues), result.screenshot, result.writer, finished, job.id),
      // The audit is the better test, so it replaces the quick check's flag and issues on the lead.
      db
        .prepare("UPDATE leads SET site_flag = ?, site_issues = ?, updated_at = ? WHERE id = ? AND site_flag NOT IN ('none', 'social')")
        .bind(result.site_flag, JSON.stringify(result.site_issues), finished, job.lead_id),
      // Keep only the newest finished report per lead; screenshots make old ones heavy.
      db.prepare("DELETE FROM reports WHERE lead_id = ? AND id != ? AND status IN ('done', 'failed', 'skipped')").bind(job.lead_id, job.id),
    ]);
  } catch (err) {
    console.error("audit failed", job.id, err);
    const msg = err instanceof AuditError ? err.message : "Something went wrong while auditing this site.";
    const retry = job.attempts < MAX_ATTEMPTS && !(err instanceof AuditError && err.final);
    await db
      .prepare(retry
        ? "UPDATE reports SET status = 'queued', error = ? WHERE id = ?"
        : "UPDATE reports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .bind(...(retry ? [msg, job.id] : [msg, new Date().toISOString(), job.id]))
      .run();
  }
}

class AuditError extends Error {
  constructor(message, { final = false } = {}) {
    super(message);
    this.final = final;
  }
}

// ---------- the audit ----------

export async function runAudit(env, lead, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const key = env.PAGESPEED_API_KEY || env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new AuditError("PageSpeed isn't set up. Add PAGESPEED_API_KEY as a secret on the Worker.", { final: true });

  const site = await (deps.inspectSite || inspectSite)(lead.website);
  if (site.site_flag === "social") throw new AuditError("Only a social page, nothing to audit.", { final: true });
  // Our own fetch can be refused by bot protection, so it never decides on its own that a site is down.
  // PageSpeed loads the page in a real Chrome; only if that fails too is the site treated as down.
  const ourFetchFailed = !site.html && site.site_issues.includes("Site is down or unreachable");

  const target = site.finalUrl || lead.website;
  const qs = new URLSearchParams({ url: target, strategy: "mobile", key });
  for (const c of ["performance", "seo", "accessibility", "best-practices"]) qs.append("category", c);
  let data;
  try {
    const res = await fetchFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, {
      signal: AbortSignal.timeout(90_000),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (ourFetchFailed) throw new AuditError("The site is down or unreachable.");
      const msg = data?.error?.message || `status ${res.status}`;
      throw new AuditError(`PageSpeed couldn't test the site: ${msg.slice(0, 200)}`, { final: res.status === 400 || res.status === 403 });
    }
  } catch (err) {
    if (err instanceof AuditError) throw err;
    throw new AuditError("PageSpeed took too long to answer.");
  }
  const lh = data.lighthouseResult;
  if (!lh?.categories) {
    if (ourFetchFailed) throw new AuditError("The site is down or unreachable.");
    throw new AuditError("PageSpeed returned no results for this site.");
  }
  const finalUrl = lh.finalDisplayedUrl || lh.finalUrl || target;

  const scores = {
    performance: pct(lh.categories.performance?.score),
    seo: pct(lh.categories.seo?.score),
    accessibility: pct(lh.categories.accessibility?.score),
    best_practices: pct(lh.categories["best-practices"]?.score),
  };
  const vals = Object.values(scores).filter((v) => v != null);
  const score = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;

  const top = rankIssues(lh.audits || {}, site, scores, finalUrl).slice(0, 3);
  const written = await writeIssues(env, lead, top, deps).catch((err) => {
    console.error("claude write-up failed", err);
    return null;
  });
  const issues = top.map((i, n) => ({
    type: i.type,
    facts: i.facts,
    title: written?.[n]?.title || TEMPLATES[i.type].title,
    impact: written?.[n]?.impact || TEMPLATES[i.type].impact,
  }));

  return {
    url: finalUrl,
    ...siteFromAudit(lh.audits || {}, site, scores, finalUrl),
    score,
    scores,
    issues,
    screenshot: lh.audits?.["final-screenshot"]?.details?.data || null,
    writer: written ? MODEL : "template",
  };
}

const pct = (v) => (typeof v === "number" ? Math.round(v * 100) : null);
const failed = (a) => a && typeof a.score === "number" && a.score < 0.9;
const secs = (ms) => (ms / 1000).toFixed(1);
const mb = (bytes) => (bytes / 1_048_576).toFixed(1);

// Every failed check becomes a candidate issue with a weight for business impact.
// The 3 heaviest win, one per type. Facts are the real numbers Claude may use.
// The lead's Website flag and Site issues, redone from the audit. Google's browser is the judge of
// HTTPS, mobile layout and speed; our own fetch only adds what it read in the page (copyright year, old code).
export function siteFromAudit(audits, site, scores, finalUrl) {
  const issues = [];
  if (/^http:/i.test(finalUrl || "")) issues.push("No HTTPS");
  if (audits.viewport && audits.viewport.score === 0) issues.push("Not mobile friendly");
  const lcp = audits["largest-contentful-paint"]?.numericValue;
  if ((typeof lcp === "number" && lcp > 4000) || (typeof scores?.performance === "number" && scores.performance < 50)) {
    issues.push("Slow to load");
  }
  for (const i of site?.site_issues || []) {
    if (/^Copyright \d{4}$/.test(i) || i === "Outdated code" || i === "Old site builder") issues.push(i);
  }
  return { site_flag: issues.length ? "weak" : "good", site_issues: issues };
}

export function rankIssues(audits, site, scores, finalUrl) {
  const out = [];
  const add = (type, weight, facts) => out.push({ type, weight, facts });
  const html = site?.html || "";
  const siteIssues = site?.site_issues || [];

  if (audits["is-crawlable"] && audits["is-crawlable"].score === 0) {
    add("hidden_from_google", 100, ["The homepage tells Google not to show it in search results."]);
  }
  // Only when Google's browser ended up on an http:// address. A failed "is-on-https" check alone usually
  // means a few images or scripts load over http on an https page; browsers don't show "Not secure" for that.
  const onHttp = finalUrl ? /^http:/i.test(finalUrl) : siteIssues.includes("No HTTPS");
  if (onHttp) {
    add("not_secure", 92, ["The site loads without HTTPS, so browsers label it \"Not secure\"."]);
  }
  const noViewport = audits.viewport ? audits.viewport.score === 0 : siteIssues.includes("Not mobile friendly");
  if (noViewport) {
    add("not_mobile", 90, ["The homepage has no mobile layout setting, so phones show a shrunken desktop page."]);
  }

  const lcp = audits["largest-contentful-paint"]?.numericValue;
  const perfScore = scores?.performance;
  const slowLcp = typeof lcp === "number" && lcp > 4000;
  const perfLow = typeof perfScore === "number" && perfScore < 50;
  if (slowLcp || perfLow) {
    const facts = [];
    if (typeof lcp === "number") facts.push(`On a phone, the main content takes ${secs(lcp)} seconds to appear. Google's target is under 2.5 seconds.`);
    const si = audits["speed-index"]?.numericValue;
    if (typeof si === "number") facts.push(`The page is visibly loading for about ${secs(si)} seconds.`);
    const weight = Math.min(88, 45 + (typeof lcp === "number" ? Math.min(40, (lcp - 2500) / 200) : 20));
    add("slow", Math.round(weight), facts);
  }

  const title = audits["document-title"];
  const meta = audits["meta-description"];
  if (title && title.score === 0) {
    add("search_listing", 70, ["The homepage has no page title, so Google has to guess what to show as the headline in search results."]);
  } else if (meta && meta.score === 0) {
    add("search_listing", 50, ["The homepage has no meta description, so Google picks a random snippet of text to show under its name in search results."]);
  }

  const alt = audits["image-alt"];
  if (failed(alt)) {
    const missing = alt.details?.items?.length || 0;
    const total = (html.match(/<img\b/gi) || []).length;
    const fact = missing && total >= missing
      ? `${missing} of ${total} images on the homepage have no alt text.`
      : missing ? `${missing} images on the homepage have no alt text.` : "Images on the homepage have no alt text.";
    add("missing_alt", 40 + Math.min(30, missing * 3), [fact, "Alt text is what Google and screen readers use to understand an image."]);
  }

  if (html) {
    const body = html.replace(/<!--[\s\S]*?-->/g, "");
    const h1 = (body.match(/<h1[\s>]/gi) || []).length;
    if (h1 === 0) add("headings", 35, ["The homepage has no main heading (H1), which Google uses to understand what the page is about."]);
    else if (h1 > 1) add("headings", 25, [`The homepage has ${h1} main headings (H1). A page should have one.`]);
  }

  const savings = ["uses-optimized-images", "modern-image-formats", "uses-responsive-images"]
    .reduce((sum, k) => Math.max(sum, audits[k]?.details?.overallSavingsBytes || 0), 0);
  if (savings > 300_000) {
    const facts = [`The images could be about ${mb(savings)} MB smaller without looking different.`];
    const total = audits["total-byte-weight"]?.numericValue;
    if (typeof total === "number") facts.push(`The whole homepage weighs ${mb(total)} MB, which phones on mobile data have to download.`);
    add("heavy_images", Math.round(30 + Math.min(30, (savings / 1_048_576) * 10)), facts);
  }

  const contrast = audits["color-contrast"];
  if (failed(contrast)) {
    const n = contrast.details?.items?.length || 0;
    add("low_contrast", 25, [n ? `${n} pieces of text are hard to read because their color is too close to the background.` : "Some text is hard to read because its color is too close to the background."]);
  }

  const dated = siteIssues.filter((i) => /^Copyright \d{4}$/.test(i) || i === "Outdated code" || i === "Old site builder");
  if (dated.length) {
    const facts = dated.map((i) => (/^Copyright/.test(i)
      ? `The footer still says ${i.replace("Copyright", "©")}, which tells visitors the site isn't kept up to date.`
      : i === "Outdated code" ? "The site uses web code that has been out of date for over a decade." : "The site was made with a site builder that is no longer supported."));
    add("outdated", 30, facts);
  }

  const best = new Map();
  for (const i of out.sort((a, b) => b.weight - a.weight)) if (!best.has(i.type)) best.set(i.type, i);
  return [...best.values()];
}

// Plain wording used when Claude is not set up or fails. Never says how to fix the issue.
export const TEMPLATES = {
  hidden_from_google: { title: "Hidden from Google search", impact: "The site tells Google not to list it, so people searching for this business won't find the website at all." },
  not_secure: { title: "Browsers warn visitors it's not secure", impact: "Visitors see a \"Not secure\" warning before they see the business. Many leave right away, and Google ranks these sites lower." },
  not_mobile: { title: "Hard to use on a phone", impact: "Most visitors arrive on a phone and get a tiny desktop page they have to pinch and zoom. Many give up and call a competitor instead." },
  slow: { title: "Slow to load on phones", impact: "The page takes too long to show anything on a phone. Visitors leave a slow site within seconds, and Google ranks slow sites lower." },
  search_listing: { title: "Weak Google search listing", impact: "What shows up in Google results for this site is missing or random, so fewer people searching click through to it." },
  missing_alt: { title: "Images Google can't read", impact: "Images without descriptions are invisible to Google and to visitors using screen readers, so the site misses search traffic and some customers." },
  headings: { title: "Page structure confuses Google", impact: "Without a clear main heading, Google has a harder time understanding what the business offers, which hurts its ranking." },
  heavy_images: { title: "Oversized images slow the site", impact: "The images are much heavier than they need to be, which makes the site slow on mobile data and costs visitors their patience." },
  low_contrast: { title: "Text is hard to read", impact: "Some text blends into its background, so visitors, especially older ones, struggle to read key information." },
  outdated: { title: "The site looks out of date", impact: "Signs of an old, unmaintained site make visitors wonder if the business is still open, and they lose trust." },
};

const WRITE_SYSTEM = `You write findings for a short website review that a web designer sends to a small business owner before a sales call.
For each issue you get, write:
- title: at most 7 words, plain language, no jargon, no exclamation marks.
- impact: 1 or 2 sentences, at most 45 words, on what the issue costs the business (lost customers, trust, Google visibility). Use the numbers from the facts when they help.
Rules:
- Never say how to fix the issue, what to change, or what tools to use. Only describe the problem and its impact.
- Use only the facts given. Do not invent numbers, statistics or details.
- Write in English, in a calm, factual, friendly tone. Do not use em dashes.
- Return the issues in the same order and with the same type values you received.`;

const WrittenIssues = z.object({
  issues: z.array(z.object({ type: z.string(), title: z.string(), impact: z.string() })),
});

async function writeIssues(env, lead, issues, deps) {
  if (!issues.length) return [];
  if (!env.ANTHROPIC_API_KEY && !deps.anthropic) return null;
  const client = deps.anthropic || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const input = {
    business: lead.business,
    category: lead.category || null,
    city: lead.city || null,
    issues: issues.map((i) => ({ type: i.type, facts: i.facts })),
  };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: WRITE_SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(WrittenIssues) },
    messages: [{ role: "user", content: JSON.stringify(input, null, 2) }],
  });
  if (response.stop_reason === "refusal") return null;
  const out = response.parsed_output?.issues;
  if (!Array.isArray(out) || out.length !== issues.length) return null;
  if (out.some((o, n) => o.type !== issues[n].type || !o.title.trim() || !o.impact.trim())) return null;
  return out.map((o) => ({ title: o.title.trim().slice(0, 120), impact: o.impact.trim().slice(0, 600) }));
}
