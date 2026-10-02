# Realty Crew

Persistent Claude agents for Kara Lawrence, REALTOR® at Virani Real Estate Advisors. An office manager routes requests to specialists. Each specialist keeps a memory between tasks, reads a shared reference library, and delivers files you download from the task.

A web UI shows the org chart, the task board, live transcripts, files, and approvals. Hosted at **https://realtytorealty.com** behind a password.

It's a fork of `ghg-crew` with GitHub, Jira, git worktrees, the game agents and Gemini art removed. Real estate agents, the library, Canva, and a virani.ca-grounded assistant were added.

## The crew

| Agent | Role | Delivers |
|---|---|---|
| **Juniper** | Office Manager | Routes each request to the right specialists, in order |
| **Sage** | Brokerage Guide (chat) | Answers about the team, listings, buildings, blog and voice, grounded in a daily text snapshot of virani.ca; drafts tasks |
| **Harper** | Listing Specialist | MLS® public and REALTOR® remarks, feature lists, open house copy |
| **Atlas** | Comparables & Market Analyst | CMA narrative plus a comps/adjustments CSV, from MLS® exports you attach |
| **Quinn** | Brochure & Print Designer | Feature sheets, brochures and postcards in Canva, plus print PDFs |
| **Ivy** | Magazine Editor | Flat plan, schedule back from the printer deadline, articles, market update |
| **Mercer** | Magazine Production | Canva layout, print-ready PDF, printer handoff and email draft |
| **Sterling** | Legal Information (not legal advice) | Plain-language explainers and clause drafts with sources; disclaimer always on |
| **Reid** | Residential Tenancy (RTB) | Notices, rent increases, deposits, disputes: timelines, checklists, draft letters; disclaimer always on |
| **Rowan** | Rental Property Manager | Vacancy ads, screening, RTB-1 setup, maintenance log, rent roll, owner statements |
| **Nova** | Social & Marketing Writer | Social posts, newsletters, blog drafts, simple Canva tiles |
| **Tess** | Transaction Coordinator | Deal sheet with every date, document checklist, conveyancing handoff, client update emails |
| **Vera** | Compliance Reviewer | BCFSA advertising, Human Rights Code, CASL and privacy review with fixes |

Roster files are `agents/*.md`: frontmatter for name, team, model, budgets, skills and `canva: true`; the body holds instructions. Edits apply on the next run, and you can add an agent from **+ Agent** in the UI. Memory is in `memory/<agent>.md`, editable in each agent's panel.

Every agent shares the ground rules in `server/runner.ts` (`GROUND_RULES`):
- BC context: BCFSA/RESA, RTB, the Strata Property Act.
- Never invent facts; unknowns become `[CONFIRM: ...]`.
- Cite rules with dates.
- Never contact anyone. Agents draft; the realtor sends.

## Library

`library/` is the reference shelf every agent reads before working. Each folder's README says what belongs there:
- brand
- listings
- market-data
- magazine (with `printer/`)
- legal
- tenancy
- rentals
- compliance
- transactions
- templates
- inbox

Add files from the **Library** button: drag them onto a folder. Only the READMEs are in git; the contents are private and live on the server.

`library/website/` is a text snapshot of virani.ca: team, properties, buildings, neighbourhoods, blog and testimonials. It's built from the Yoast sitemap and refreshed daily. Only changed pages are fetched, and repeated site chrome is stripped. Sage and the agents grep it for facts and voice. **Refresh now** in the Library panel forces an update.

## Files

Every task has a folder (`data/outputs/<task>/`):
- Files you attach when creating a task land there.
- The agent works there, and its deliverables appear under **Files** in the task panel, ready to open or download.
- When the manager assigns work, the parent task's attachments are copied to each subtask.

## Connectors: Canva, Google Drive, Google Calendar

Agents use the claude.ai connectors on Kara's Claude account, the one the server is logged in with. Connect them in claude.ai → Settings → Connectors. Each agent's access is set by `canva:`, `drive:` and `calendar:` in its file, or with the toggles in its panel.

| Connector | Who | Runs freely | Waits for Kara's Allow |
|---|---|---|---|
| Canva | Quinn, Mercer, Nova | search, read, create, autofill, export | share, comment, move, delete |
| Google Drive | Sage (read only), every specialist | search, read, create new Docs/Sheets, copy | edit an existing file, share, trash |
| Google Calendar | Sage (read only), Tess, Rowan, Reid, Ivy, Mercer | read events, find free time | create, change, delete events (attendees may be notified) |

Agents propose calendar events and only add them when the task asks; they never invite people unless told to. Every other connector on the account (Gmail, Jira, Claude Docs…) is blocked in `server/policy.ts`.

## Plan usage

The meter at the top left shows how much of the Claude plan is left: the 5-hour window and the week, with reset times.
- It's checked every 5 minutes and after every run, and updated live from agents' rate-limit events. Click it to check now.
- It turns red when a limit is hit.
- It uses the Agent SDK's experimental usage call (`server/usage.ts`). If a future SDK changes that call, the meter hides itself; the rest of the app is unaffected.

## REW and MLS®

- **REW:** there's no plugin, and REW.ca has no public API.
- **MLS®:** there's no plugin either. Until a data feed is set up, Atlas works from MLS® exports (CSV/PDF from the board system) attached to a task or saved in `library/market-data/`.
- **Possible later:** CREA's **DDF®** (the realtor.ca data feed), which a member can request, or the board's IDX/VOW feed through the brokerage. Either could become a tool for Atlas and Harper.

## Run locally

```bash
cd ~/Projects/personal/realty-crew
PATH=/usr/local/bin:$PATH npm install
PATH=/usr/local/bin:$PATH npm start      # http://localhost:4477
```

Locally, agents use your Claude Code login and there's no password unless `CREW_PASSWORD` is set. `npm run check` typechecks.

## Deploy (droplet 178.128.66.164)

Runs in Docker on the `caddy-proxy` network. `agents/`, `skills/`, `memory/`, `library/` and `data/` are bind-mounted from the checkout, so UI edits survive rebuilds. The Claude login lives in the `claude-home` volume.

First time:
```bash
ssh root@178.128.66.164
git clone <repo-url> ~/realty-crew && cd ~/realty-crew
cp .env.example .env && nano .env          # CREW_OWNER, CREW_PASSWORD (long, random)
mkdir -p data && chown -R 1000:1000 agents skills memory library data   # the container runs as uid 1000
docker compose up -d --build
docker compose exec -it realty-crew claude  # then /login with Kara's Claude account; /exit when done
docker compose restart realty-crew
```
Then:
- **Cloudflare DNS:** `realtytorealty.com` and `www` A records → `178.128.66.164`, **DNS only** (grey cloud).
- **Caddy:** pull caddy-proxy on the droplet, then reload with `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

Updates: `cd ~/realty-crew && git pull && docker compose up -d --build`. `~/caddy-proxy/deploy.sh` includes it.

Resources: each running agent is a Claude Code process, a few hundred MB. At most 2 agents run at once (`MAX_CONCURRENT` in `server/config.ts`). The droplet has 2 GB of RAM for everything; the container gets 1.2 GB plus swap. If agents feel slow or restart, resize the droplet to 4 GB rather than raising the limit.

## Layout

```
agents/      roster (one markdown file per agent)
memory/      each agent's notes
skills/      skill library (listing-copy, cma-report, bcfsa-advertising, print-production, magazine-issue, legal-disclaimer)
library/     reference shelf (READMEs in git, contents on the server)
server/      Node 25 TypeScript, run directly (no build)
  runner.ts    one agent run: prompt, tools, transcript, outcome
  policy.ts    what runs freely, what asks, what's blocked
  assistant.ts Sage
  site.ts      virani.ca snapshot
  files.ts     library and task files
  auth.ts      password login
  index.ts     HTTP API + SSE + static UI
ui/          Preact + htm, no build step
```
