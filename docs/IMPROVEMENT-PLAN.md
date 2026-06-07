# LexFlow Kenya — Correction & Improvement Plan

> Companion to the feature-gap analysis. This document turns the assessment into a
> concrete, prioritised programme of work: what to fix in the existing code, what to
> build for Kenyan-jurisdiction readiness, and how to sequence it.
>
> **Convention:** **⚠️ VERIFY** marks a point that depends on Kenyan legal procedure
> and must be confirmed with a practising advocate before it is coded as a rule.
> Effort is rated **S / M / L / XL** relative to the existing codebase.

---

## 1. Executive summary

LexFlow is a mature, well-tested **practice-management** product (clients, matters,
documents, time/billing, HR, client portal, court-bundle tooling) with a strong audit
backbone and sensible access control. Its weaknesses fall into three buckets:

1. **Engineering debt that will block the next features** — an 8,600-line monolithic
   `server.js`, raw `sqlite3`, no client-side router, document BLOBs in the database,
   and two parallel audit systems.
2. **A thin data model around the matter "story"** — no event/timeline entity, no
   stage-change history, free-text event types.
3. **Almost no Kenyan-jurisdiction legal logic** — deadline cascades, limitation
   periods, Advocates Remuneration Order (ARO) billing, trust accounting, Data
   Protection Act (DPA) 2019 obligations, and Judiciary integrations are absent.

The plan below fixes the foundations first (so later work is cheap), lands a set of
high-leverage quick wins, then builds the jurisdiction features and the camera-roll
timeline on top.

---

## 2. Engineering corrections (foundations)

These are not user-facing but every feature in §4–§6 gets cheaper and safer once they
are done. Do them first or in parallel with the quick wins.

### 2.1 Break up `server.js` (8,611 lines) — **M**
**Problem:** all routes, schema, and helpers live in one file. Merge conflicts, slow
onboarding, hard to test in isolation.
**Fix:** extract by domain into `server/routes/*.js` (matters, billing, documents, hr,
deadlines, auth, clients) mounted on Express routers. Move `initDb()` schema into
`server/lib/schema.js`. No behaviour change — pure structural refactor, guarded by the
existing Jest suite. Do this incrementally, one router at a time, keeping tests green.

### 2.2 Introduce a migration system — **S–M**
**Problem:** schema evolves via ad-hoc `ensureColumn()` / `CREATE TABLE IF NOT EXISTS`
calls inside `initDb()` (~200 lines, runs every boot). There is no version record, no
rollback, no ordering guarantee.
**Fix:** adopt a lightweight migration runner (e.g. a `schema_migrations` table +
ordered SQL files, or `node-pg-migrate`-style for SQLite). Backfill the current schema
as migration `0001`. This is a prerequisite for safely shipping the new tables in §3.

### 2.3 Move document/avatar BLOBs out of SQLite — **M**
**Problem:** `documents.content`, `payment_proofs.content`, `signature_assets.content`,
and `users.avatar` are stored as BLOBs in the DB. This bloats the file, slows WAL,
complicates backups, and caps scalability.
**Fix:** abstract a storage interface (`lib/storage.js`) with a local-filesystem
implementation now and an S3-compatible driver later (MinIO works for on-prem Kenyan
hosting). Keep metadata rows; store bytes on disk/object store keyed by id. Migrate
existing BLOBs in a one-off script. **Local-first stays intact** — default driver is
the local filesystem.

### 2.4 Consolidate the two audit systems — **S**
**Problem:** `audit_logs` (legacy) and `audit_events` (structured, indexed, with
actor/IP/UA/metadata) both exist and are written side-by-side.
**Fix:** make `audit_events` the single source of truth; keep `audit_logs` writes only
until the StructuredAuditLog UI fully replaces the legacy view, then deprecate. This
audit spine is also the substrate for DPA records (§4.6) and the timeline (§6).

### 2.5 Add a client-side router — **M**
**Problem:** navigation is `setView()` React state in `App.jsx`; only `/invite/*` and
`/oauth/callback` parse the URL. Nothing is deep-linkable or shareable, and browser
back/forward don't work.
**Fix:** introduce `react-router` (or a minimal hash-based router to stay dependency-
light). This is a **hard prerequisite** for the deep-linkable timeline cards (§6) and
materially improves the whole app (bookmarkable matters, invoices, deadlines).

### 2.6 Tooling hygiene — **S**
No linter/formatter config is committed and there is no CI workflow in-repo. Add
ESLint + Prettier and a GitHub Actions workflow running `npm test` on both packages.
A `SessionStart` hook (see the `session-start-hook` skill) can seed the demo DB so web
sessions can run the suite immediately.

---

## 3. Data-model corrections

### 3.1 Matter stage-change history — **S** *(high leverage)*
**Problem:** `PATCH /matters/:id/status` overwrites `stage` in place and logs a generic
`matter_archived` audit event — the *previous* stage is lost. The matter's lifecycle
cannot be reconstructed.
**Fix:** add `matter_stage_history (id, matterId, fromStage, toStage, changedBy,
changedAt, note)` and write a row on every transition. Cheap, and it unlocks the
phase spine for the timeline (§6) plus cycle-time analytics.

### 3.2 Kenyanise the stage vocabulary — **S** *(⚠️ VERIFY)*
**Problem:** stage options are US-centric: `Intake, Conflict Check, Engagement, Active,
Discovery, Trial Prep, On Hold, Closed` (`StaffViews.jsx:1612`). "Discovery" / "Trial
Prep" are not Kenyan civil-procedure phases.
**Fix:** replace with a jurisdiction-appropriate set, e.g. *Intake → Conflict/KYC →
Engagement → Pleadings → Pre-trial/Directions → Hearing → Judgment → Execution/Appeal →
Closed*. ⚠️ VERIFY the canonical phase names and ordering with a litigator, and consider
per-practice-area variants (litigation vs. conveyancing vs. succession).

### 3.3 Event taxonomy + outcome fields on appearances — **S–M**
**Problem:** `appearances.type` is free text; there is no result/outcome/next-date,
so "ruling/judgment" frames carry no substance.
**Fix:** add a controlled `category` (mention, hearing, ruling, judgment, directions…)
and `outcome`, `nextDate`, `nextDateReason` columns to `appearances`. ⚠️ VERIFY the
court-event taxonomy.

### 3.4 Unified matter-timeline source — **S**
No `matter_events` table is needed. Replicate the proven `unifiedDeadlines()` pattern
(`server.js:3831`) as `unifiedMatterTimeline(matterId)` that normalises appearances,
documents, case_notes, invoices/payments, checklist completions, stage history, and
relevant `audit_events` into one ascending-sorted list. See §6.

---

## 4. Kenyan-jurisdiction feature build-out

### 4.1 Deadline cascade engine — **L** *(flagship, ⚠️ VERIFY heavily)*
**Today:** `deadlines` is a flat manual list; cron only *reminds* about dates that
already exist. No trigger→derive logic.
**Target:** a rules engine where a **trigger event + date** (e.g. "Defence filed on
2026-06-01") generates a **cascade of dependent deadlines** with court-day arithmetic.
**Design:**
- `deadline_rule_sets` (Civil Procedure Rules, Court of Appeal Rules, constitutional
  petition timelines) → `deadline_rules (triggerType, offsetDays, dayBasis,
  description, basis_citation)`.
- A computation service that applies clear-days / calendar-days / court-days rules and
  **excludes court vacation and public holidays** (needs a Kenyan court calendar table).
- Writes derived rows into the existing `deadlines` table (so `unifiedDeadlines`, the
  Deadline Center UI, and cron reminders all work unchanged).
- ⚠️ VERIFY every rule: entry of appearance & defence periods, setting-down windows,
  appeal/notice timelines, constitutional-petition service and hearing windows,
  treatment of "clear days," and vacation exclusion. Encode a *citation* per rule so
  advocates can audit the basis. **Ship rules as data, not code**, so they can be
  corrected without a deploy.

### 4.2 Limitation of Actions Act tracking by cause of action — **S–M** *(⚠️ VERIFY)*
**Today:** single free-text `matters.solDate`, surfaced as advisory only.
**Target:** capture `causeOfAction` + `accrualDate` on the matter; a small mapping
table (`limitation_periods`) derives `solDate`. ⚠️ VERIFY periods (e.g. contract,
tort, defamation, recovery of land, claims against government / statutory notice
requirements) and disability/acknowledgement tolling rules. Keep the advisory
disclaimer and force a human confirmation before relying on the computed date.

### 4.3 Advocates Remuneration Order billing & bill of costs — **L–XL** *(⚠️ VERIFY)*
**Today:** invoicing is hourly time-rollup or flat fixed fee only; VAT is *printed*,
not *computed*.
**Target:**
- An ARO scale calculator (`aro_scale_rules` as versioned data) producing
  instruction/getting-up/scale fees by matter type and value. ⚠️ VERIFY current ARO
  schedule figures and formulae.
- A **party-and-party / advocate-client bill of costs** document type with itemised
  fees + disbursements, generated through the existing Document Studio / PDF pipeline.
- Proper **VAT (16%) and disbursement** line handling on invoices. ⚠️ VERIFY current
  VAT rate and which items are vatable.
- A taxation workflow status on bills. Reuse `invoice_items`; add `item_type`
  (fee/disbursement/vat) and an ARO basis reference.

### 4.4 Client trust / office account ledger — **L** *(compliance-critical, ⚠️ VERIFY)*
**Today:** `retainerBalance` / `clients.retainer` are single mutable numbers; no
segregation, no ledger, no statutory trail.
**Target:** a proper double-entry ledger:
- `ledger_accounts (type: client_trust|office, ...)`, `ledger_transactions`,
  `ledger_entries (debit/credit)` with **immutable, append-only** postings (reuse the
  `audit_events` discipline).
- Enforce the **no-overdraw-on-client-account** rule and trust-to-office transfer
  controls. Reconciliation report + client account statements.
- ⚠️ VERIFY against the Advocates (Accounts) Rules and LSK requirements (designated
  client account, monthly reconciliation, retention periods).

### 4.5 Judiciary integration (e-filing / CTS / cause lists) — **M–XL** *(feasibility-gated)*
**Today:** a cosmetic external link to `efiling.court.go.ke`.
**Reality check:** ⚠️ I could not confirm a public, documented API for the Kenyan
Judiciary e-filing/CTS. Treat this as **research-gated**:
- **Phase A (low risk, high value):** a **daily cause-list watcher** — ingest published
  cause lists (upload/parse or scrape where permitted) and auto-flag matters whose
  `caseNo` appears, creating an `appearance`/notification. Reuses the
  `connected-account` sync pattern and `integrations_log`.
- **Phase B:** true e-filing submission — only if/when an API or sanctioned integration
  path exists. Do not over-invest until confirmed.

### 4.6 Data Protection Act 2019 — **M** *(cleanest fit)*
**Today:** absent (only the OAuth `prompt:'consent'` param).
**Target (reuses the audit spine, low architectural risk):**
- `consent_records (subjectType, subjectId, purpose, basis, grantedAt, withdrawnAt,
  channel, evidence)`.
- `processing_activities` (Record of Processing Activities / ROPA) seeded with the
  firm's data flows.
- A **DSAR workflow** (access/erasure/rectification requests) modelled on the existing
  `document_requests` lifecycle.
- **Retention policies** wired to the existing soft-delete, plus a breach-log table.
- ⚠️ VERIFY registration/notification thresholds with the Office of the Data Protection
  Commissioner and lawful-basis specifics.

---

## 5. Security, compliance & operability hardening — **S–M**
- **Secrets:** Twilio/SMTP credentials live in `reminder_settings` (DB). Move to env /
  secret store; never return them to the client.
- **Connected-account tokens** are stored encrypted (`accessTokenEncrypted`) — confirm
  the key management and rotation story is documented and not co-located with the DB.
- **Backups:** encrypted backup tooling exists; once BLOBs move to object storage (§2.3),
  extend backup/restore to cover both DB and files, and document RPO/RTO.
- **Rate limiting / helmet** are present — add per-route auth-attempt throttling audit
  review.
- **PII in audit/logs:** ensure structured-audit metadata doesn't leak document content
  or trust figures beyond role scope (ties into DPA §4.6).

---

## 6. Camera-roll matter timeline — implementation plan

**Goal:** an animated horizontal film-strip (Intake → Pleadings → Hearings → Rulings →
Judgment → Closure), each frame a deep-linkable, filterable card.

**Backend (mostly reuse):**
1. `GET /api/matters/:id/timeline` → `unifiedMatterTimeline(matterId)` (new, mirrors
   `unifiedDeadlines`). Unions appearances, documents, case_notes, invoices/payments,
   checklist completions, **stage history (§3.1)** and matter-scoped `audit_events`,
   normalised to `{ id, source, category, phase, title, date, summary, deepLink,
   meta }`, sorted ascending. Respect existing `canAccessMatter` + client-visibility
   rules. **S.**
2. Phase bucketing from the §3.2 stages + §3.3 event categories. **S.**

**Frontend:**
3. **Router prerequisite (§2.5)** so each frame is deep-linkable
   (`/matters/:id/timeline?event=appearance:123`). **M.**
4. Film-strip component: **CSS `scroll-snap` + `transition`/`transform`** gets ~80% with
   **zero new dependencies** (the codebase already uses CSS keyframes/transitions). If
   richer scrubbing/physics is wanted, add **`framer-motion`** (one dependency). **M.**
5. Filtering by phase/category/source/date; cards open a detail drawer reusing existing
   matter sub-views. **M.**

**What's already available per frame:** dates, titles, types, doc names/versions,
appearance details, invoice numbers/amounts, note authors — all returned today by the
matter detail endpoint.
**What must be added:** stage-change history (§3.1), appearance outcome/next-date
(§3.3), event category, and optionally a small thumbnail/icon per category for the
"camera-roll" look.

**Verdict:** achievable on the current data model **without restructuring**; the only
architecturally notable change is introducing the router.

---

## 7. Prioritised roadmap

### Phase 0 — Foundations (do first / in parallel)
- 2.2 Migrations (S–M) · 2.4 Audit consolidation (S) · 2.6 Lint/CI + SessionStart (S)
- 2.5 Router (M) · 2.1 Split `server.js` (M, incremental)

### Phase 1 — Quick wins (high value, low effort, on existing code)
- 3.1 Stage-change history (S)
- 3.2 Kenyanise stages (S, ⚠️ VERIFY)
- 4.2 Limitation-by-cause-of-action (S–M, ⚠️ VERIFY)
- Recurring statutory deadlines — VAT/PAYE/NSSF/SHIF/annual returns (S–M; `deadlines`
  + cron already exist)
- 3.3 Appearance outcome/category fields (S–M)

### Phase 2 — Differentiators
- 6 Camera-roll timeline (M, after router)
- 4.1 Deadline cascade engine (L, ⚠️ VERIFY) — flagship
- 4.6 DPA 2019 consent/ROPA/DSAR (M)
- 4.5 Phase A cause-list watcher (M, feasibility-gated)

### Phase 3 — Heavy compliance lifts
- 4.4 Trust/office ledger (L, ⚠️ VERIFY)
- 4.3 ARO billing + bill of costs + VAT (L–XL, ⚠️ VERIFY)
- 2.3 BLOB → object storage (M; schedule before scaling)
- 4.5 Phase B true e-filing (XL, only if API confirmed)

---

## 8. Open legal questions to resolve before coding rules
1. CPR / Court of Appeal Rules / constitutional-petition deadline computations
   (clear-days vs. calendar-days, vacation & holiday exclusion, service rules).
2. Limitation of Actions Act periods per cause of action + tolling/disability rules.
3. Current ARO scale figures, getting-up/instruction fee formulae, taxation procedure.
4. Advocates (Accounts) Rules: designated client account, reconciliation cadence,
   record retention.
5. Whether the Judiciary e-filing/CTS exposes any sanctioned API vs. portal-only.
6. DPA registration thresholds and lawful-basis specifics with the ODPC.

Each of these should be answered by a practising Kenyan advocate and encoded as
**versioned, auditable data** (with citations) rather than hard-coded logic, so the
rules can be corrected without redeploying.
