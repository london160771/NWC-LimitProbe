# iGetJobs — AGENTS.md

## Purpose
Instructions for coding agents working on iGetJobs.

## Source of truth
When instructions conflict, use this order:

1. `SPEC.md`
2. `DESIGN.md`
3. `AGENTS.md`
4. `PLAN.md`
5. `PROJECT_STATE.md`
6. Existing code

Do not expand V1 beyond the approved scope.

## Product
iGetJobs is a personal client-acquisition tool for finding local businesses that either:
- have no website, or
- have a poor website that could reasonably need improvement.

The app helps collect leads, audit them, score them, draft outreach, and track status.

## Hard V1 constraints
- React, not Next.js.
- TypeScript preferred.
- Node.js API/backend.
- Supabase for auth + database.
- Free tiers only.
- No paid dependency required for the MVP.
- No AI integration in V1.
- No AI voice calling in V1.
- No automatic outreach sending in V1.
- No automatic cold calling.
- No CRM integrations in V1.
- No mass email automation in V1.
- Outreach drafts must require human approval.
- Desktop-first, mobile-usable.
- Keep architecture simple.
- Avoid MongoDB.

## Data sources
V1 may use:
- SerpAPI free tier.
- OpenStreetMap / Overpass.
- Manual CSV import.
- Hunter only as a fallback when a lead has no email and only within free-tier limits.

Each source must be isolated behind its own adapter.

## Search workflow
`Search → Collect → Deduplicate → Audit → Classify → Score → Draft Outreach → Approve → Track`

## Lead classification
A lead must be classified as one of:
- `NO_WEBSITE`
- `POOR_WEBSITE`
- `ACCEPTABLE_WEBSITE`

## Lead statuses
- New
- Qualified
- Contacted
- Replied
- Call Booked
- Closed
- Lost

## Website audit rules
Auditing must be deterministic and explainable.

Do not use an LLM.

Audit output should be structured and should support scoring reasons such as:
- no website
- broken or unreachable site
- missing HTTPS
- poor mobile behavior
- weak performance
- missing contact information
- missing clear CTA
- outdated-looking basic structure
- missing social links where relevant

Do not invent audit results. Only score from measurable checks.

## Scoring
- Score range: 0–100.
- Every score must have explicit reasons.
- Weights should be configurable.
- A score must never be a black box.
- UI must show numeric score, priority, classification, and reasons.

## Data hygiene
Normalize all source records into one lead model.

Deduplicate using, in order where available:
1. normalized domain
2. normalized phone
3. normalized business name + address

Preserve:
- source
- source identifier

## Secrets
- Store API keys only in environment variables.
- Never commit secrets.
- Never expose secrets in frontend code.
- Never log API keys.
- Throttle/cache Overpass requests.
- Guard Hunter usage carefully.

## Agent behavior
Before coding:
1. Read `SPEC.md`.
2. Read `DESIGN.md`.
3. Read `PLAN.md`.
4. Read `PROJECT_STATE.md`.
5. Inspect existing code.

During coding:
- Implement only the current approved phase.
- Do not start the next phase early.
- Avoid unnecessary dependencies.
- Keep functions small and testable.
- Prefer boring, reliable code over clever abstractions.
- Preserve existing working behavior.

Before finishing a phase:
- Run relevant tests.
- Run lint/typecheck/build where available.
- Summarize files changed.
- Update `PROJECT_STATE.md`.
- Record blockers honestly.
- Stop before the next phase unless explicitly instructed.

## Review model workflow
Default implementation model:
- GPT-6 Luna Max

Use GPT-6.1 Sol Medium for:
- difficult architecture decisions
- hard bugs
- multi-file refactors
- complex integration work

Use GPT-6.1 Sol High for:
- major phase reviews
- pre-deploy review
- pre-submission review
