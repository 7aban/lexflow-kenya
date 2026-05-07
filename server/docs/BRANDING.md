# LexFlow Firm Branding & Theme System

## Purpose

The firm branding/theme system allows a LexFlow firm to customize the visual identity of their practice-management workspace and client portal. It is designed to be safe, consistent, and easy to apply without risking style injection or layout breakage.

## Allowed Theme Fields

Only the following fields may be set. All values are validated strictly on the backend:

| Field | Type | Description |
|-------|------|-------------|
| `primaryColor` | hex `#RGB` or `#RRGGBB` | Primary brand color (sidebar, headers) |
| `accentColor` | hex `#RGB` or `#RRGGBB` | Accent color (buttons, highlights) |
| `backgroundColor` | hex `#RGB` or `#RRGGBB` | Main background |
| `surfaceColor` | hex `#RGB` or `#RRGGBB` | Cards, panels, surfaces |
| `textColor` | hex `#RGB` or `#RRGGBB` | Primary text |
| `textSecondaryColor` | hex `#RGB` or `#RRGGBB` | Muted/secondary text |
| `sidebarColor` | hex `#RGB` or `#RRGGBB` | Sidebar background |
| `sidebarTextColor` | hex `#RGB` or `#RRGGBB` | Sidebar text |
| `buttonColor` | hex `#RGB` or `#RRGGBB` | Primary button background |
| `buttonTextColor` | hex `#RGB` or `#RRGGBB` | Primary button text |
| `borderColor` | hex `#RGB` or `#RRGGBB` | Borders and lines |
| `linkColor` | hex `#RGB` or `#RRGGBB` | Link color |
| `successColor` | hex `#RGB` or `#RRGGBB` | Success states |
| `warningColor` | hex `#RGB` or `#RRGGBB` | Warning states |
| `errorColor` | hex `#RGB` or `#RRGGBB` | Error/danger states |
| `infoColor` | hex `#RGB` or `#RRGGBB` | Info states |
| `headerColor` | hex `#RGB` or `#RRGGBB` | Header background |
| `headerTextColor` | hex `#RGB` or `#RRGGBB` | Header text |
| `footerColor` | hex `#RGB` or `#RRGGBB` | Footer background |
| `footerTextColor` | hex `#RGB` or `#RRGGBB` | Footer text |
| `cardColor` | hex `#RGB` or `#RRGGBB` | Card backgrounds |
| `cardBorderColor` | hex `#RGB` or `#RRGGBB` | Card borders |
| `inputBorderColor` | hex `#RGB` or `#RRGGBB` | Input borders |
| `inputFocusBorderColor` | hex `#RGB` or `#RRGGBB` | Input focus borders |
| `navColor` | hex `#RGB` or `#RRGGBB` | Navigation background |
| `navTextColor` | hex `#RGB` or `#RRGGBB` | Navigation text |
| `navActiveColor` | hex `#RGB` or `#RRGGBB` | Active nav item background |
| `navActiveTextColor` | hex `#RGB` or `#RRGGBB` | Active nav item text |
| `badgePrimaryColor` | hex `#RGB` or `#RRGGBB` | Primary badge background |
| `badgePrimaryTextColor` | hex `#RGB` or `#RRGGBB` | Primary badge text |
| `fontFamily` | string (max 200 chars) | Font family stack |
| `headingFontFamily` | string (max 200 chars) | Heading font family |
| `fontSizeBase` | CSS size | Base font size |
| `fontWeightBase` | CSS weight | Base font weight |
| `borderRadius` | CSS size | Border radius |
| `spacingUnit` | CSS size | Spacing unit |
| `logo` | URL or data URI (max 5000 chars) | Firm logo |
| `logoDark` | URL or data URI (max 5000 chars) | Dark-mode logo |
| `logoLight` | URL or data URI (max 5000 chars) | Light-mode logo |
| `favicon` | URL or data URI (max 5000 chars) | Favicon |
| `source` | enum | `default`, `manual`, `preset`, `logo_extracted` |

Unknown keys are rejected. Raw CSS, `url()`, `var()`, `calc()`, `<`, `>`, `;`, `{`, `}` are never accepted.

## Presets

Three built-in presets are available:

1. **lexflow-default** — Deep navy with gold accent (original LexFlow look)
2. **emerald-gold** — Dark green with gold accent (Kenyan legal-institution feel)
3. **midnight-slate** — Dark slate with indigo accent (modern professional)

Presets are read-only. Clients and staff may read them; only admins can apply them via the theme API.

## API Endpoints

| Endpoint | Method | Access | Description |
|----------|--------|--------|-------------|
| `/api/firm-settings/theme` | GET | Authenticated (staff + client read) | Get current firm theme |
| `/api/firm-settings/theme/preview` | POST | Admin only | Preview theme without persisting |
| `/api/firm-settings/theme` | PUT | Admin only | Save/update theme |
| `/api/firm-settings/theme/reset` | POST | Admin only | Reset theme to default (does not affect logo/name) |
| `/api/firm-settings/theme/presets` | GET | Authenticated (staff + client read) | List available presets |

## Access Policy

- **Staff (admin, advocate, assistant)**: Can read theme and presets
- **Clients**: Can read theme and presets (read-only, no mutations)
- **Admin only**: Preview, update, reset mutations
- Clients cannot access admin mutation endpoints (enforced by `requireAdmin` middleware)

## Preview / Save / Reset Behavior

- **Preview**: Validates and returns the theme, but does NOT persist to database. Useful for live preview in the UI.
- **Save/Update**: Validates, persists to `firm_settings.themeJson`, and returns the saved theme.
- **Reset**: Sets `themeJson` to NULL, keeping firm name, logo, contact details intact. Equivalent to "use default theme."

## CSS Variable Mapping

The frontend applies validated theme fields as CSS custom properties on `document.documentElement`:

| Theme Field | CSS Variable |
|-------------|--------------|
| `primaryColor` | `--lf-primary` |
| `accentColor` | `--lf-accent` |
| `backgroundColor` | `--lf-background` |
| `surfaceColor` | `--lf-surface` |
| `textColor` | `--lf-text` |
| `textSecondaryColor` | `--lf-text-muted` |
| `sidebarColor` | `--lf-sidebar` |
| `sidebarTextColor` | `--lf-sidebar-text` |
| `buttonColor` | `--lf-button` |
| `buttonTextColor` | `--lf-button-text` |
| `borderColor` | `--lf-border` |
| `linkColor` | `--lf-link` |
| `successColor` | `--lf-success` |
| `warningColor` | `--lf-warning` |
| `errorColor` | `--lf-danger` |
| `infoColor` | `--lf-info` |

Fallback values are defined in `client/src/theme.jsx` styles via `var(--lf-*, #defaultColor)`.

## Security Posture

- **No raw CSS storage**: Only validated hex colors, font strings, and size strings are accepted
- **Hex-only color validation**: `normalizeHexColor()` rejects `rgb()`, `hsl()`, `var()`, `url()`, color names
- **Unknown field rejection**: `ALLOWED_THEME_KEYS` whitelist enforces exact keys
- **Contrast checking**: `validateThemeAccessibility()` warns below WCAG AA (4.5:1) and blocks below 3.0:1
- **Audit logging**: `firm_theme_updated` and `firm_theme_reset` events are recorded with entity type `firm_theme`
- **No arbitrary style injection**: Theme values are applied only as CSS variables, never as raw style strings
- **Payload safety**: Audit metadata stores only `action`, `entityType`, `entityId` — never the full theme JSON

## Database

- Column `themeJson` (TEXT) added idempotently to `firm_settings` table via `ensureColumn()`
- Stored as JSON string; NULL means "use default theme"
- Existing rows without `themeJson` are handled gracefully (return default theme)
- Seed script does not include `themeJson` (safe NULL default)

## Deferred Features

The following are explicitly deferred and NOT implemented in R6:

- **Logo/letterhead color extraction**: Automatic accent color detection from uploaded logos
- **PDF/export branding**: Applying theme colors to PDF invoices and exports
- **Per-user theme preferences**: Each user choosing their own theme variant
- **Custom CSS or font upload**: Only system fonts and validated hex colors are supported
