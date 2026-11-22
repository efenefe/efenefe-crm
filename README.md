# efenefe CRM

A private call tracker for efenefe: log businesses you call, record each call, and see which follow-ups are due today.

Runs on Cloudflare: one Worker serves the screens and the API, D1 stores the data, and Cloudflare Access handles login.

## Screens

- **Today**: overdue follow-ups, due today, next 7 days, and a count of leads per status.
- **Call list**: follow-ups due, then new leads (weak websites first). Log the outcome, note, status and next follow-up, then move to the next lead.
- **Leads**: every lead, with search, filters and sorting.
- **Find leads**: Google search by category and city (Phase 2, needs a Google Places API key).

## First-time setup (Cloudflare dashboard)

1. **Deploy.** Workers & Pages > Create > Import a repository > pick `efenefe/efenefe-crm` > keep the defaults > Deploy. The first deploy also creates the `efenefe-crm` D1 database.
2. **Turn on login.** Open the `efenefe-crm` Worker > Settings > Domains & Routes > `workers.dev` > Enable Cloudflare Access. Then Manage Cloudflare Access, and make sure the policy allows only your email.
3. **Tell the app about the login.** Two values, neither is secret:
   - Team domain: Zero Trust > Settings > Custom Pages (or Team name), like `yourteam.cloudflareaccess.com`.
   - Audience tag: Zero Trust > Access > Applications > `efenefe-crm` > Overview > Application Audience (AUD) Tag.

   Put them in `wrangler.jsonc` under `vars` and push. Until both are set, the app refuses every request, so your data is never exposed.

## Local development

```sh
npm install
printf 'DEV_ALLOW_NO_AUTH=true\n' > .dev.vars   # skips login locally only
npm run dev
```
