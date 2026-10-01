# iGetJobs — DESIGN.md

## Design direction
Clean, premium, practical, light dashboard.

The product should feel like a focused internal sales tool, not a flashy SaaS landing page.

Avoid:
- dark-first UI
- excessive gradients
- giant cards
- noisy animations
- unnecessary charts
- clutter

## Layout
Desktop-first with mobile usability.

Primary shell:
- left sidebar
- compact top area
- main content region

Sidebar:
- Dashboard
- Search
- Leads
- Outreach
- Settings

## Visual principles
- strong whitespace
- readable typography
- compact data density
- simple cards
- clear table hierarchy
- visible states
- consistent spacing
- minimal motion

## Key screen behavior

### Login
- centered auth form
- email/password
- clear loading/error states
- no marketing clutter

### Dashboard
Use compact summary cards.

Suggested cards:
- Total leads
- Qualified
- No website
- Poor website
- Contacted
- Replies
- Calls booked
- Closed

Below cards:
- recent leads
- top opportunities
- recent status changes

Avoid meaningless charts in V1.

### Search
Use one clear search form.

Fields:
- Country
- City
- Niche
- Source

Primary button:
- Find leads

Results should show progressively if practical.

Each result should make it obvious:
- business name
- location
- website state
- source
- whether already saved

### Leads
Use a dense but readable table on desktop.

Recommended columns:
- Business
- Niche
- Location
- Classification
- Score
- Priority
- Status
- Source
- Updated

Mobile can collapse into cards.

Filters should remain easy to clear.

### Lead detail
Use sections/tabs rather than one giant card.

Suggested sections:
1. Overview
2. Website audit
3. Score
4. Contact
5. Outreach
6. Notes / activity

Every score must display:
- numeric score
- priority
- classification
- explicit reasons

### Outreach
Focus on human approval.

Each outreach item should show:
- business
- reason it is a lead
- available contact
- editable draft
- copy action
- manual status action

Do not add a “send all” button in V1.

### Settings
Keep simple.

Sections:
- Search/data sources
- Market defaults
- Niche defaults
- Scoring configuration

Secrets should not be rendered back to the browser after storage.

## Components
Prefer reusable primitives:

- AppShell
- Sidebar
- PageHeader
- StatCard
- SearchForm
- LeadsTable
- LeadFilters
- ClassificationBadge
- PriorityBadge
- StatusBadge
- ScoreDisplay
- AuditReasons
- OutreachEditor
- EmptyState
- LoadingState
- ErrorState

## State labels

### Classification
- NO_WEBSITE
- POOR_WEBSITE
- ACCEPTABLE_WEBSITE

### Priority
Suggested:
- High
- Medium
- Low

Priority should derive from score thresholds, not separate hidden logic.

### Pipeline status
- New
- Qualified
- Contacted
- Replied
- Call Booked
- Closed
- Lost

## Responsive behavior
Desktop is primary.

On smaller screens:
- sidebar may collapse
- tables may become stacked cards
- filters may become a drawer/sheet
- critical actions must remain accessible

## Accessibility
- semantic HTML
- keyboard-accessible controls
- labels for form fields
- visible focus states
- sufficient contrast
- do not encode meaning by color alone
