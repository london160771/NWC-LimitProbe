# iGetJobs — SPEC.md

## 1. Product goal
iGetJobs is a personal lead-generation and client-acquisition tool for finding local businesses that are good candidates for website work.

The MVP should help the user find businesses with:
- no website, or
- a poor website,

then organize, score, review, draft outreach for, and track those leads.

## 2. V1 target markets
Search city-by-city in:
- United States
- United Kingdom
- Canada
- Australia

The location list must remain configurable.

## 3. Starter niches
The initial niche list should include:
- Dentists
- Med spas
- Gyms
- Salons
- Contractors / home services
- Real estate
- Law firms
- Restaurants
- Small hotels

The niche list must be configurable.

## 4. Core workflow
`Search → Collect → Deduplicate → Audit → Classify → Score → Draft Outreach → Approve → Track`

## 5. Data sources

### 5.1 SerpAPI
Use SerpAPI free tier as one discovery source.

### 5.2 OpenStreetMap / Overpass
Use OSM/Overpass as another discovery source.

Requirements:
- throttle requests
- cache where useful
- do not hammer the API

### 5.3 CSV import
Allow manual CSV import for leads collected elsewhere.

### 5.4 Hunter
Hunter is a fallback only.

Use it only when:
- a lead is worth pursuing, and
- no email is already available.

Stay within free-tier limits.

## 6. Normalized lead model
Each lead should support, where available:

- id
- businessName
- niche
- country
- city
- address
- phone
- website
- domain
- email
- socials
- rating
- reviewCount
- source
- sourceId
- audit
- classification
- score
- scoreReasons
- outreachDraft
- status
- notes
- followUpAt
- createdAt
- updatedAt

## 7. Deduplication
Deduplicate by:
1. normalized domain
2. normalized phone
3. normalized business name + address

Do not silently discard useful source metadata.

## 8. Website audit
The V1 audit must be deterministic.

Possible checks:
- website missing
- website unreachable
- HTTPS present
- mobile viewport/meta present
- basic mobile usability indicators
- response/performance indicators
- visible contact information
- visible CTA
- basic page structure
- obvious broken links where practical

Do not use AI for V1 auditing.

## 9. Classification
Every lead must be classified as:

### `NO_WEBSITE`
No usable website was found.

### `POOR_WEBSITE`
A website exists but fails enough deterministic checks to make it a plausible prospect.

### `ACCEPTABLE_WEBSITE`
A website exists and does not meet the threshold for a poor-site prospect.

## 10. Lead scoring
Score each lead from 0–100.

The score must:
- be deterministic
- use configurable weights
- show explicit reasons
- prioritize `NO_WEBSITE` and strong `POOR_WEBSITE` cases
- avoid black-box logic

Example score dimensions:
- website need
- contactability
- business quality signal
- local relevance
- confidence in source data

Exact weights can be tuned during implementation, but must remain visible in code/config.

## 11. Outreach
Generate deterministic, editable outreach drafts from lead data.

V1 outreach must:
- never auto-send
- require human review
- be editable before copying/sending
- use available business details
- avoid fake personalization

## 12. Lead pipeline
Statuses:
- New
- Qualified
- Contacted
- Replied
- Call Booked
- Closed
- Lost

The user must be able to update status manually.

## 13. Key screens

### Login
Simple Supabase authentication.

### Dashboard
Show useful totals such as:
- leads collected
- qualified leads
- no-website leads
- poor-website leads
- contacted
- replies
- calls booked
- closed

### Search
Inputs:
- country
- city
- niche
- source selection where useful

Actions:
- search
- collect leads
- show progress/results

### Leads
Table/list with:
- business
- niche
- location
- website state
- classification
- score
- priority
- status
- source

Filters should support:
- niche
- location
- classification
- score/priority
- status
- source

### Lead detail
Show:
- business/contact data
- source
- website audit
- score
- score reasons
- classification
- outreach draft
- notes
- status
- follow-up

### Outreach
Show leads ready for outreach and their drafts.

### Settings
Allow configuration for:
- API keys via secure backend/env flow
- scoring weights where practical
- default markets
- default niches

## 14. Authentication and database
Use Supabase for:
- authentication
- persistent lead storage
- user settings

## 15. V1 exclusions
Do not implement:
- AI lead scoring
- LLM-generated outreach
- AI voice calls
- automatic outreach
- automatic email sending
- mass follow-up campaigns
- CRM integrations
- paid data providers
- complex multi-user team features
- billing
- browser extension
- mobile app

These are V2+ ideas.

## 16. V1 success criteria
V1 is successful when the user can:

1. log in
2. search at least one supported source
3. collect local-business leads
4. deduplicate them
5. audit website presence/quality
6. classify them
7. score them with visible reasons
8. filter and inspect leads
9. create/edit an outreach draft
10. manually update lead status
11. persist data in Supabase
