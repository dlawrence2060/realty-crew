---
name: cma-report
description: "Use when building a comparative market analysis (CMA), pricing a listing, or preparing comparables for an offer. Comparable selection, adjustments, the deliverable format and the limits of a CMA."
---
# CMA report

## Inputs
- Subject: address, type (detached, townhouse, apartment), finished size and source, lot size, year built, beds/baths, parking, view, condition/updates, strata fee, BC Assessment (land/improvements/total, year).
- Comparables: MLS® exports attached to the task or in library/market-data/. Note the export date, search criteria and source. No live MLS® access: if data is missing, ask for a specific export (area, type, date range, size range, statuses).

## Selecting comparables
- Solds first: same sub-area and type, last 3 to 6 months (widen and say so if thin), size within about 20%, similar age and condition.
- Actives = the competition; expireds/terminateds = what the market rejected. Show them separately.
- 3 to 6 strong comps beat 15 weak ones. State why each is included or excluded.

## Adjustments
- Adjust each comp toward the subject for meaningful differences: size ($/sq. ft. derived from the comps themselves, not a guess), lot, view, condition/renovation, age, parking, outdoor space, strata fee, sale date (market trend, only if you have a cited trend).
- Show a table: comp, sold price, date, each adjustment, adjusted price. Explain each adjustment's basis in one line.
- Don't overfit. If adjustments exceed about 15% of a comp's price, it isn't a good comp.

## Deliverables
- `cma-<address>.md`: summary (range and suggested list price), subject profile, market snapshot (cited), comps table, adjustments, reasoning, assumptions and data gaps.
- `cma-<address>.csv`: one row per comp with raw fields and adjustments.
- A short "for the realtor" note: weaknesses in the data and what would change the number.

## Limits
State plainly: a CMA is the realtor's opinion of market value from available data, not an appraisal. Assessed value is not market value.
