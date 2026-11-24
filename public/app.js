// efenefe CRM front end. Plain JS, no build step.

const STATUS = {
  to_call: "To call", called: "Called", interested: "Interested", follow_up: "Follow up",
  proposal: "Proposal sent", won: "Won", lost: "Lost",
};
const FLAG = {
  weak: "Weak website", none: "No website", social: "Social only", good: "Good website", unknown: "Not checked",
};
const FLAG_RANK = { weak: 0, none: 1, social: 1, unknown: 2, good: 3 };
const OUTCOME = {
  no_answer: "No answer", voicemail: "Left voicemail", call_back: "Call back later",
  interested: "Spoke: interested", not_interested: "Spoke: not interested", wrong_number: "Wrong number",
};
// What each outcome suggests for the lead. You can always change it before saving.
const SUGGEST = {
  no_answer: { status: "keep_or_called", days: 2 },
  voicemail: { status: "keep_or_called", days: 2 },
  call_back: { status: "follow_up", days: 1 },
  interested: { status: "interested", days: 2 },
  not_interested: { status: "lost", days: null },
  wrong_number: { status: "lost", days: null },
};
const CLOSED = new Set(["won", "lost"]);

const state = {
  leads: [],
  me: "",
  view: "today",
  leadsFilter: { q: "", status: "open", flag: "all", sort: "next_follow_up", dir: "asc" },
  leadSel: new Set(),
  moveConfirm: false,
  callIndex: 0,
  callFocus: false,
  panel: null, // { id } or { id: null } for new
  stats: null,
  statsLoading: false,
  reports: new Map(), // lead_id -> { latest, done } (no screenshots)
  reportId: null,
  reportCache: new Map(), // report id -> full report
};

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");

// ---------- utils ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = () => ymd(new Date());
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysFromToday(s) {
  return Math.round((parseYmd(s) - parseYmd(today())) / 864e5);
}
function shortDate(s) {
  if (!s) return "";
  const d = parseYmd(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
function dueLabel(s) {
  if (!s) return "";
  const n = daysFromToday(s);
  if (n < 0) return n === -1 ? "Yesterday" : `${-n} days late`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n < 7) return parseYmd(s).toLocaleDateString(undefined, { weekday: "short" });
  return shortDate(s);
}
function dueClass(s) {
  if (!s) return "";
  const n = daysFromToday(s);
  return n < 0 ? "overdue" : n === 0 ? "today" : "";
}
function telHref(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : "";
}
function webHref(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
function prettyUrl(url) {
  return String(url || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}
function when(iso) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

const flagChip = (f) => `<span class="flag ${esc(f)}">${esc(FLAG[f] || FLAG.unknown)}</span>`;
const statusChip = (s) => `<span class="status ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const dueChip = (s) => (s ? `<span class="due ${dueClass(s)}">${esc(dueLabel(s))}</span>` : "");

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2600);
}

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) throw new Error("Your login expired. Reload the page to sign in again.");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function upsertLead(lead) {
  const i = state.leads.findIndex((l) => l.id === lead.id);
  if (i >= 0) state.leads[i] = lead;
  else state.leads.unshift(lead);
}

// ---------- derived lists ----------

function followUpsDue() {
  const t = today();
  return state.leads
    .filter((l) => !l.later && l.next_follow_up && l.next_follow_up <= t && !CLOSED.has(l.status))
    .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up) || FLAG_RANK[a.site_flag] - FLAG_RANK[b.site_flag]);
}
function newToCall() {
  const t = today();
  return state.leads
    .filter((l) => !l.later && l.status === "to_call" && !(l.next_follow_up && l.next_follow_up <= t))
    .sort((a, b) => (FLAG_RANK[a.site_flag] ?? 2) - (FLAG_RANK[b.site_flag] ?? 2) || a.created_at.localeCompare(b.created_at));
}
function callQueue() {
  return [...followUpsDue(), ...newToCall()];
}

// ---------- views ----------

function setView(view) {
  const m = /^report\/([\w-]+)$/.exec(view || "");
  state.reportId = m ? m[1] : null;
  state.view = m ? "report" : ["today", "calls", "leads", "find"].includes(view) ? view : "today";
  const navView = state.view === "report" ? "leads" : state.view;
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.view === navView) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  render();
}

function render() {
  const n = callQueue().length;
  const badge = $("#calls-count");
  badge.hidden = n === 0;
  badge.textContent = n;
  renderAuditChip();
  ({ today: renderToday, calls: renderCalls, leads: renderLeads, find: renderFind, report: renderReport })[state.view]();
}

// ---------- website audits ----------

const AUDIT_POLL_MS = 5000;
let auditTimer = null;

function auditOf(leadId) {
  return state.reports.get(leadId) || null;
}
function pendingAudits() {
  let n = 0;
  for (const r of state.reports.values()) if (r.latest && (r.latest.status === "queued" || r.latest.status === "running")) n++;
  return n;
}
function scoreClass(n) {
  return n == null ? "" : n >= 90 ? "good" : n >= 50 ? "mid" : "bad";
}
function scorePill(n) {
  return n == null ? "" : `<span class="score ${scoreClass(n)}" title="Website score out of 100">${n}</span>`;
}
const SPINNER = `<i class="spinner" aria-hidden="true"></i>`;

// Audits started together since the queue was last empty: how many are finished, out of how many.
function batchProgress() {
  const all = [...state.reports.values()].map((r) => r.latest).filter(Boolean);
  const pending = all.filter((r) => r.status === "queued" || r.status === "running");
  if (!pending.length) return null;
  const start = pending.reduce((m, r) => (r.created_at < m ? r.created_at : m), pending[0].created_at);
  const total = all.filter((r) => r.created_at >= start && r.status !== "skipped").length;
  return { done: total - pending.length, total };
}
// Place in line for a queued audit (1 = next).
function queuePosition(report) {
  let n = 1;
  for (const r of state.reports.values()) if (r.latest?.status === "queued" && r.latest.created_at < report.created_at) n++;
  return n;
}
// "0:42" since an ISO time; kept live by the ticker below.
function elapsed(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(() => {
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = elapsed(el.dataset.since);
}, 1000);

// Small audit state shown next to the website flag.
function auditMini(leadId) {
  const a = auditOf(leadId);
  if (!a?.latest) return "";
  const s = a.latest.status;
  if (s === "queued") return `<span class="audit-state queued">Queued</span>`;
  if (s === "running") return `<span class="audit-state busy">${SPINNER}Auditing…</span>`;
  if (a.done) return scorePill(a.done.score);
  if (s === "failed") return `<span class="audit-state bad" title="${esc(a.latest.error || "")}">Audit failed</span>`;
  if (s === "skipped") return `<span class="audit-state" title="${esc(a.latest.error || "")}">Not audited</span>`;
  return "";
}

async function loadReports() {
  clearTimeout(auditTimer);
  try {
    const { reports } = await api("GET", "reports");
    const before = pendingAudits();
    state.reports = new Map(reports.map((r) => [r.lead_id, r]));
    const after = pendingAudits();
    if (before && after < before) {
      const done = before - after;
      toast(`${done} audit${done === 1 ? "" : "s"} finished`);
      // A finished audit also updates the lead's Website flag and Site issues.
      const { leads } = await api("GET", "leads").catch(() => ({}));
      if (leads) state.leads = leads;
    }
    refreshAuditViews();
  } catch {}
  if (pendingAudits()) auditTimer = setTimeout(loadReports, AUDIT_POLL_MS);
}

// Update only the parts that show audits, so a form you're typing in isn't reset.
function refreshAuditViews() {
  renderAuditChip();
  if (state.view === "leads") renderLeads();
  if (state.view === "today") renderToday();
  if (state.view === "report") renderReport();
  const box = $("#report-box");
  if (box && state.panel?.id) box.innerHTML = reportBox(state.panel.id);
}

function renderAuditChip() {
  const chip = $("#audit-chip");
  if (!chip) return;
  const p = batchProgress();
  chip.hidden = !p;
  if (!p) return;
  const pct = Math.round((p.done / p.total) * 100);
  chip.title = `${p.done} of ${p.total} audits finished`;
  chip.innerHTML = `${SPINNER}<span class="chip-text">Auditing <b>${p.done} of ${p.total}</b> done</span><span class="chip-bar" aria-hidden="true"><span style="width:${Math.max(pct, 6)}%"></span></span>`;
}

async function runAudits(ids, { bulk = false } = {}) {
  try {
    for (const b of document.querySelectorAll("[data-audit-bulk], [data-audit-one]")) {
      if (b.disabled) b.innerHTML = `${SPINNER}Starting…`;
    }
    const res = await api("POST", "audits", { lead_ids: ids });
    const parts = [];
    if (res.queued) parts.push(`Queued ${res.queued} audit${res.queued === 1 ? "" : "s"}. They run in the background, about 3 a minute.`);
    if (res.skipped.length) parts.push(`Skipped ${res.skipped.length} with no website to audit.`);
    if (res.already) parts.push(`${res.already} already in the queue.`);
    toast(parts.join(" ") || "Nothing to audit.");
    if (bulk) state.leadSel.clear();
    await loadReports();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

// Report section on the lead panel.
function reportBox(leadId) {
  const lead = state.leads.find((l) => l.id === leadId);
  const a = auditOf(leadId);
  const latest = a?.latest;
  const done = a?.done;
  const busy = latest && (latest.status === "queued" || latest.status === "running");
  const canAudit = lead?.website;
  const head = `<div class="card-head"><h2>Website report</h2>${done ? `<span class="link">${esc(when(done.finished_at || done.created_at).date)}</span>` : ""}</div>`;
  let bodyHtml = "";
  if (busy) {
    const running = latest.status === "running";
    bodyHtml = `<div class="audit-progress" role="status">
      <div class="audit-progress-head">
        ${running ? `<span class="audit-state busy">${SPINNER}Auditing</span>` : `<span class="audit-state queued">Queued, #${queuePosition(latest)} in line</span>`}
        ${running ? `<span class="elapsed" title="Time since this audit started" data-since="${esc(latest.started_at || latest.created_at)}">${elapsed(latest.started_at || latest.created_at)}</span>` : ""}
      </div>
      <div class="progress-track ${running ? "" : "waiting"}" aria-hidden="true"><span></span></div>
      <p class="muted">${running ? "Google is loading the site on a phone, then the 3 biggest issues are written up. Usually 1 to 2 minutes." : "Starts within a minute. You can close this tab, it keeps going."}</p>
    </div>`;
  } else if (latest?.status === "failed" && !done) {
    bodyHtml = `<p class="audit-note"><span class="audit-state bad">Audit failed</span> ${esc(latest.error || "")}</p>`;
  } else if (latest?.status === "skipped" && !done) {
    bodyHtml = `<p class="audit-note">${esc(latest.error || "Not audited.")}</p>`;
  } else if (!done) {
    bodyHtml = `<p class="audit-note muted">${canAudit ? "No audit yet. Run one to get a score and the 3 biggest issues with this site." : "Add a website to this lead to run an audit."}</p>`;
  }
  if (done) {
    bodyHtml += `<div class="report-mini">
      ${scorePill(done.score)}
      <ol class="issue-titles">${done.issues.map((i) => `<li>${esc(i.title)}</li>`).join("")}</ol>
    </div>`;
  }
  const actions = [
    done ? `<a class="btn primary small" href="#report/${esc(done.id)}" data-close>View report</a>` : "",
    canAudit && !busy ? `<button type="button" class="btn small" data-audit-one="${esc(leadId)}">${done || latest ? "Run again" : "Run audit"}</button>` : "",
  ].filter(Boolean).join("");
  return head + bodyHtml + (actions ? `<div class="report-actions">${actions}</div>` : "");
}

const CAT_LABEL = { performance: "Speed", seo: "Google search", accessibility: "Accessibility", best_practices: "Best practices" };

async function renderReport() {
  const id = state.reportId;
  let report = state.reportCache.get(id);
  if (!report) {
    main.innerHTML = `<div class="loading">Loading report…</div>`;
    try {
      ({ report } = await api("GET", `reports/${id}`));
      state.reportCache.set(id, report);
    } catch (err) {
      if (state.reportId !== id) return;
      main.innerHTML = `<div class="page-head"><div><h1>Website report</h1></div><a class="btn" href="#leads">Back to leads</a></div><div class="empty"><b>Couldn't open this report.</b> ${esc(err.message)}</div>`;
      return;
    }
    if (state.reportId !== id || state.view !== "report") return;
  }
  const lead = state.leads.find((l) => l.id === report.lead_id);
  const a = auditOf(report.lead_id);
  const busy = a?.latest && (a.latest.status === "queued" || a.latest.status === "running");
  const newer = a?.done && a.done.id !== report.id ? a.done : null;
  const s = report.scores || {};
  const audited = when(report.finished_at || report.created_at);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">Website report</p>
        <h1>${esc(lead?.business || "Deleted lead")}</h1>
        <p>${report.url ? `<a href="${esc(webHref(report.url))}" target="_blank" rel="noopener">${esc(prettyUrl(report.url))}</a> · ` : ""}Audited ${esc(audited.date)} on a phone</p>
      </div>
      <div class="head-actions">
        <a class="btn ghost" href="#leads">Back to leads</a>
        ${lead ? `<button class="btn" data-open="${esc(lead.id)}">Open lead</button>` : ""}
        ${lead?.website ? (busy ? `<button class="btn" disabled>${a.latest.status === "running" ? "Auditing…" : "Audit queued"}</button>` : `<button class="btn" data-audit-one="${esc(lead.id)}">Run again</button>`) : ""}
        <button class="btn primary" disabled title="Publishing to efenefe.com comes in the next update">Publish</button>
      </div>
    </div>
    ${newer ? `<div class="sel-bar"><span>A newer audit is ready.</span><span class="sel-actions"><a class="btn small primary" href="#report/${esc(newer.id)}">Open it</a></span></div>` : ""}
    <div class="report">
      <section class="card report-score">
        <div class="big-score ${scoreClass(report.score)}"><b>${report.score ?? "–"}</b><span>out of 100</span></div>
        <ul class="cat-scores">${Object.entries(CAT_LABEL).map(([k, label]) => s[k] == null ? "" : `
          <li><span>${label}</span><span class="track"><span class="fill ${scoreClass(s[k])}" style="width:${s[k]}%"></span></span><b>${s[k]}</b></li>`).join("")}</ul>
        ${report.screenshot ? `<figure class="shot"><img src="${esc(report.screenshot)}" alt="The homepage on a phone"><figcaption>The homepage on a phone</figcaption></figure>` : ""}
      </section>
      <section class="card report-issues">
        <div class="card-head"><h2>${report.issues.length ? `The ${report.issues.length === 1 ? "biggest issue" : `${report.issues.length} biggest issues`}` : "No major issues found"}</h2></div>
        ${report.issues.length ? `<ol class="issues-list">${report.issues.map((i, n) => `
          <li>
            <span class="num">${n + 1}</span>
            <div>
              <h3>${esc(i.title)}</h3>
              <p>${esc(i.impact)}</p>
              ${i.facts?.length ? `<ul class="evidence">${i.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
            </div>
          </li>`).join("")}</ol>` : `<p class="muted">This site passed the main checks. It may still be worth a look in person.</p>`}
        ${report.writer === "template" ? `<p class="hint">Written with standard wording. Add ANTHROPIC_API_KEY on the Worker for wording tailored to each site.</p>` : ""}
      </section>
    </div>`;
}

function leadRow(l, { showDue = true } = {}) {
  return `<li class="row" data-open="${esc(l.id)}" tabindex="0">
    <span class="name">${esc(l.business)}<span class="sub">${esc([l.category, l.city].filter(Boolean).join(" · ") || l.contact || "")}</span></span>
    <span class="flag-cell">${flagChip(l.site_flag)}</span>
    <span class="phone">${esc(l.phone || "")}</span>
    <span class="status-cell">${statusChip(l.status)}</span>
    <span class="due-cell">${showDue ? dueChip(l.next_follow_up) : ""}</span>
  </li>`;
}

const ICON = {
  bell: '<svg viewBox="0 0 20 20"><path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13zM8.5 18h3"/></svg>',
  user: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/></svg>',
  phone: '<svg viewBox="0 0 20 20"><path d="M6 3l2 4-2 1.5a9 9 0 0 0 5.5 5.5L13 12l4 2-1 3c-6.5 0-13-6.5-13-13z"/></svg>',
  trophy: '<svg viewBox="0 0 20 20"><path d="M6 3h8v4a4 4 0 0 1-8 0zM6 5H3.5a2.5 2.5 0 0 0 2.7 3M14 5h2.5a2.5 2.5 0 0 1-2.7 3M10 11v3M7 17h6M8 14h4v3H8z"/></svg>',
  go: '<svg viewBox="0 0 14 14"><path d="M4 10l6-6M5 4h5v5"/></svg>',
};

function firstName() {
  const local = (state.me || "").split("@")[0].split(/[._\-+0-9]/)[0];
  return /^[a-z]{2,}$/i.test(local) ? local[0].toUpperCase() + local.slice(1).toLowerCase() : "";
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// Calls per local day for the last 14 days, oldest first. Index 13 is today.
function callDays() {
  const days = Array(14).fill(0);
  const start = parseYmd(addDays(-13));
  for (const c of state.stats?.calls || []) {
    const d = new Date(c.called_at);
    const i = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 864e5);
    if (i >= 0 && i < 14) days[i]++;
  }
  return days;
}
async function loadStats() {
  state.statsLoading = true;
  try {
    state.stats = await api("GET", "stats");
  } catch {
    state.stats = { calls: [], failed: true };
  }
  state.statsLoading = false;
  if (state.view === "today") renderToday();
}

function ringSvg(pct, hue, label) {
  const r = 20, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct));
  return `<span class="ring ${hue}" role="img" aria-label="${esc(label)}" title="${esc(label)}">
    <svg viewBox="0 0 48 48"><circle class="track" cx="24" cy="24" r="${r}"/>${v ? `<circle class="val" cx="24" cy="24" r="${r}" stroke-dasharray="${(v / 100) * c} ${c}"/>` : ""}</svg>
    <b>${Math.round(v)}%</b></span>`;
}

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function activityCard() {
  const since = Date.now() - 7 * 864e5;
  const calls = (state.stats?.calls || []).filter((c) => new Date(c.called_at) >= since);
  if (!calls.length) return "";
  const groups = Object.keys(OUTCOME)
    .map((o) => ({ o, list: calls.filter((c) => c.outcome === o) }))
    .filter((g) => g.list.length)
    .sort((a, b) => b.list.length - a.list.length);
  return `
    <section class="card">
      <div class="card-head"><h2>This week's calls</h2><span class="count">${calls.length}</span></div>
      <ul class="activity">${groups.map(({ o, list }) => {
        const last = list[list.length - 1];
        const w = Math.max(30, Math.round((list.length / calls.length) * 100));
        return `<li><div class="block hue-${o}" style="width:${w}%"><b>${esc(OUTCOME[o])} · ${list.length}</b><span>${esc(last.business || "Deleted lead")}, ${esc(ago(last.called_at))}</span></div></li>`;
      }).join("")}</ul>
    </section>`;
}

function statTile({ href, status, icon, badge = "", label, num, foot, spark = "" }) {
  return `<a class="card stat" href="${href}" ${status ? `data-status="${status}"` : ""}>
    <div class="stat-top"><span class="badge ${badge}">${ICON[icon]}</span><span class="stat-label">${label}</span></div>
    <span class="stat-go" aria-hidden="true">${ICON.go}</span>
    <div class="stat-num">${num}</div>
    <div class="stat-foot"><span>${foot}</span>${spark}</div>
  </a>`;
}

function renderToday() {
  if (!state.stats && !state.statsLoading) loadStats();
  const t = today();
  const in7 = addDays(7);
  const weekAgo = addDays(-7);
  const open = state.leads.filter((l) => !l.later && !CLOSED.has(l.status) && l.next_follow_up);
  const overdue = open.filter((l) => l.next_follow_up < t).sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
  const due = open.filter((l) => l.next_follow_up === t);
  const soon = open.filter((l) => l.next_follow_up > t && l.next_follow_up <= in7).sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
  const toCall = newToCall();
  const best = toCall.filter((l) => l.site_flag === "weak" || l.site_flag === "none" || l.site_flag === "social").slice(0, 5);
  const queue = callQueue();
  const dueCount = overdue.length + due.length;
  const addedThisWeek = state.leads.filter((l) => l.created_at && ymd(new Date(l.created_at)) > weekAgo).length;

  const days = callDays();
  const thisWeek = days.slice(7).reduce((a, b) => a + b, 0);
  const lastWeek = days.slice(0, 7).reduce((a, b) => a + b, 0);
  const diff = thisWeek - lastWeek;
  const peak = Math.max(1, ...days.slice(7));
  const spark = `<span class="spark" aria-hidden="true">${days.slice(7).map((n) => `<i class="${n ? "on" : ""}" style="height:${Math.max(12, (n / peak) * 100)}%"></i>`).join("")}</span>`;
  const won = state.leads.filter((l) => l.status === "won").length;
  const lost = state.leads.filter((l) => l.status === "lost").length;
  const warm = state.leads.filter((l) => l.status === "interested" || l.status === "proposal").length;

  const name = firstName();
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const summary = state.leads.length === 0
    ? "Your tracker is empty. Find businesses to call, or add one by hand."
    : `${dueCount ? `${dueCount} follow-up${dueCount === 1 ? " needs" : "s need"} you today.` : "No follow-ups due today."}${toCall.length ? ` ${toCall.length} new lead${toCall.length === 1 ? "" : "s"} waiting for a first call.` : ""}`;

  const group = (title, list, cls) => list.length ? `
    <div class="group ${cls}">
      <div class="group-head">${title}<span class="count">${list.length}</span></div>
      <ul class="rows">${list.map((l) => leadRow(l)).join("")}</ul>
    </div>` : "";

  const followCard = `
    <section class="card">
      <div class="card-head"><h2>Follow-ups</h2><a class="link" href="#leads">All leads →</a></div>
      ${state.leads.length === 0
        ? `<div class="empty"><b>No leads yet.</b> Search Google with <a href="#find">Find leads</a>, or add one with <b>Add lead</b> above.</div>`
        : overdue.length + due.length + soon.length
          ? group("Overdue", overdue, "overdue") + group("Due today", due, "") + group("Next 7 days", soon, "")
          : `<div class="empty"><b>Nothing scheduled this week.</b> Follow-ups you set when logging a call show up here.</div>`}
    </section>`;

  const next = queue[0];
  const nextCard = next ? `
    <section class="card next-call">
      <div class="card-head"><h2>Next call</h2><span class="link">${queue.length} in queue</span></div>
      <div class="who">${esc(next.business)}</div>
      <div class="why">${next.next_follow_up && next.next_follow_up <= t ? `Follow-up ${esc(dueLabel(next.next_follow_up).toLowerCase())}` : esc(["New lead", next.category, next.city].filter(Boolean).join(" · "))}</div>
      <div class="meta">${flagChip(next.site_flag)}${auditMini(next.id)}</div>
      ${next.phone ? `<a class="phone-link" href="${esc(telHref(next.phone))}">${esc(next.phone)}</a>` : `<p class="why" style="margin:16px 0">No phone number yet.</p>`}
      <a class="btn primary" href="#calls">Start calling</a>
    </section>` : `
    <section class="card next-call">
      <div class="card-head"><h2>Next call</h2></div>
      <div class="who">You're all caught up.</div>
      <div class="why">No follow-ups due and no new leads to call.</div>
      <a class="btn primary" href="#find" style="margin-top:18px">Find leads</a>
    </section>`;

  const counts = Object.keys(STATUS).map((s) => [s, state.leads.filter((l) => l.status === s).length]);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const pipeCard = `
    <section class="card">
      <div class="card-head"><h2>Pipeline</h2><span class="count">${state.leads.length}</span></div>
      <ul class="bars">${counts.map(([s, n]) => `<li><a href="#leads" data-status="${s}" class="hue-${s} ${n ? "" : "zero"}"><span><i class="dot"></i>${STATUS[s]}</span><span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span><b>${n}</b></a></li>`).join("")}</ul>
    </section>`;


  const bestCard = best.length ? `
    <section class="card">
      <div class="card-head"><h2>Best prospects</h2><a class="link" href="#leads" data-status="to_call">See all →</a></div>
      <ul class="rows compact">${best.map((l) => `<li class="row" data-open="${esc(l.id)}" tabindex="0"><span class="name">${esc(l.business)}<span class="sub">${esc(l.city || l.category || "")}</span></span>${flagChip(l.site_flag)}</li>`).join("")}</ul>
    </section>` : "";

  main.innerHTML = `
    <div class="hello">
      <div>
        <p class="eyebrow">${esc(dateLine)}</p>
        <h1>${greeting()}${name ? `, ${esc(name)}` : ""}</h1>
        <p>${summary}</p>
      </div>
      <div class="head-actions">
        <button class="btn" data-new>Add lead</button>
        <a class="btn dark" href="#calls">Start calling</a>
      </div>
    </div>
    <div class="dash">
      <div class="dash-main">
        <div class="stats">
          ${statTile({ href: "#calls", icon: "bell", badge: "amber", label: "Follow-ups due", num: dueCount,
            foot: overdue.length ? `<span class="delta bad">${overdue.length} overdue</span>` : `<span class="delta">${soon.length} this week</span>`,
            spark: dueCount ? ringSvg((due.length / dueCount) * 100, "amber", `${Math.round((due.length / dueCount) * 100)}% on time`) : "" })}
          ${statTile({ href: "#calls", icon: "user", badge: "sky", label: "New leads to call", num: toCall.length,
            foot: addedThisWeek ? `<span class="delta up">+${addedThisWeek}</span> this week` : "None added this week",
            spark: toCall.length ? ringSvg((toCall.filter((l) => FLAG_RANK[l.site_flag] <= 1).length / toCall.length) * 100, "sky", "Share with a weak site or no site") : "" })}
          ${statTile({ href: "#leads", icon: "phone", badge: "indigo", label: "Calls this week", num: state.stats ? thisWeek : "–",
            foot: state.stats && !state.stats.failed ? `<span class="delta ${diff > 0 ? "up" : ""}">${diff > 0 ? "↑" : diff < 0 ? "↓" : ""}${diff ? Math.abs(diff) : "Same"}</span> vs last week` : "", spark: state.stats ? spark : "" })}
          ${statTile({ href: "#leads", status: "won", icon: "trophy", badge: "mint", label: "Clients won", num: won,
            foot: warm ? `<span class="delta up">${warm} warm</span> in play` : "No warm leads yet",
            spark: won + lost ? ringSvg((won / (won + lost)) * 100, "mint", `${Math.round((won / (won + lost)) * 100)}% win rate`) : "" })}
        </div>
        ${followCard}
        ${activityCard()}
      </div>
      <aside class="rail">
        ${nextCard}
        ${pipeCard}
        ${bestCard}
      </aside>
    </div>`;
}

function renderCalls() {
  const queue = callQueue();
  const dueIds = new Set(followUpsDue().map((l) => l.id));
  if (state.callIndex >= queue.length) state.callIndex = Math.max(0, queue.length - 1);
  const current = queue[state.callIndex];

  if (!queue.length) {
    main.innerHTML = `
      <div class="page-head"><div><h1>Call list</h1><p>Follow-ups due and new leads, weak websites first.</p></div></div>
      <div class="empty"><b>You're all caught up.</b> No follow-ups due and no new leads to call. Find new businesses with Find leads.</div>`;
    return;
  }

  const item = (l, i) => `
    <li class="row" data-call-index="${i}" tabindex="0" ${i === state.callIndex ? 'aria-current="true"' : ""}>
      <span class="name">${esc(l.business)}<span class="sub">${dueIds.has(l.id) ? `Follow-up ${esc(dueLabel(l.next_follow_up).toLowerCase())}` : esc(l.city || l.category || "New lead")}</span></span>
      <span>${flagChip(l.site_flag)}</span>
    </li>`;
  const dueList = queue.filter((l) => dueIds.has(l.id));
  const newList = queue.filter((l) => !dueIds.has(l.id));

  main.innerHTML = `
    <div class="page-head"><div><h1>Call list</h1><p>${queue.length} to call: follow-ups first, then new leads with weak websites first.</p></div></div>
    <div class="calls ${state.callFocus ? "focus" : ""}">
      <div class="queue">
        ${dueList.length ? `<div><div class="section-head"><h2>Follow-ups due</h2><span class="count">${dueList.length}</span></div><ul class="rows">${dueList.map((l) => item(l, queue.indexOf(l))).join("")}</ul></div>` : ""}
        ${newList.length ? `<div><div class="section-head"><h2>New leads</h2><span class="count">${newList.length}</span></div><ul class="rows">${newList.map((l) => item(l, queue.indexOf(l))).join("")}</ul></div>` : ""}
      </div>
      <div>
        <button class="btn ghost small show-phone" data-unfocus style="margin-bottom:8px">← All ${queue.length} calls</button>
        <article class="card" id="call-card">${callCard(current)}</article>
      </div>
    </div>`;
  bindLogForm($("#call-card"), current, { next: true });
}

function callCard(l) {
  const tel = telHref(l.phone);
  return `
    <div class="card-head">
      <div style="min-width:0">
        <h2 class="big">${esc(l.business)}</h2>
        <div class="meta">${flagChip(l.site_flag)} ${statusChip(l.status)} ${l.next_follow_up ? `<span class="due ${dueClass(l.next_follow_up)}">Follow-up ${esc(dueLabel(l.next_follow_up).toLowerCase())}</span>` : ""}</div>
      </div>
      <span class="head-actions"><button class="btn small" data-later-one="${esc(l.id)}" data-on="1">Save for later</button><button class="btn small" data-open="${esc(l.id)}">Edit lead</button></span>
    </div>
    <div class="dial">
      ${l.phone ? `<a class="phone-big" href="${esc(tel)}">${esc(l.phone)}</a>
        <a class="btn primary small" href="${esc(tel)}">Call</a>
        <button class="btn small" data-copy="${esc(l.phone)}">Copy</button>` : `<span class="none">No phone number. Add one with Edit lead.</span>`}
    </div>
    ${facts(l)}
    ${logForm(l, { next: true })}
    <div class="history-box"><h3 class="history-title">Call history</h3><div data-history="${esc(l.id)}"><span class="muted">Loading…</span></div></div>`;
}

function facts(l) {
  const rows = [
    ["Contact", esc(l.contact || "")],
    ["Category", esc(l.category || "")],
    ["Website", l.website ? `<a href="${esc(webHref(l.website))}" target="_blank" rel="noopener">${esc(prettyUrl(l.website))}</a>` : ""],
    ["Top issue", auditOf(l.id)?.done?.issues?.[0] ? `<a href="#report/${esc(auditOf(l.id).done.id)}">${esc(auditOf(l.id).done.issues[0].title)}</a> ${scorePill(auditOf(l.id).done.score)}` : ""],
    ["Site issues", l.site_issues?.length ? `<span class="issues">${l.site_issues.map((i) => `<span>${esc(i)}</span>`).join("")}</span>` : ""],
    ["Address", esc([l.address, l.city].filter(Boolean).join(", "))],
    ["Email", l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ""],
    ["Notes", l.notes ? `<span style="white-space:pre-wrap">${esc(l.notes)}</span>` : ""],
  ].filter(([, v]) => v);
  return rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : "";
}

function logForm(l, { next }) {
  const quick = [["+2 days", 2], ["+1 week", 7], ["+2 weeks", 14], ["+1 month", 30]];
  return `
    <form class="log" data-log="${esc(l.id)}" novalidate>
      <h3>Log this call</h3>
      <div class="choices" role="group" aria-label="Outcome">
        ${Object.entries(OUTCOME).map(([k, v]) => `<button type="button" data-outcome="${k}" aria-pressed="false">${v}</button>`).join("")}
      </div>
      <label class="field">Note<textarea class="input" name="note" id="log-note-${esc(l.id)}" placeholder="What did they say? Who did you speak to?"></textarea></label>
      <div class="grid-2">
        <label class="field">Status<select class="input" name="status" id="log-status-${esc(l.id)}">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === l.status ? "selected" : ""}>${v}</option>`).join("")}
        </select></label>
        <label class="field">Next follow-up<input class="input" type="date" name="next" id="log-next-${esc(l.id)}" value="${esc(l.next_follow_up && l.next_follow_up > today() ? l.next_follow_up : "")}">
          <span class="quick-dates">${quick.map(([t, n]) => `<button type="button" class="btn small" data-days="${n}">${t}</button>`).join("")}<button type="button" class="btn small ghost" data-days="">None</button></span>
        </label>
      </div>
      <div class="log-actions">
        ${next ? `<button type="button" class="btn ghost" data-skip>Skip</button>` : ""}
        <button type="submit" class="btn primary">${next ? "Save and next" : "Save call"}</button>
      </div>
    </form>`;
}

function bindLogForm(root, lead, { next }) {
  const form = root.querySelector(`form[data-log]`);
  if (!form) return;
  let outcome = null;
  form.addEventListener("click", (e) => {
    const o = e.target.closest("[data-outcome]");
    if (o) {
      outcome = o.dataset.outcome;
      form.querySelectorAll("[data-outcome]").forEach((b) => b.setAttribute("aria-pressed", String(b === o)));
      const s = SUGGEST[outcome];
      const status = s.status === "keep_or_called" ? (lead.status === "to_call" ? "called" : lead.status) : s.status;
      form.status.value = status;
      form.next.value = s.days == null ? "" : addDays(s.days);
    }
    const d = e.target.closest("[data-days]");
    if (d) form.next.value = d.dataset.days === "" ? "" : addDays(Number(d.dataset.days));
    if (e.target.closest("[data-skip]")) {
      state.callIndex++;
      renderCalls();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!outcome) return toast("Pick what happened on the call first.", true);
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const { lead: updated } = await api("POST", `leads/${lead.id}/calls`, {
        outcome,
        note: form.note.value,
        status: form.status.value,
        next_follow_up: form.next.value || null,
      });
      upsertLead(updated);
      state.stats = null;
      toast(`Logged: ${OUTCOME[outcome]}`);
      if (next) {
        // The saved lead may have left the queue; stay on the same position so the next lead shows.
        const stillThere = callQueue().findIndex((l) => l.id === lead.id);
        if (stillThere >= 0 && stillThere === state.callIndex) state.callIndex++;
        render();
      } else {
        render();
        openPanel(updated.id);
      }
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
  loadHistory(root, lead.id);
}

async function loadHistory(root, id) {
  const box = root.querySelector(`[data-history="${CSS.escape(id)}"]`);
  if (!box) return;
  try {
    const { calls } = await api("GET", `leads/${id}/calls`);
    if (!box.isConnected) return;
    box.innerHTML = calls.length
      ? `<ul class="history">${calls.map((c) => {
          const w = when(c.called_at);
          return `<li><span class="date">${esc(w.date)}<br>${esc(w.time)}</span><div><span class="what">${esc(OUTCOME[c.outcome] || c.outcome)}</span>${c.note ? `<p>${esc(c.note)}</p>` : ""}</div></li>`;
        }).join("")}</ul>`
      : `<span class="muted">No calls logged yet.</span>`;
  } catch (err) {
    box.textContent = err.message;
  }
}

function renderLeads() {
  const f = state.leadsFilter;
  const q = f.q.trim().toLowerCase();
  let list = state.leads.filter((l) => {
    if (f.status === "open" && CLOSED.has(l.status)) return false;
    if (f.status !== "open" && f.status !== "all" && l.status !== f.status) return false;
    if (f.flag !== "all" && l.site_flag !== f.flag) return false;
    if (q && ![l.business, l.phone, l.city, l.category, l.contact, l.email].some((v) => String(v || "").toLowerCase().includes(q))) return false;
    return true;
  });
  const key = f.sort;
  const dir = f.dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === "site_flag") { av = FLAG_RANK[av]; bv = FLAG_RANK[bv]; }
    if (key === "status") { av = Object.keys(STATUS).indexOf(av); bv = Object.keys(STATUS).indexOf(bv); }
    if (av == null || av === "") return 1;
    if (bv == null || bv === "") return -1;
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });

  const th = (k, label, cls = "") => `<th class="${cls}" ${f.sort === k ? `aria-sort="${f.dir === "asc" ? "ascending" : "descending"}"` : ""}><button type="button" data-sort="${k}">${label}</button></th>`;
  const hadFocus = document.activeElement?.id === "lead-search";
  for (const id of state.leadSel) if (!state.leads.some((l) => l.id === id)) state.leadSel.delete(id);
  const sel = [...state.leadSel];
  const allShownSelected = list.length > 0 && list.every((l) => state.leadSel.has(l.id));
  const manual = sel.filter((id) => !state.leads.find((l) => l.id === id)?.place_id).length;
  const selBar = !sel.length ? "" : state.moveConfirm ? `
    <div class="sel-bar warn">
      <span>Move ${sel.length} lead${sel.length === 1 ? "" : "s"} back to Find leads? ${sel.length === 1 ? "It leaves" : "They leave"} your tracker and call history is deleted.${manual ? ` ${manual} added by hand ${manual === 1 ? "isn't" : "aren't"} from a search, so ${manual === 1 ? "it is" : "they are"} just deleted.` : ""}</span>
      <span class="sel-actions"><button class="btn small danger" data-move-yes>Move back</button><button class="btn small ghost" data-move-no>Cancel</button></span>
    </div>` : `
    <div class="sel-bar">
      <span><b>${sel.length}</b> selected</span>
      <span class="sel-actions">${sel.every((id) => state.leads.find((l) => l.id === id)?.later)
        ? `<button class="btn small" data-later-bulk="0">Move back to active</button>`
        : `<button class="btn small" data-later-bulk="1">Save for later</button>`}<button class="btn small primary" data-audit-bulk>Run audit</button><button class="btn small" data-move-back>Move back to Find leads</button><button class="btn small ghost" data-sel-clear>Clear</button></span>
    </div>`;

  const active = list.filter((l) => !l.later);
  const saved = list.filter((l) => l.later);
  list = [...active, ...saved];
  state.shownLeadIds = list.map((l) => l.id);
  main.innerHTML = `
    <div class="page-head"><div><h1>Leads</h1><p>${state.leads.length} business${state.leads.length === 1 ? "" : "es"} in your tracker.</p></div>
      <button class="btn primary" data-new>Add lead</button></div>
    <section class="card table-card">
    <div class="card-head"><h2>${f.status === "open" ? "Open leads" : f.status === "all" ? "All leads" : esc(STATUS[f.status])}<span class="count">${list.length}</span></h2>
    <div class="toolbar">
      <input class="input search" id="lead-search" type="search" placeholder="Search name, phone, city…" value="${esc(f.q)}" aria-label="Search leads">
      <select class="input" id="lead-status" aria-label="Status">
        <option value="open">All open</option><option value="all">All, including won and lost</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select>
      <select class="input" id="lead-flag" aria-label="Website flag">
        <option value="all">Any website</option>
        ${Object.entries(FLAG).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select>
    </div></div>
    ${selBar}
    ${list.length ? `
    <div class="table-wrap"><table class="leads">
      <thead><tr><th class="sel-cell"><input type="checkbox" class="pick" data-lsel-all ${allShownSelected ? "checked" : ""} aria-label="Select all shown"></th>${th("business", "Business")}${th("site_flag", "Website")}<th class="hide-phone">Phone</th>${th("city", "City", "hide-phone")}${th("status", "Status")}${th("next_follow_up", "Follow-up")}</tr></thead>
      <tbody>${list.map((l, i) => `${l.later && (i === 0 || !list[i - 1].later) ? `<tr class="later-head"><td colspan="7"><span>Saved for later</span><b>${saved.length}</b><small>Not in your Call list or Today until you move them back.</small></td></tr>` : ""}<tr data-open="${esc(l.id)}" tabindex="0" class="${state.leadSel.has(l.id) ? "selected" : ""} ${l.later ? "later" : ""} ${auditOf(l.id)?.latest?.status === "running" ? "auditing" : ""}">
        <td class="sel-cell"><input type="checkbox" class="pick" data-lsel="${esc(l.id)}" id="lsel-${esc(l.id)}" ${state.leadSel.has(l.id) ? "checked" : ""} aria-label="Select ${esc(l.business)}"></td>
        <td><span class="name">${esc(l.business)}</span>${l.category ? `<br><span class="cat">${esc(l.category)}</span>` : ""}</td>
        <td><span class="site-cell">${flagChip(l.site_flag)}${auditMini(l.id)}</span></td>
        <td class="hide-phone phone">${esc(l.phone || "")}</td>
        <td class="hide-phone">${esc(l.city || "")}</td>
        <td>${statusChip(l.status)}</td>
        <td>${dueChip(l.next_follow_up)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">${state.leads.length ? "No leads match these filters." : "<b>No leads yet.</b> Add your first one with <b>Add lead</b>."}</div>`}
    </section>`;

  $("#lead-status").value = f.status;
  $("#lead-flag").value = f.flag;
  const search = $("#lead-search");
  if (hadFocus) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
  search.addEventListener("input", () => { f.q = search.value; renderLeads(); });
  $("#lead-status").addEventListener("change", (e) => { f.status = e.target.value; renderLeads(); });
  $("#lead-flag").addEventListener("change", (e) => { f.flag = e.target.value; renderLeads(); });
}

const find = {
  category: "", city: "", loading: false, error: "", data: null, selected: new Set(), showTracked: false, checking: 0,
};
try {
  const saved = JSON.parse(localStorage.getItem("efenefe-last-search") || "null");
  if (saved) Object.assign(find, { category: saved.query.category, city: saved.query.city, data: saved });
  else find.city = localStorage.getItem("efenefe-city") || "";
} catch {}

function saveSearch() {
  try { localStorage.setItem("efenefe-last-search", JSON.stringify(find.data)); } catch {}
}

function renderFind() {
  main.innerHTML = `
    <div class="page-head"><div><h1>Find leads</h1><p>Search Google by business category and city. Weak websites come first.</p></div></div>
    <section class="card search-card">
    <form class="search-form" id="find-form" novalidate>
      <label class="field">Category<input class="input" id="find-category" name="category" placeholder="Dentists" value="${esc(find.category)}" autocomplete="off"></label>
      <label class="field">City<input class="input" id="find-city" name="city" placeholder="Mississauga" value="${esc(find.city)}"></label>
      <button class="btn primary" type="submit" ${find.loading ? "disabled" : ""}>${find.loading ? "Searching…" : "Search"}</button>
    </form>
    <p class="hint">Each search uses up to 3 of your 1,000 free Google requests a month and returns up to 60 businesses.</p>
    </section>
    <div id="find-results"></div>`;
  $("#find-form").addEventListener("submit", runSearch);
  renderFindResults();
}

function renderFindResults() {
  const box = $("#find-results");
  if (!box) return;
  if (find.error) {
    box.innerHTML = `<div class="empty"><b>Search failed.</b> ${esc(find.error)}</div>`;
    return;
  }
  if (find.loading) {
    box.innerHTML = `<div class="empty">Searching Google for ${esc(find.category)} in ${esc(find.city)}…</div>`;
    return;
  }
  if (!find.data) {
    box.innerHTML = `<div class="card soon"><h2>How results are flagged</h2>
      <p>Each business gets one flag, so you know who needs a website most.</p>
      <div class="legend">${flagChip("weak")}${flagChip("none")}${flagChip("social")}${flagChip("good")}</div></div>`;
    return;
  }

  const all = find.data.results;
  const tracked = all.filter((r) => r.in_tracker).length;
  const list = all.filter((r) => find.showTracked || !r.in_tracker);
  const groups = [
    ["Weak website", list.filter((r) => r.site_flag === "weak")],
    ["No website", list.filter((r) => r.site_flag === "none" || r.site_flag === "social")],
    ["Checking website", list.filter((r) => r.site_flag === "unknown")],
    ["Good website", list.filter((r) => r.site_flag === "good")],
  ].filter(([, g]) => g.length);
  const selectable = list.filter((r) => !r.in_tracker);
  const sel = [...find.selected].filter((id) => selectable.some((r) => r.place_id === id));

  const row = (r) => `
    <li class="result ${r.in_tracker ? "tracked" : ""}">
      <input type="checkbox" class="pick" data-pick="${esc(r.place_id)}" id="pick-${esc(r.place_id)}" ${find.selected.has(r.place_id) ? "checked" : ""} ${r.in_tracker ? "disabled" : ""} aria-label="Select ${esc(r.business)}">
      <div class="result-main">
        <div class="result-name">${esc(r.business)}${r.temporarily_closed ? ` <span class="status">Temporarily closed</span>` : ""}</div>
        <div class="result-sub">${esc(r.address || r.city || "")}</div>
        <div class="result-site">
          ${r.site_flag === "unknown" ? `<span class="flag unknown">Checking…</span>` : flagChip(r.site_flag)}
          ${r.website ? `<a href="${esc(webHref(r.website))}" target="_blank" rel="noopener">${esc(prettyUrl(r.website))}</a>` : ""}
          ${r.site_issues?.length && r.site_flag === "weak" ? `<span class="issues">${r.site_issues.map((i) => `<span>${esc(i)}</span>`).join("")}</span>` : ""}
        </div>
      </div>
      <div class="result-phone phone">${r.phone ? esc(r.phone) : `<span class="muted">No phone</span>`}</div>
      <div class="result-act">${r.in_tracker ? `<span class="status">In tracker</span>` : `<button class="btn small" data-add="${esc(r.place_id)}">Add</button>`}</div>
    </li>`;

  box.innerHTML = `
    <div class="results-bar">
      <span><b>${all.length}</b> found for ${esc(find.data.query.category)} in ${esc(find.data.query.city)}${find.checking ? ` · checking ${find.checking} website${find.checking === 1 ? "" : "s"}…` : ""}</span>
      <span class="results-actions">
        ${tracked ? `<label class="check"><input type="checkbox" id="show-tracked" ${find.showTracked ? "checked" : ""}> Show ${tracked} already in tracker</label>` : ""}
        <button class="btn small" data-select-all>${sel.length === selectable.length && selectable.length ? "Clear selection" : "Select all"}</button>
        <button class="btn primary small" data-add-selected ${sel.length ? "" : "disabled"}>Add selected${sel.length ? ` (${sel.length})` : ""}</button>
      </span>
    </div>
    ${groups.length ? groups.map(([title, g]) => `
      <section class="section">
        <div class="section-head"><h2>${title}</h2><span class="count">${g.length}</span></div>
        <ul class="rows results">${g.map(row).join("")}</ul>
      </section>`).join("") : `<div class="empty">Every business from this search is already in your tracker.</div>`}`;

  const st = $("#show-tracked");
  if (st) st.addEventListener("change", () => { find.showTracked = st.checked; renderFindResults(); });
}

async function runSearch(e) {
  e.preventDefault();
  find.category = $("#find-category").value.trim();
  find.city = $("#find-city").value.trim();
  if (!find.category || !find.city) return toast("Enter a category and a city.", true);
  try { localStorage.setItem("efenefe-city", find.city); } catch {}
  find.loading = true;
  find.error = "";
  find.selected.clear();
  renderFind();
  try {
    find.data = await api("POST", "search", { category: find.category, city: find.city });
    saveSearch();
  } catch (err) {
    find.error = err.message;
  }
  find.loading = false;
  renderFind();
  if (find.data && !find.error) checkSites(find.data);
}

async function checkSites(data) {
  const queue = data.results.filter((r) => r.site_flag === "unknown" && r.website);
  find.checking = queue.length;
  renderFindResults();
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const res = await api("POST", "check-site", { url: r.website });
        r.site_flag = res.site_flag;
        r.site_issues = res.site_issues;
      } catch {
        r.site_flag = "weak";
        r.site_issues = ["Couldn't check site"];
      }
      if (find.data !== data) return;
      find.checking--;
      saveSearch();
      if (state.view === "find") renderFindResults();
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
}

async function addResults(ids) {
  const items = find.data.results.filter((r) => ids.includes(r.place_id) && !r.in_tracker);
  let added = 0;
  for (const r of items) {
    try {
      const { lead } = await api("POST", "leads", {
        business: r.business, category: r.category, phone: r.phone, website: r.website, address: r.address,
        city: r.city, place_id: r.place_id, site_flag: r.site_flag, site_issues: r.site_issues,
        source: `search: ${find.data.query.category} in ${find.data.query.city}`, status: "to_call",
      });
      upsertLead(lead);
      added++;
      r.in_tracker = true;
    } catch (err) {
      if (/already/i.test(err.message)) r.in_tracker = true;
      else toast(err.message, true);
    }
    find.selected.delete(r.place_id);
  }
  saveSearch();
  render();
  if (added) toast(added === 1 ? `Added ${items[0].business} to your call list` : `Added ${added} leads to your call list`);
}

async function setLater(ids, on) {
  let n = 0;
  for (const id of ids) {
    try {
      const { lead } = await api("PATCH", `leads/${id}`, { later: on });
      upsertLead(lead);
      n++;
    } catch (err) {
      toast(err.message, true);
      break;
    }
  }
  render();
  if (n) toast(on ? `Saved ${n === 1 ? "1 lead" : `${n} leads`} for later` : `Moved ${n === 1 ? "1 lead" : `${n} leads`} back to active`);
}

async function moveBack(ids) {
  let moved = 0;
  for (const id of ids) {
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) continue;
    try {
      await api("DELETE", `leads/${id}`);
      state.leads = state.leads.filter((l) => l.id !== id);
      state.leadSel.delete(id);
      const r = find.data?.results.find((x) => x.place_id && x.place_id === lead.place_id);
      if (r) r.in_tracker = false;
      moved++;
    } catch (err) {
      toast(err.message, true);
      break;
    }
  }
  state.moveConfirm = false;
  saveSearch();
  render();
  if (moved) toast(`Moved ${moved} lead${moved === 1 ? "" : "s"} back. ${moved === 1 ? "It shows" : "They show"} in Find leads again.`);
}

// ---------- panel ----------

function openPanel(id) {
  state.panel = { id };
  const lead = id ? state.leads.find((l) => l.id === id) : null;
  if (id && !lead) return closePanel();
  const p = $("#panel");
  const v = (k) => esc(lead?.[k] ?? "");
  p.innerHTML = `
    <div class="panel-head">
      <h2>${lead ? esc(lead.business) : "Add lead"}</h2>
      <button class="btn ghost small" data-close aria-label="Close">Close</button>
    </div>
    <div class="panel-body">
      ${lead?.later ? `<div class="saved-note">Saved for later. It stays out of your Call list and Today until you move it back.</div>` : ""}
      ${lead && lead.phone ? `<div class="dial"><a class="phone-big" href="${esc(telHref(lead.phone))}">${esc(lead.phone)}</a><button class="btn small" data-copy="${esc(lead.phone)}">Copy</button></div>` : ""}
      ${lead ? `<section class="card" id="report-box">${reportBox(lead.id)}</section>` : ""}
      <form class="form" id="lead-form" novalidate>
        <label class="field">Business name *<input class="input" name="business" id="f-business" required value="${v("business")}"></label>
        <div class="grid-2">
          <label class="field">Category<input class="input" name="category" id="f-category" placeholder="Dentist" value="${v("category")}"></label>
          <label class="field">Contact name<input class="input" name="contact" id="f-contact" value="${v("contact")}"></label>
          <label class="field">Phone<input class="input" name="phone" id="f-phone" type="tel" value="${v("phone")}"></label>
          <label class="field">Email<input class="input" name="email" id="f-email" type="email" value="${v("email")}"></label>
        </div>
        <label class="field">Website<input class="input" name="website" id="f-website" placeholder="example.com" value="${v("website")}"></label>
        <div class="grid-2">
          <label class="field">Website flag<select class="input" name="site_flag" id="f-site_flag">
            ${["weak", "none", "social", "good", "unknown"].map((k) => `<option value="${k}" ${(lead?.site_flag ?? "none") === k ? "selected" : ""}>${FLAG[k]}</option>`).join("")}
          </select></label>
          <label class="field">Site issues<input class="input" name="site_issues" id="f-site_issues" placeholder="No HTTPS, not mobile friendly" value="${esc((lead?.site_issues || []).join(", "))}"></label>
        </div>
        <div class="grid-2">
          <label class="field">Address<input class="input" name="address" id="f-address" value="${v("address")}"></label>
          <label class="field">City<input class="input" name="city" id="f-city" value="${v("city")}"></label>
          <label class="field">Status<select class="input" name="status" id="f-status">
            ${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${(lead?.status ?? "to_call") === k ? "selected" : ""}>${s}</option>`).join("")}
          </select></label>
          <label class="field">Next follow-up<input class="input" type="date" name="next_follow_up" id="f-next" value="${v("next_follow_up")}"></label>
        </div>
        <label class="field">Notes<textarea class="input" name="notes" id="f-notes">${v("notes")}</textarea></label>
        <div class="form-actions">
          <span>${lead ? `<button type="button" class="btn ghost small" data-later-one="${esc(lead.id)}" data-on="${lead.later ? 0 : 1}">${lead.later ? "Move back to active" : "Save for later"}</button>${lead.place_id ? `<button type="button" class="btn ghost small" data-move-one="${esc(lead.id)}">Move back to Find leads</button>` : ""}<button type="button" class="btn ghost danger small" data-delete>Delete lead</button>` : ""}</span>
          <button type="submit" class="btn primary">${lead ? "Save changes" : "Add lead"}</button>
        </div>
      </form>
      ${lead ? `<div class="card">${logForm(lead, { next: false })}</div>
      <section class="card"><h3 class="history-title">Call history</h3><div data-history="${esc(lead.id)}"><span class="muted">Loading…</span></div></section>
      <p class="added">Added ${esc(when(lead.created_at).date)}${lead.source && lead.source !== "manual" ? ` from ${esc(lead.source)}` : ""}.</p>` : ""}
    </div>`;
  p.hidden = false;
  $("#scrim").hidden = false;
  document.body.style.overflow = "hidden";

  const form = $("#lead-form");
  const websiteInput = $("#f-website");
  if (!lead) {
    // Suggest a flag from the website field for new leads.
    websiteInput.addEventListener("input", () => {
      const flag = $("#f-site_flag");
      if (!websiteInput.value.trim()) flag.value = "none";
      else if (/facebook\.|instagram\.|linktr\.ee|tiktok\./i.test(websiteInput.value)) flag.value = "social";
      else if (flag.value === "none" || flag.value === "social") flag.value = "unknown";
    });
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.business.trim()) return toast("Business name is required.", true);
    data.site_issues = data.site_issues.split(",").map((s) => s.trim()).filter(Boolean);
    data.next_follow_up = data.next_follow_up || null;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const { lead: saved } = lead ? await api("PATCH", `leads/${lead.id}`, data) : await api("POST", "leads", data);
      upsertLead(saved);
      toast(lead ? "Saved" : "Lead added");
      render();
      openPanel(saved.id);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  if (lead) bindLogForm(p, lead, { next: false });
  (lead ? p.querySelector("[data-close]") : $("#f-business")).focus();
}

function closePanel() {
  state.panel = null;
  $("#panel").hidden = true;
  $("#panel").innerHTML = "";
  $("#scrim").hidden = true;
  document.body.style.overflow = "";
}

// ---------- global events ----------

document.addEventListener("click", async (e) => {
  const t = e.target;
  const lsel = t.closest("[data-lsel]");
  if (lsel) {
    if (lsel.checked) state.leadSel.add(lsel.dataset.lsel);
    else state.leadSel.delete(lsel.dataset.lsel);
    state.moveConfirm = false;
    return renderLeads();
  }
  const lall = t.closest("[data-lsel-all]");
  if (lall) {
    for (const id of state.shownLeadIds || []) lall.checked ? state.leadSel.add(id) : state.leadSel.delete(id);
    state.moveConfirm = false;
    return renderLeads();
  }
  if (t.closest(".sel-cell")) return; // clicks around the checkbox don't open the lead
  if (t.closest("[data-audit-bulk]")) {
    t.closest("[data-audit-bulk]").disabled = true;
    return runAudits([...state.leadSel], { bulk: true });
  }
  const ao = t.closest("[data-audit-one]");
  if (ao) {
    ao.disabled = true;
    return runAudits([ao.dataset.auditOne]);
  }
  const lb = t.closest("[data-later-bulk]");
  if (lb) {
    lb.disabled = true;
    return setLater([...state.leadSel], lb.dataset.laterBulk === "1");
  }
  const lo = t.closest("[data-later-one]");
  if (lo) {
    lo.disabled = true;
    await setLater([lo.dataset.laterOne], lo.dataset.on === "1");
    if (state.panel) openPanel(state.panel.id);
    return;
  }
  if (t.closest("[data-sel-clear]")) { state.leadSel.clear(); state.moveConfirm = false; return renderLeads(); }
  if (t.closest("[data-move-back]")) { state.moveConfirm = true; return renderLeads(); }
  if (t.closest("[data-move-no]")) { state.moveConfirm = false; return renderLeads(); }
  if (t.closest("[data-move-yes]")) { t.closest("[data-move-yes]").disabled = true; return moveBack([...state.leadSel]); }
  const one = t.closest("[data-move-one]");
  if (one) {
    one.disabled = true;
    closePanel();
    return moveBack([one.dataset.moveOne]);
  }
  const open = t.closest("[data-open]");
  if (open) return openPanel(open.dataset.open);
  if (t.closest("[data-new]")) return openPanel(null);
  if (t.closest("[data-close]") || t.id === "scrim") return closePanel();

  const ci = t.closest("[data-call-index]");
  if (ci) {
    state.callIndex = Number(ci.dataset.callIndex);
    state.callFocus = true;
    renderCalls();
    if (matchMedia("(max-width: 820px)").matches) window.scrollTo(0, 0);
    return;
  }
  if (t.closest("[data-unfocus]")) {
    state.callFocus = false;
    return renderCalls();
  }

  const copy = t.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast("Number copied");
    } catch {
      toast("Couldn't copy. Select the number instead.", true);
    }
    return;
  }

  const pick = t.closest("[data-pick]");
  if (pick) {
    if (pick.checked) find.selected.add(pick.dataset.pick);
    else find.selected.delete(pick.dataset.pick);
    return renderFindResults();
  }
  if (t.closest("[data-select-all]")) {
    const selectable = find.data.results.filter((r) => !r.in_tracker && (find.showTracked || !r.in_tracker)).map((r) => r.place_id);
    const all = selectable.every((id) => find.selected.has(id));
    find.selected = all ? new Set() : new Set(selectable);
    return renderFindResults();
  }
  const add = t.closest("[data-add]");
  if (add) {
    add.disabled = true;
    return addResults([add.dataset.add]);
  }
  const addSel = t.closest("[data-add-selected]");
  if (addSel) {
    addSel.disabled = true;
    return addResults([...find.selected]);
  }

  const sort = t.closest("[data-sort]");
  if (sort) {
    const f = state.leadsFilter;
    if (f.sort === sort.dataset.sort) f.dir = f.dir === "asc" ? "desc" : "asc";
    else { f.sort = sort.dataset.sort; f.dir = "asc"; }
    return renderLeads();
  }

  const pipe = t.closest("a[data-status]");
  if (pipe) {
    state.leadsFilter.status = pipe.dataset.status;
    state.leadsFilter.flag = "all";
    state.leadsFilter.q = "";
  }

  const del = t.closest("[data-delete]");
  if (del) {
    const actions = del.parentElement;
    actions.innerHTML = `<span class="confirm">Delete this lead and its call history?
      <button type="button" class="btn small danger" data-delete-yes>Delete</button>
      <button type="button" class="btn small ghost" data-delete-no>Keep</button></span>`;
    return;
  }
  if (t.closest("[data-delete-no]")) return openPanel(state.panel.id);
  if (t.closest("[data-delete-yes]")) {
    const id = state.panel.id;
    try {
      await api("DELETE", `leads/${id}`);
      state.leads = state.leads.filter((l) => l.id !== id);
      closePanel();
      render();
      toast("Lead deleted");
    } catch (err) {
      toast(err.message, true);
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.panel) closePanel();
  if (e.key === "Enter" && e.target.matches("[data-open], [data-call-index]")) e.target.click();
});

window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
const onScroll = () => document.body.classList.toggle("scrolled", window.scrollY > 4);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

async function boot() {
  try {
    const [{ leads }, me] = await Promise.all([api("GET", "leads"), api("GET", "me").catch(() => ({}))]);
    state.leads = leads;
    state.me = me.email || "";
    const av = $("#me");
    av.title = state.me ? `Signed in as ${state.me}` : "";
    setView(location.hash.slice(1) || "today");
    loadReports();
  } catch (err) {
    main.innerHTML = `<div class="empty"><b>Couldn't load your leads.</b> ${esc(err.message)}</div>`;
  }
}
boot();
