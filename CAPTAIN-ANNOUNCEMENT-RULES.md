# A. Captain Announcement (Portal Edition)

> Revised for the JPL Leagues portal. Captains are no longer announced in the
> WhatsApp group — all announcements happen on the portal, which enforces the
> rules automatically. Applies to all TVT formats (8 / 16 / 32 teams).

## Rules

- **Announcing your captain:** Captains are announced on the portal from your
  team login. You can only ever set your **own** team's captain — the portal
  does not allow touching another team's captaincy.

- **Switching before the deadline:** You may switch your captain freely any
  number of times until the gameweek's FPL deadline. Only your **final pick**
  counts toward the captaincy limit.

- **Deadline:** Announce before the FPL deadline. Once the deadline passes,
  that GW's captain/chip is **locked out** — a late submission is rejected
  outright, and the error names both the deadline's exact timestamp and the
  time your request arrived, so lateness is provable rather than taken on
  trust. Nothing rolls forward or gets silently saved for another GW.

- **30-minute lock after every deadline:** For 30 minutes after any
  gameweek's deadline, submissions are locked entirely — this is a fixed
  blackout window. A late or mistimed attempt during this window is recorded
  in the system's internal log — this is not a player-facing feature or an
  admin action, just an internal record.

- **The next GW opens only once the previous one has finished:** After the
  30-minute blackout, GW(n+1)'s window does **not** open until the Premier
  League has marked GW(n) as finished (i.e. every match played). This is
  because **Double Pointer**'s rank rule and **Challenge Chip**'s top-2 target
  are both league-table position dependent — declaring them against a table
  that is still moving would let a team pick a chip its final position never
  entitled them to. While waiting, the portal shows which gameweek it is
  waiting on and re-checks automatically.

  Three deliberate exceptions:
    - **GW1** is exempt — nothing precedes it, so there is no table to wait for.
    - This waits on the **Premier League**, not on the admin entering results.
      Scores can be processed days later; the window does not care.
    - If FPL's status feed is unreachable, the window falls back to the
      30-minute rule rather than locking everyone out, and says so on screen.
      There is also a 24-hour safety valve before any deadline, so a congested
      midweek schedule can never leave a team unable to declare.

  This gate applies to the TVT formats (8 / 16 / 32), which have
  position-dependent chips. The Continental Championship announces captains
  only, so it keeps the 30-minute rule.

- **Missed announcement:** If a team does not announce a captain, the portal
  **auto-assigns the lower-scoring member** of the team as captain for that
  GW. On a tie, the member who was *not* captain the previous GW is chosen.

- **Captain scoring:** The captain's points are **doubled**. Specifically, the
  captain's *net* score (FPL score minus transfer hits) is doubled — so if the
  captain takes negatives (−4 and so on), **the negatives are doubled too**.

- **Captaincy limit (League Stage):** Each player has a fixed number of
  captain chips for the League Stage (half the League-Stage gameweeks, e.g. 15
  for a 30-GW stage). Once used up, that player cannot captain again until the
  Play-offs, where captaincy is unlimited.

- **Double Pointer's rank rule is enforced:** Top-8 teams may only play
  Double Pointer against a Top-8 opponent; rank 9+ may only play it against a
  strictly higher-ranked opponent (no restriction in the Play-offs). This
  isn't just a written rule — the portal's chip picker greys out Double
  Pointer with an explanation whenever you're not eligible against your
  upcoming opponent, and rejects the submission server-side too if
  attempted anyway. The same show-everything-disable-what-you-can't-use
  treatment applies to the whole chip picker and the captain picker: every
  option is always visible, unusable ones are simply disabled with a
  tooltip explaining why (already used this set, no chips left, etc.).

- **Match result:** The scores of the 2 members (after hits, with the
  captain's net score doubled) are added and matched against the opponents'
  total. The higher-scoring team wins — a win is worth **2 points**, a draw
  **1 point**. The table updates automatically on the portal after every
  gameweek.

## Rules removed from the old (WhatsApp-era) version

| Old rule | Why it's no longer needed |
|---|---|
| Changing the other team's captaincy is not allowed; perpetrators get the least-scoring member as captain | Structurally impossible on the portal — a team login can only manage its own captain. The "lower scorer becomes captain" mechanic survives as the **missed-announcement auto-assign** rule instead. |
| Spamming captaincy messages → −1 on the TVT table (GW1–30) or −8 (GW31+) | There is no announcement group to spam. Switching your captain on the portal before the deadline is free and unlimited. |
| Captains locked in once the deadline passes | Still true — a late pick is rejected outright with the deadline timestamp and your submission timestamp shown, so lateness is provable. For 30 minutes after any deadline, submissions are locked entirely; after that the next gameweek's window opens once the Premier League has finished the previous gameweek. No admin review needed, nothing rolls over. |
| Table formed and updated manually after every gameweek | Standings update automatically on the portal. |
