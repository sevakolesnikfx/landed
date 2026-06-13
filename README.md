# Landed

**Know what you're owed.** A mobile prototype that helps UK newcomers find the support, grants and benefits they're actually eligible for — in their own words, with no jargon or 40-page forms.

A single self-contained `index.html` (no build step) demonstrating the concept.

## Features

- **Login screen** — branded entry with log in / sign up, social buttons, and guest access.
- **Benefits logic engine** — a client-side rules engine (`PROFILE` + `BENEFITS` + `evaluate()`) that scores each UK scheme as *eligible*, *document-locked*, or *blocked by visa* (e.g. "No Recourse to Public Funds").
- **Benefit Quest** — a Candy-Crush-style level map generated from the engine, with a winnings "pot" tally, stars, and a claim flow. Background art generated with Higgsfield.
- **"Tell us your story" chat agent** — describe your situation in plain English; the agent extracts facts (visa, income, children, region, docs…), updates the profile, and recalculates your matches live. Structured so a real LLM can be dropped in.
- **Lucide icons** throughout.

## Run locally

It's a static file — open `index.html`, or serve it:

```bash
npx http-server -p 8000
# then visit http://localhost:8000
```

Demo login is prefilled (`amara@email.com` / `demo1234`) — or tap **Continue as guest**.

> Prototype / demo. Benefit data and success rates are illustrative.
