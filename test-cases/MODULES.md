# JPL-Leagues — Test Case Module Index

This document indexes every module in the JPL-Leagues system that has a test-case
source file. Two specialist agents (`business-analyst` and `qa-tester`) iterate
on the JSON files in [sources/](sources/), and a build script compiles them into
a single Excel workbook.

## Orchestration workflow

```
1. Pick a module from the list below (or work top-to-bottom).
2. Invoke: "Use the business-analyst agent to draft requirements for <module>"
3. Review what BA wrote in test-cases/sources/<NN>-<module>.json
4. Invoke: "Use the qa-tester agent to write test cases for <module>"
5. If QA appended gapFlags entries, invoke BA again to address them.
6. Repeat 4–5 until QA sets status: "qa-signed-off".
7. Move to the next module.
8. When all 17 modules are signed off, run: npm run test-cases:build
9. Commit test-cases/sources/*.json AND test-cases/jpl-leagues-test-cases.xlsx
```

## Statuses

- `ba-drafting` — BA is still extracting requirements; QA should NOT start yet.
- `qa-writing` — BA has handed off; QA is filling test cases (or addressing gaps).
- `qa-signed-off` — QA has full coverage and no open `gapFlags`. Ready to ship.

## Module list

| # | Module | Source file | Sheet name | Status |
|---|---|---|---|---|
| 1 | Authentication & Session | [01-auth.json](sources/01-auth.json) | Auth | qa-writing (1 open gap) |
| 2 | League Setup (create, settings, season reset) | [02-league-setup.json](sources/02-league-setup.json) | League Setup | qa-writing (3 open gaps) |
| 3 | Team Management (admin CRUD, bulk upload) | [03-team-management.json](sources/03-team-management.json) | Team Mgmt | qa-signed-off |
| 4 | Team Self-Service (setup wizard, password) | [04-team-self-service.json](sources/04-team-self-service.json) | Team Self-Service | qa-signed-off |
| 5 | Gameweeks & Fixtures | [05-gameweeks-fixtures.json](sources/05-gameweeks-fixtures.json) | Gameweeks & Fixtures | qa-signed-off |
| 6 | Captains & Chips (TVT) | [06-captains-chips.json](sources/06-captains-chips.json) | Captains & Chips | qa-signed-off |
| 7 | Standings & Results | [07-standings-results.json](sources/07-standings-results.json) | Standings | qa-signed-off |
| 8 | TVT Playoffs (8/16/32 + Challenger Cup) | [08-tvt-playoffs.json](sources/08-tvt-playoffs.json) | TVT Playoffs | qa-signed-off |
| 9 | Triple Crown (cup groups, UCL/UEL/Europa) | [09-triple-crown.json](sources/09-triple-crown.json) | Triple Crown | qa-signed-off |
| 10 | Auction Core (sessions, bidding, wishlist) | [10-auction-core.json](sources/10-auction-core.json) | Auction Core | qa-signed-off |
| 11 | Auction Economy (purse, payouts, synergy) | [11-auction-economy.json](sources/11-auction-economy.json) | Auction Economy | qa-signed-off |
| 12 | Auction Marketplace (trades — Complete tier) | [12-auction-marketplace.json](sources/12-auction-marketplace.json) | Marketplace | qa-signed-off |
| 13 | Auction Slots & Club Auction | [13-auction-slots-club.json](sources/13-auction-slots-club.json) | Slots & Club | qa-signed-off |
| 14 | Backups & Restore | [14-backups-restore.json](sources/14-backups-restore.json) | Backups | qa-signed-off |
| 15 | Notifications | [15-notifications.json](sources/15-notifications.json) | Notifications | qa-signed-off |
| 16 | Superadmin (admin CRUD, PL standings) | [16-superadmin.json](sources/16-superadmin.json) | Superadmin | qa-signed-off |
| 17 | Public Pages (landing, rules, winners) | [17-public-pages.json](sources/17-public-pages.json) | Public Pages | qa-signed-off |

## Generated artifact

After running `npm run test-cases:build`:

- **[jpl-leagues-test-cases.xlsx](jpl-leagues-test-cases.xlsx)** — the consolidated workbook with Cover, TOC, Defects, **defect_details** (stakeholder-facing plain-English summaries), Traceability Matrix, Test Summary, and one sheet per module above.
- **[defect-laymans.json](defect-laymans.json)** — companion file holding the plain-English `title` / `summary` / `fix` / `example` per defect ID. The build script refuses to run if any defect lacks an entry or any entry references an unknown defect.
