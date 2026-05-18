# Pilot Operations — Day-1 Acceptance Checklist

This checklist covers the acceptance checks that should be completed on Day 1 of the pilot deployment. It assumes the backend is running with a production environment loaded and that the operator has admin credentials.

---

## A. Deployment Acceptance

- [ ] `GET /health` returns `{ "status": "ok" }`.
- [ ] Staff login works at `POST /api/auth/login` with valid credentials.
- [ ] Admin account bootstrap password has been changed or removed from use.
- [ ] Production environment variables are loaded (`NODE_ENV=production`, `JWT_SECRET`, `DATABASE_PATH`, `BASE_URL`, `CORS_ORIGINS`, `LEXFLOW_BACKUP_KEY`, `BACKUP_DIR`, etc.).
- [ ] `npm run backup` (from `server/`) completes successfully and writes a `.db.enc` file.
- [ ] A backup restore drill has been run or at least scheduled (see `docs/pilot-deployment-runbook.md` Section 8).

---

## B. User / Role Setup

- [ ] One **admin** user exists (or was created after bootstrap).
- [ ] One **advocate** user is created and assigned to a pilot matter.
- [ ] One **assistant** user is created.
- [ ] One **client** user is created and linked to a client record.
- [ ] The assistant is confirmed **not** to have admin-level access (e.g., `GET /api/audit-events` returns 403 for the assistant token).

---

## C. Matter / Document Workflow

- [ ] A client record is created.
- [ ] A matter is created under that client.
- [ ] A document is uploaded to the matter.
- [ ] The uploaded document is **not** visible to the client (client user sees an empty document list on the matter).
- [ ] A document is shared via `PATCH /api/documents/{id}` with `{ "clientVisible": true }`.
- [ ] After sharing, the client can see and download the document.

---

## D. Template / Document Automation

- [ ] An admin creates a template via `POST /api/document-templates`.
- [ ] A staff member (admin or advocate assigned to the matter) generates a draft via `POST /api/matters/{matterId}/document-templates/{templateId}/generate`.
- [ ] The generated document appears in the document list with `source: "generated"` — the **Generated Draft** label.
- [ ] The generated document has `clientVisible: 0` — **Internal** state.
- [ ] Sharing the generated draft with the client requires an explicit `PATCH` to set `clientVisible: true`.
- [ ] After sharing, the client can see and download the generated draft.

---

## E. Audit Checks

- [ ] Admin can access `GET /api/audit-events` and `GET /api/audit-logs`.
- [ ] Audit events exist for:
  - `login_success` (each staff login)
  - `client_created` (client creation)
  - `matter_created` (matter creation)
  - `document_uploaded` (document upload)
  - `document_downloaded` (document download)
  - `document_template_created` (template creation)
  - `document_generated` (draft generation)
  - `document_visibility_changed` (visibility toggle)
  - `backup_created` (after running `npm run backup`)

---

## F. Known Limitations

The following items are **not yet implemented** and are accepted as pilot scope boundaries:

- [Confirmed] Generated drafts are **text-only** — no PDF, docx, or rich formatting.
- [Confirmed] No court formatting, line numbering, or pleading templates.
- [Confirmed] No AI drafting or auto-suggestions.
- [Confirmed] No automated email/SMS invitation sending — invitations must be shared manually.
- [Confirmed] Template management is **API-based** — there is no frontend template-management UI.
- [Confirmed] Generated drafts are always **Internal by default** — staff must explicitly share them.
- [Confirmed] Unresolved tokens remain visible in the rendered draft — staff must review before sharing.
