// Website checks shared by Find leads and the audit reports.

import { HttpError } from "./http.js";

export const SOCIAL_HOSTS = [
  "facebook.com", "fb.com", "fb.me", "instagram.com", "linktr.ee", "linkedin.com", "tiktok.com", "twitter.com",
  "x.com", "yelp.com", "yelp.ca", "youtube.com", "business.site", "sites.google.com", "wa.me", "linkin.bio",
];

export function isSocial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Quick health check of a business website. Any issue marks it as a weak site.
export async function checkSite(raw) {
  const { site_flag, site_issues } = await inspectSite(raw);
  return { site_flag, site_issues };
}

// Same check, plus the page HTML for the audit report. html is "" when the site could not be read.
export async function inspectSite(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "That website address isn't valid.");
  }
  if (isSocial(url.href)) return { site_flag: "social", site_issues: ["Social page only"], html: "", finalUrl: url.href };

  const issues = [];
  const httpsUrl = `https://${url.host}${url.pathname}${url.search}`;
  const httpUrl = `http://${url.host}${url.pathname}${url.search}`;

  let page = await fetchPage(httpsUrl);
  if (!page.ok) {
    const plain = await fetchPage(httpUrl);
    if (plain.ok) {
      page = plain;
    } else if (page.reason === "blocked" || plain.reason === "blocked") {
      // The site answered but refused our check (bot protection, rate limit, timeout). That says nothing
      // about the site itself, so don't report it as an issue; the audit (Google's browser) can still test it.
      return { site_flag: "unknown", site_issues: [], html: "", finalUrl: url.href, blocked: true };
    } else {
      return { site_flag: "weak", site_issues: ["Site is down or unreachable"], html: "", finalUrl: url.href };
    }
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

  return { site_flag: issues.length ? "weak" : "good", site_issues: issues, html, finalUrl: page.finalUrl };
}

// Statuses that mean "the server is up but turned our request away", not "the site is broken".
const BLOCKED_STATUSES = new Set([401, 403, 406, 429, 503]);

// reason on failure: "blocked" (the server answered but refused us, or was too slow) or "down" (no answer at all).
export async function fetchPage(target) {
  const started = Date.now();
  try {
    const res = await fetch(target, {
      redirect: "follow",
      headers: {
        // A plain browser identity: many small-business hosts block anything that looks like a bot.
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-CA,fr;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status >= 400) {
      res.body?.cancel().catch(() => {});
      return { ok: false, reason: BLOCKED_STATUSES.has(res.status) ? "blocked" : "down", status: res.status };
    }
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
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, reason: timedOut ? "blocked" : "down" };
  }
}
