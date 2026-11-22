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
    .filter((l) => l.next_follow_up && l.next_follow_up <= t && !CLOSED.has(l.status))
    .sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up) || FLAG_RANK[a.site_flag] - FLAG_RANK[b.site_flag]);
}
function newToCall() {
  const t = today();
  return state.leads
    .filter((l) => l.status === "to_call" && !(l.next_follow_up && l.next_follow_up <= t))
    .sort((a, b) => (FLAG_RANK[a.site_flag] ?? 2) - (FLAG_RANK[b.site_flag] ?? 2) || a.created_at.localeCompare(b.created_at));
}
function callQueue() {
  return [...followUpsDue(), ...newToCall()];
}

// ---------- views ----------

function setView(view) {
  state.view = ["today", "calls", "leads", "find"].includes(view) ? view : "today";
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  render();
}

function render() {
  const n = callQueue().length;
  const badge = $("#calls-count");
  badge.hidden = n === 0;
  badge.textContent = n;
  ({ today: renderToday, calls: renderCalls, leads: renderLeads, find: renderFind })[state.view]();
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

function statTile({ href, status, icon, accent, label, num, foot, spark = "" }) {
  return `<a class="card stat" href="${href}" ${status ? `data-status="${status}"` : ""}>
    <div class="stat-top"><span class="badge ${accent ? "accent" : ""}">${ICON[icon]}</span><span class="stat-label">${label}</span></div>
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
  const open = state.leads.filter((l) => !CLOSED.has(l.status) && l.next_follow_up);
  const overdue = open.filter((l) => l.next_follow_up < t).sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
  const due = open.filter((l) => l.next_follow_up === t);
  const soon = open.filter((l) => l.next_follow_up > t && l.next_follow_up <= in7).sort((a, b) => a.next_follow_up.localeCompare(b.next_follow_up));
  const toCall = newToCall();
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
        ? `<div class="empty"><b>No leads yet.</b> Search Google with <a href="#find">Find leads</a>, or add one with the + button.</div>`
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
      <div class="meta">${flagChip(next.site_flag)}</div>
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
      <ul class="bars">${counts.map(([s, n]) => `<li><a href="#leads" data-status="${s}" class="${n ? "" : "zero"}"><span>${STATUS[s]}</span><span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span><b>${n}</b></a></li>`).join("")}</ul>
    </section>`;

  const best = toCall.filter((l) => l.site_flag === "weak" || l.site_flag === "none" || l.site_flag === "social").slice(0, 5);
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
          ${statTile({ href: "#calls", icon: "bell", accent: dueCount > 0, label: "Follow-ups due", num: dueCount,
            foot: overdue.length ? `<span class="delta bad">${overdue.length} overdue</span>` : `<span class="delta">${soon.length} this week</span>` })}
          ${statTile({ href: "#calls", icon: "user", label: "New leads to call", num: toCall.length,
            foot: addedThisWeek ? `<span class="delta up">+${addedThisWeek}</span> added this week` : "None added this week" })}
          ${statTile({ href: "#leads", icon: "phone", label: "Calls this week", num: state.stats ? thisWeek : "–",
            foot: state.stats && !state.stats.failed ? `<span class="delta ${diff > 0 ? "up" : ""}">${diff > 0 ? "↑" : diff < 0 ? "↓" : ""}${diff ? Math.abs(diff) : "Same"}</span> vs last week` : "", spark: state.stats ? spark : "" })}
          ${statTile({ href: "#leads", status: "won", icon: "trophy", accent: won > 0, label: "Clients won", num: won,
            foot: warm ? `<span class="delta up">${warm} warm</span> interested or proposal` : "No warm leads yet" })}
        </div>
        ${followCard}
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
      <button class="btn small" data-open="${esc(l.id)}">Edit lead</button>
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
      <span class="sel-actions"><button class="btn small" data-move-back>Move back to Find leads</button><button class="btn small ghost" data-sel-clear>Clear</button></span>
    </div>`;

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
      <tbody>${list.map((l) => `<tr data-open="${esc(l.id)}" tabindex="0" ${state.leadSel.has(l.id) ? 'class="selected"' : ""}>
        <td class="sel-cell"><input type="checkbox" class="pick" data-lsel="${esc(l.id)}" id="lsel-${esc(l.id)}" ${state.leadSel.has(l.id) ? "checked" : ""} aria-label="Select ${esc(l.business)}"></td>
        <td><span class="name">${esc(l.business)}</span>${l.category ? `<br><span class="cat">${esc(l.category)}</span>` : ""}</td>
        <td>${flagChip(l.site_flag)}</td>
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
      ${lead && lead.phone ? `<div class="dial"><a class="phone-big" href="${esc(telHref(lead.phone))}">${esc(lead.phone)}</a><button class="btn small" data-copy="${esc(lead.phone)}">Copy</button></div>` : ""}
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
          <span>${lead ? `${lead.place_id ? `<button type="button" class="btn ghost small" data-move-one="${esc(lead.id)}">Move back to Find leads</button>` : ""}<button type="button" class="btn ghost danger small" data-delete>Delete lead</button>` : ""}</span>
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
const topBar = $(".top");
const onScroll = () => topBar.classList.toggle("scrolled", window.scrollY > 4);
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
  } catch (err) {
    main.innerHTML = `<div class="empty"><b>Couldn't load your leads.</b> ${esc(err.message)}</div>`;
  }
}
boot();
