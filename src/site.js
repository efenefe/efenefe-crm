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
    if (!plain.ok) return { site_flag: "weak", site_issues: ["Site is down or unreachable"], html: "", finalUrl: url.href };
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

  return { site_flag: issues.length ? "weak" : "good", site_issues: issues, html, finalUrl: page.finalUrl };
}

export async function fetchPage(target) {
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
