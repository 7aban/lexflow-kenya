# Document Template Setup Guide

This guide covers creating, managing, and using document templates for the pilot R18 generated-draft flow. Templates are managed through the backend API — there is no template-management UI in this pilot phase.

## 1. Purpose

Templates power the R18 generated draft flow. Staff can create reusable document templates, preview them against a live matter to confirm token resolution, and generate a draft document in one click.

- Generated drafts are **text-only** (no PDF, docx, pleading formatting, line numbering, or pagination yet).
- Generated drafts are **Internal by default** (`clientVisible=0`) until a staff member explicitly shares them.
- Templates are stored in the `document_templates` table and are visible to all staff (admin, advocate, assistant).

## 2. Template Anatomy

Each template has the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable template name |
| `description` | string | no | Short description of when to use this template |
| `practiceArea` | string | no | Practice area for filtering (e.g. Commercial Law) |
| `category` | string | no | Category for grouping (e.g. Letter, Draft, Engagement) |
| `bodyMarkup` | string | yes | Template body with `{{token.path}}` placeholders |
| `active` | boolean/string | — | Default `1` (active). Soft-deactivate via DELETE |

### Supported Tokens

The merge engine resolves the following token paths at preview/generate time:

| Token | Resolves To |
|-------|-------------|
| `{{firm.name}}` | Firm name from settings |
| `{{firm.address}}` | Firm address from settings |
| `{{firm.email}}` | Firm email from settings |
| `{{firm.phone}}` | Firm phone from settings |
| `{{matter.title}}` | Matter title |
| `{{matter.reference}}` | Matter reference number |
| `{{matter.caseNo}}` | Case number (if set) |
| `{{matter.court}}` | Court name (if set) |
| `{{matter.practiceArea}}` | Matter practice area |
| `{{matter.stage}}` | Current matter stage |
| `{{matter.assignedAdvocate}}` | Advocate name assigned to the matter |
| `{{client.name}}` | Client name |
| `{{client.email}}` | Client email |
| `{{today}}` | Current date (ISO 8601) |
| `{{user.fullName}}` | Full name of the user previewing/generating |
| `{{user.role}}` | Role of the user previewing/generating |

Unknown or unmapped tokens are **left in place** in the rendered output and reported in the `unresolvedTokens` response array. Review unresolved warnings before sharing a generated draft.

## 3. Safe Template Creation Procedure

Templates must be created by an **admin** account. Do **not** run `npm run seed:demo` for production or pilot template setup — that command is destructive and for local development only.

### 3.1 Prerequisites

- Running backend (see `docs/pilot-deployment-runbook.md` for startup).
- An admin account on that backend.
- `curl`, `PowerShell`, or any HTTP client.

### 3.2 Get an Admin Token

```powershell
$body = @{ email = "admin@lexflow.co.ke"; password = "your-admin-password" } | ConvertTo-Json
$login = Invoke-RestMethod -Uri "${BASE_URL}/api/auth/login" -Method Post -Body $body -ContentType "application/json"
$ADMIN_TOKEN = $login.token
```

Replace `$BASE_URL` with your backend URL (e.g. `http://localhost:5000`).

### 3.3 Create a Template

```powershell
$templateBody = @{
  name          = "Commercial Law — Client Update Letter"
  description   = "Template for client status updates in commercial matters."
  practiceArea  = "Commercial Law"
  category      = "Letter"
  bodyMarkup    = @"
Dear {{client.name}},

RE: {{matter.title}} ({{matter.reference}})

We refer to the above matter and write to update you on its current status.

Case Number: {{matter.caseNo}}
Court: {{matter.court}}

Should you have any questions, please do not hesitate to contact us.

Yours faithfully,
{{firm.name}}
"@
} | ConvertTo-Json -Depth 10

$template = Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates" -Method Post `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" } `
  -Body $templateBody -ContentType "application/json"

$template.id
```

### 3.4 List All Active Templates

```powershell
Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates" `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" }
```

Include inactive templates:

```powershell
Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates?includeInactive=1" `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" }
```

### 3.5 Get a Single Template

```powershell
Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates/DTPL..." `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" }
```

### 3.6 Update a Template

```powershell
$updateBody = @{ name = "Commercial Law — Client Update Letter v2"; description = "Updated template." } | ConvertTo-Json
Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates/DTPL..." -Method Patch `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" } `
  -Body $updateBody -ContentType "application/json"
```

### 3.7 Soft-Deactivate a Template

DELETE sets `active=0`. The template is excluded from listings and generation but remains in the database.

```powershell
Invoke-RestMethod -Uri "${BASE_URL}/api/document-templates/DTPL..." -Method Delete `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" }
```

### 3.8 Preview a Template Against a Matter

Preview resolves tokens against the matter and firm data but does **not** create a document.

```powershell
Invoke-RestMethod -Uri "${BASE_URL}/api/matters/MAT.../document-templates/DTPL.../preview" -Method Post `
  -Headers @{ Authorization = "Bearer $ADMIN_TOKEN" } `
  -Body "{}" -ContentType "application/json"
```

## 4. Starter Templates

The following templates are safe, generic examples suitable for a Kenyan law office pilot. They contain no legal advice that implies factual correctness, no court formatting, and no confidential data.

### Template A: Client Update Letter

Use for routine status updates to clients.

**Name:** `General — Client Update Letter`

**Practice Area:** General Practice

**Category:** Letter

**Body Markup:**

```
Dear {{client.name}},

RE: {{matter.title}} — {{matter.reference}}

We refer to the above matter and are writing to provide you with a brief update on its current status.

Matter Reference: {{matter.reference}}
Case Number: {{matter.caseNo}} | Court: {{matter.court}}

Prepared by: {{user.fullName}}
Date: {{today}}

Kindly let us know if you require any further information or wish to discuss the next steps.

Yours faithfully,
{{firm.name}}
```

### Template B: Demand / Matter Status Letter

Use for a brief status summary or initial demand notification.

**Name:** `General Practice — Demand / Status Letter`

**Practice Area:** General Practice

**Category:** Letter

**Body Markup:**

```
{{client.name}}
{{client.email}}

Dear {{client.name}},

RE: {{matter.title}} ({{matter.reference}})

We write to update you on the status of the above matter as at {{today}}.

Matter: {{matter.title}}
Reference: {{matter.reference}}
Stage: {{matter.stage}}
Assigned Advocate: {{matter.assignedAdvocate}}

We will continue to keep you informed of any significant developments. Should you have any queries, please do not hesitate to contact the undersigned.

Yours faithfully,
{{user.fullName}}
{{firm.name}}
{{firm.email}}
{{firm.phone}}
```

## 5. Verification Procedure

After creating a template and toggling it to active, verify the full workflow:

1. **Admin creates template** — confirm the response returns a `DTPL*` ID and `active=1`.
2. **Staff opens a matter** — confirm the matter exists and can be accessed.
3. **Staff previews the template** — `POST /api/matters/{matterId}/document-templates/{templateId}/preview` returns a merged preview. Check `unresolvedTokens` — any unexpected unresolved tokens indicate a typo or missing data.
4. **Staff generates a draft** — `POST /api/matters/{matterId}/document-templates/{templateId}/generate` returns a document object with `source=generated`, `mimeType=text/plain`, `clientVisible=0`, and a `templateId`/`templateName`.
5. **Confirm Generated Draft label** — the document appears in the document list with `source: "generated"`. The generated content is stored as a BLOB in the `documents` table.
6. **Confirm Internal state** — `clientVisible=0` means the client cannot see or download this document.
7. **Confirm unresolved-token warning behavior** — if a token cannot be resolved (e.g., `{{matter.unmappedField}}`), the literal token text is left in the rendered output. The response includes an `unresolvedTokens` array.
8. **Sharing with client requires confirmation** — after generation, a staff member must explicitly set `clientVisible=1` via `PATCH /api/documents/{documentId}` with `{ "clientVisible": true }`.
9. **Confirm client sees document only after sharing** — log in as the client user and confirm the generated document is absent from `GET /api/matters/{matterId}/documents` before sharing, and present after sharing.
10. **Confirm audit events** — verify `GET /api/audit-events` (admin only) contains `document_template_created` (for template creation) and `document_generated` (for draft generation).

## 6. Template Governance

- **Naming convention**: `Practice Area — Template Name` (e.g., `Commercial Law — Engagement Letter`). This keeps the template list scannable.
- **Keep templates short** for the pilot. Avoid long boilerplate; use concise, generic language.
- **Review every generated draft** before sharing. Templates can produce drafts with unresolved tokens or content that is not yet appropriate for the client.
- **Do not include confidential sample client data** inside templates. The `bodyMarkup` field should contain generic placeholder text only; real client data is merged at generation time.
- **Do not store passwords, secrets, or tokens** in templates. Body markup is stored in plain text and visible to all staff.
- **Deactivate obsolete templates** via `DELETE /api/document-templates/{id}` (soft-deactivate) instead of deleting from the database manually.

## 7. Known Limitations

- Text drafts only — no PDF, docx, or court-formatted output.
- No line numbering, pagination, or pleading formatting.
- No template-management UI; all template CRUD is API-based.
- No AI drafting or auto-suggestions.
- No automated email delivery of generated drafts.
- Unresolved tokens are left in place — always review `unresolvedTokens` before sharing.
