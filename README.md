# efenefe CRM

A private call tracker for efenefe: log businesses you call, record each call, and see which follow-ups are due today.

Runs on Cloudflare: one Worker serves the screens and the API, D1 stores the data, and Cloudflare Access handles login.

## Screens

- **Today**: a dashboard with follow-ups due, new leads to call, calls this week and clients won, plus the next call, the pipeline and your best prospects.
- **Call list**: follow-ups due, then new leads (weak websites first). Log the outcome, note, status and next follow-up, then move to the next lead.
- **Leads**: every lead, with search, filters and sorting.
- **Find leads**: Google search by category and city. Each result's website is checked and flagged: weak website, no website, social page only, or good website.
- **Website reports**: select leads on the Leads screen and press **Run audit**. Audits run in the background (about 3 a minute, the tab can be closed). Each report has a score out of 100, a phone screenshot of the homepage and the 5 biggest issues with what they cost the business. Reports never say how to fix an issue.

## First-time setup (Cloudflare dashboard)

1. **Deploy.** Workers & Pages > Create > Import a repository > pick `efenefe/efenefe-crm` > keep the defaults > Deploy. The first deploy also creates the `efenefe-crm` D1 database.
2. **Turn on login.** Open the `efenefe-crm` Worker > Settings > Domains & Routes > `workers.dev` > Enable Cloudflare Access. Then Manage Cloudflare Access, and make sure the policy allows only your email.
3. **Tell the app about the login.** Two values, neither is secret:
   - Team domain: Zero Trust > Settings > Custom Pages (or Team name), like `yourteam.cloudflareaccess.com`.
   - Audience tag: Zero Trust > Access > Applications > `efenefe-crm` > Overview > Application Audience (AUD) Tag.

   Add both on the Worker under Settings > Variables and Secrets, as type **Text**, named `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Until both are set, the app refuses every request, so your data is never exposed.
4. **Turn on lead search.** In Google Cloud, enable Places API (New), create an API key restricted to that API (not to a website), and set a budget alert. Add it on the Worker under Settings > Variables and Secrets, as type **Secret**, named `GOOGLE_PLACES_API_KEY`.

5. **Turn on website reports.**
   - In the same Google Cloud project, enable **PageSpeed Insights API**. Either allow it on your existing key (APIs & Services > Credentials > your key > API restrictions), or create a second key and add it on the Worker as a **Secret** named `PAGESPEED_API_KEY`. Without that secret the Worker uses `GOOGLE_PLACES_API_KEY`. PageSpeed is free.
   - Create an account at console.anthropic.com, add credit, set a monthly spend limit, create an API key and add it on the Worker as a **Secret** named `ANTHROPIC_API_KEY`. Claude writes each issue's title and impact, about 4 cents a report. Without the key, reports use standard wording.
   - The audits run from a scheduled trigger every minute, set in `wrangler.jsonc`. Nothing to do in the dashboard.

## Local development

```sh
npm install
printf 'DEV_ALLOW_NO_AUTH=true\n' > .dev.vars   # skips login locally only
npm run dev
```

To run queued audits locally, start with `npx wrangler dev --test-scheduled` and open `http://localhost:8787/cdn-cgi/handler/scheduled`.
