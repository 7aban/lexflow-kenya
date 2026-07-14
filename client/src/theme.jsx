export const theme = {
  forest: '#1A3628',
  forestDark: '#112219',
  forestMid: '#28503A',
  forestHover: '#1F3F2E',
  navy900: '#112219',
  navy800: '#1A3628',
  navy700: '#28503A',
  navy600: '#1F3F2E',
  gold: '#C5973C',
  goldDark: '#A97824',
  goldLight: '#D9AA55',
  goldPale: '#FDF8EE',
  cream: '#F5F2EB',
  creamDark: '#EAE5D9',
  ink: '#1A1A18',
  inkMid: '#3D3D3A',
  muted: '#6B6B66',
  line: '#DDD8CE',
  paper: '#FFFFFF',
  wash: '#F5F2EB',
  green: '#1A5C36',
  greenBg: '#EBF5EE',
  red: '#8B2020',
  redBg: '#FCEAEA',
  amber: '#B07820',
  amberBg: '#FEF5E4',
  blue: '#2C5F8A',
  blueBg: '#EAF2FA',
  shadow: '0 1px 3px rgba(0,0,0,0.08)',
  shadowLift: '0 14px 32px rgba(17,34,25,0.12)',
};

export const defaultFirmSettings = { name: 'LexFlow Kenya', logo: '', letterhead: '', primaryColor: '#1A3628', accentColor: '#C5973C', websiteURL: '', email: 'accounts@lexflow.co.ke', phone: '+254 700 123456', address: 'Nairobi, Kenya', advocateBillingVisibility: 1, moduleSettings: { retainerManagement: false, kycCdd: false, corporateAuthority: false, retainerLedger: false, scopeVariation: false, clientTasks: false, advancedCompliance: false } };

export const outputBrandingModes = [
  { value: 'letterhead', label: 'Use firm letterhead' },
  { value: 'simple', label: 'Use simple firm branding' },
  { value: 'plain', label: 'Plain / no firm branding' },
];

export function hasFirmLetterhead(firm = {}) {
  return Boolean(firm?.letterhead || firm?.theme?.letterhead);
}

export function firmLetterheadMimeType(firm = {}) {
  const letterhead = firm?.letterhead || firm?.theme?.letterhead || '';
  const match = /^data:image\/(png|jpe?g|webp);base64,/i.exec(String(letterhead));
  if (!match) return '';
  return match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
}

export function letterheadPdfOutputWarning(firm = {}) {
  if (!hasFirmLetterhead(firm)) return 'Upload a firm letterhead first, or use simple branding.';
  if (firmLetterheadMimeType(firm) === 'webp') {
    return 'PDF output can embed PNG/JPEG letterheads. This saved WebP will still preview, but PDF downloads will use simple firm branding until you upload PNG/JPEG.';
  }
  return '';
}

export function defaultOutputBrandingMode(firm = {}, fallback = 'simple') {
  if (fallback === 'plain') return 'plain';
  return hasFirmLetterhead(firm) ? 'letterhead' : 'simple';
}

export function appendBrandingModeToPath(path, brandingMode) {
  if (!brandingMode) return path;
  const separator = String(path).includes('?') ? '&' : '?';
  return `${path}${separator}brandingMode=${encodeURIComponent(brandingMode)}`;
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  let hex = value.trim();
  if (/^#([0-9A-Fa-f]{3})$/.test(hex)) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return hex.toUpperCase();
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const int = parseInt(normalized.slice(1), 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  const convert = value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * convert(rgb.r) + 0.7152 * convert(rgb.g) + 0.0722 * convert(rgb.b);
}

export function contrastRatio(foreground, background) {
  if (!hexToRgb(foreground) || !hexToRgb(background)) return 0;
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readableTextColor(background, preferred) {
  const bg = normalizeHexColor(background);
  if (!bg) return preferred || theme.ink;
  if (preferred && contrastRatio(preferred, bg) >= 3) return preferred;
  return contrastRatio('#FFFFFF', bg) >= contrastRatio(theme.ink, bg) ? '#FFFFFF' : theme.ink;
}

export function resolveReadableTheme(input = {}) {
  const primaryColor = input.primaryColor || theme.forest;
  const accentColor = input.accentColor || theme.gold;
  const defaultPrimary = normalizeHexColor(primaryColor) === theme.forest;
  const defaultAccent = normalizeHexColor(accentColor) === theme.gold;
  const isLexFlowDefaultBase = defaultPrimary && defaultAccent;
  const backgroundColor = input.backgroundColor || theme.cream;
  const cardColor = input.cardColor || input.surfaceColor || '#FFFFFF';
  const headerColor = input.headerColor || (isLexFlowDefaultBase ? theme.forest : primaryColor);
  const sidebarColor = input.sidebarColor || (isLexFlowDefaultBase ? theme.forestDark : primaryColor);
  const buttonColor = input.buttonColor || primaryColor;
  return {
    ...input,
    primaryColor,
    accentColor,
    backgroundColor,
    surfaceColor: input.surfaceColor || cardColor,
    cardColor,
    headerColor,
    sidebarColor,
    buttonColor,
    textColor: readableTextColor(backgroundColor, input.textColor || theme.ink),
    textSecondaryColor: readableTextColor(backgroundColor, input.textSecondaryColor || theme.muted),
    cardTextColor: readableTextColor(cardColor, input.cardTextColor || input.textColor || theme.ink),
    cardMutedColor: readableTextColor(cardColor, input.cardMutedColor || input.textSecondaryColor || theme.muted),
    onPrimaryColor: readableTextColor(primaryColor, input.onPrimaryColor || input.primaryTextColor || '#FFFFFF'),
    onAccentColor: readableTextColor(accentColor, input.onAccentColor || theme.ink),
    onSidebarColor: readableTextColor(sidebarColor, input.onSidebarColor || input.sidebarTextColor || '#FFFFFF'),
    onHeaderColor: readableTextColor(headerColor, input.onHeaderColor || input.headerTextColor || '#FFFFFF'),
    onButtonColor: readableTextColor(buttonColor, input.onButtonColor || input.buttonTextColor || '#FFFFFF'),
  };
}

export function StyleTag() { return <style>{`
  * { box-sizing: border-box; }
  body { margin: 0; background: #F5F2EB; font: 400 13px/1.45 Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif; color: #1A1A18; }
  button, input, select, textarea { font: inherit; }
  button { transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .16s ease; }
  button:not(:disabled):hover { transform: translateY(-1px); }
  button:disabled { opacity: .5; cursor: not-allowed !important; transform: none !important; }
  input:focus, select:focus, textarea:focus { outline: 2px solid rgba(197,151,60,.25); border-color: #C5973C !important; }
  section:hover { box-shadow: 0 8px 22px rgba(15,27,51,.08); }
  .lf-nav:hover, .lf-nav-group:hover { background: color-mix(in srgb, var(--lf-on-sidebar, #fff) 10%, transparent) !important; color: var(--lf-on-sidebar, #fff) !important; }
  .lf-resource-link:hover { background: color-mix(in srgb, var(--lf-on-sidebar, #fff) 10%, transparent) !important; color: var(--lf-on-sidebar, #fff) !important; }
  #root .lf-mobile-only, #root .lf-mobile-drawer-layer { display: none !important; }
  #root .lf-report-mobile-label { display: none; }
  @media (max-width: 980px) {
    #root .lf-page-inner { padding: 20px 18px 110px !important; }
    #root header.lf-topbar { padding: 0 18px !important; }
    #root .lf-top-actions { flex-wrap: nowrap; }
    /* OVERFLOW-1: payment/invoice preview card layout for tablet (sidebar still visible at 768px) */
    #root .lf-payment-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-payment-cards table { min-width: 0 !important; }
    #root .lf-payment-cards thead { display: none !important; }
    #root .lf-payment-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-payment-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-payment-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-payment-cards td:nth-child(1)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(2)::before { content: "Receipt"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(3)::before { content: "Method"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(4)::before { content: "Reference"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(5)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(6)::before { content: "Receipt PDF"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
  }
  @media (max-width: 767px) {
    /* UI-BUG-1: collapse app shell to a single column on mobile. The shell carries an inline gridTemplateColumns '224px minmax(0,1fr)', so this override needs !important to win over it; otherwise main is squeezed into the 224px sidebar track and content (incl. the client hero) overlaps. */
    #root .lf-app-shell { grid-template-columns: minmax(0, 1fr) !important; }
    #root .lf-desktop-sidebar { display: none !important; }
    #root .lf-mobile-only { display: inline-flex !important; }
    #root .lf-mobile-drawer-layer { display: block !important; }
    #root header.lf-topbar { height: auto !important; min-height: 54px; padding: 8px 14px !important; gap: 8px !important; }
    #root header.lf-topbar input { min-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; }
    #root .lf-page-inner { padding: 16px 14px 112px !important; }
    #root .lf-topbar-search { flex: 1 1 auto; min-width: 0; max-width: none !important; }
    #root .lf-topbar-search-kbd { display: none !important; }
    #root .lf-mobile-search input { width: 100% !important; }
    #root .lf-dashboard-stats { grid-template-columns: minmax(0,1fr) !important; }
    .lf-login-root .lf-login-split { grid-template-columns: 1fr !important; }
    .lf-login-root .lf-login-brand { padding: 32px 24px !important; }
    .lf-login-root .lf-login-brand-features { display: none !important; }
    .lf-login-root .lf-login-card-wrap { padding: 16px !important; }
    #root .lf-matter-grid { grid-template-columns: 1fr !important; }
    #root .lf-split-grid { grid-template-columns: 1fr !important; }
    #root .lf-task-split-grid { display: grid !important; grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; justify-items: stretch !important; }
    #root .lf-task-split-grid > section { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-task-split-grid form { grid-template-columns: minmax(0,1fr) !important; }
    #root .lf-doc-grid { grid-template-columns: 1fr !important; }
    #root .lf-court-mode-stack { gap: 10px !important; }
    /* R15d-1: Mobile touch targets */
    #root button:not(.lf-nav-item):not(.lf-nav-group-button) { min-width: 44px; min-height: 44px; }
    #root input, #root select, #root textarea { min-height: 44px; padding-top: 10px !important; padding-bottom: 10px !important; }
    /* R15d-1: Mobile card/container sizing */
    #root section { padding: 14px 16px !important; }
    #root section > div:first-child { flex-wrap: wrap !important; gap: 8px !important; }
    #root div[style*="border-left: 4px solid"] { padding: 12px !important; }
    /* R15d-1: Mobile toast - safe width on narrow viewports */
    #root div[role="status"] { left: 16px !important; right: 16px !important; min-width: 0 !important; max-width: calc(100vw - 32px) !important; }
    /* R15d-1: Mobile modal - tighter backdrop padding */
    #root div[style*="z-index: 3000"] { box-sizing: border-box !important; width: 100vw !important; max-width: 100vw !important; padding: 16px !important; align-items: center !important; justify-items: center !important; overflow: auto !important; overflow-x: hidden !important; }
    #root div[role="dialog"] > div { box-sizing: border-box !important; width: calc(100vw - 32px) !important; max-width: calc(100vw - 32px) !important; min-width: 0 !important; max-height: calc(100vh - 32px) !important; overflow: auto !important; overflow-x: hidden !important; }
    #root div[role="dialog"] div[style*="justify-content: flex-end"] { flex-wrap: wrap !important; justify-content: stretch !important; }
    #root div[role="dialog"] div[style*="justify-content: flex-end"] > button { flex: 1 1 0 !important; min-width: 0 !important; }
    /* R15d-3: Dashboard card tables */
    #root .lf-receivables-cards > div,
    #root .lf-court-dates-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-receivables-cards table,
    #root .lf-court-dates-cards table { min-width: 0 !important; }
    #root .lf-receivables-cards thead,
    #root .lf-court-dates-cards thead { display: none !important; }
    #root .lf-receivables-cards tbody tr,
    #root .lf-court-dates-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-receivables-cards tbody td,
    #root .lf-court-dates-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-receivables-cards tbody tr:hover td,
    #root .lf-court-dates-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-receivables-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-receivables-cards td:nth-child(2)::before { content: "Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-receivables-cards td:nth-child(3)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-receivables-cards td:nth-child(4)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(1)::before { content: "Appearance"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(2)::before { content: "Matter"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(3)::before { content: "Date"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(4)::before { content: "Time"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(5)::before { content: "Location"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-court-dates-cards td:nth-child(6)::before { content: "Virtual Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15d-6: DeadlineCenter mobile cards */
    #root .lf-deadline-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-deadline-cards table { min-width: 0 !important; }
    #root .lf-deadline-cards thead { display: none !important; }
    #root .lf-deadline-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-deadline-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-deadline-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-deadline-cards td:nth-child(1)::before { content: "Due"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(2)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(3)::before { content: "Deadline"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(4)::before { content: "Matter / Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(5)::before { content: "Owner"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(6)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(7)::before { content: "Action"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* LOCAL-PILOT-FIX-20: Reports mobile cards */
    #root .lf-reports-page { max-width: 100% !important; overflow-x: hidden !important; }
    #root .lf-report-cards,
    #root .lf-report-cards * { box-sizing: border-box !important; }
    #root .lf-report-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-report-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-report-cards table,
    #root .lf-report-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-report-cards thead { display: none !important; }
    #root .lf-report-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-report-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-report-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-report-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-report-cards tbody td::before { display: none !important; content: none !important; }
    #root .lf-report-cell { display: grid; gap: 3px; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    #root .lf-report-mobile-label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; line-height: 1.2; }
    /* R15d-9 / LOCAL-PILOT-DOCUMENT-VISIBILITY-CAPABILITY-COHERENCE-98: MatterDocuments staff mobile cards */
    #root .lf-doc-cards-staff > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-doc-cards-staff table { min-width: 0 !important; }
    #root .lf-doc-cards-staff thead { display: none !important; }
    #root .lf-doc-cards-staff tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-doc-cards-staff tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-doc-cards-staff tbody tr:hover td { background: transparent !important; }
    #root .lf-doc-cards-staff td:nth-child(1)::before { content: "Name"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(2)::before { content: "Folder"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(3)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(4)::before { content: "Size"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(5)::before { content: "Source"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(6)::before { content: "Access"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(7)::before { content: "Move"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff td:nth-child(8)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-staff tbody td::before { content: attr(data-label) !important; min-width: 78px; }
    #root .lf-doc-cards-staff .lf-document-client-access { flex: 1 1 auto; max-width: 100% !important; }
    /* R15d-9: MatterDocuments client mobile cards (6 columns) */
    #root .lf-doc-cards-client > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-doc-cards-client table { min-width: 0 !important; }
    #root .lf-doc-cards-client thead { display: none !important; }
    #root .lf-doc-cards-client tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-doc-cards-client tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-doc-cards-client tbody tr:hover td { background: transparent !important; }
    #root .lf-doc-cards-client td:nth-child(1)::before { content: "Name"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-client td:nth-child(2)::before { content: "Folder"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-client td:nth-child(3)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-client td:nth-child(4)::before { content: "Size"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-client td:nth-child(5)::before { content: "Source"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-doc-cards-client td:nth-child(6)::before { content: "Download"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15d-14a: Staff Client directory mobile cards */
    #root .lf-client-cards,
    #root .lf-client-cards * { box-sizing: border-box !important; }
    #root .lf-client-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-client-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-client-cards table,
    #root .lf-client-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-client-cards thead { display: none !important; }
    #root .lf-client-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-client-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-client-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-client-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-client-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-cards td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-client-cards td:nth-child(1)::before { content: "Name"; }
    #root .lf-client-cards td:nth-child(2)::before { content: "Type"; }
    #root .lf-client-cards td:nth-child(3)::before { content: "Email"; }
    #root .lf-client-cards td:nth-child(4)::before { content: "Phone"; }
    #root .lf-client-cards td:nth-child(5)::before { content: "Status"; }
    #root .lf-client-cards td:nth-child(6)::before { content: "Reminders"; }
    #root .lf-client-cards td:nth-child(7)::before { content: "Portal"; }
    #root .lf-client-cards td:nth-child(8)::before { content: "Actions"; }
    /* R15e-1: Client portal My Matters mobile cards */
    #root .lf-client-matters-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-matters-cards table { min-width: 0 !important; }
    #root .lf-client-matters-cards thead { display: none !important; }
    #root .lf-client-matters-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-matters-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-matters-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-matters-cards td:nth-child(1)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-matters-cards td:nth-child(2)::before { content: "Stage"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-matters-cards td:nth-child(3)::before { content: "Next Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-matters-cards td:nth-child(4)::before { content: "Action"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal Court Appearances mobile cards */
    #root .lf-client-events-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-events-cards table { min-width: 0 !important; }
    #root .lf-client-events-cards thead { display: none !important; }
    #root .lf-client-events-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-events-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-events-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-events-cards td:nth-child(1)::before { content: "Event"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-events-cards td:nth-child(2)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-events-cards td:nth-child(3)::before { content: "Time"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-events-cards td:nth-child(4)::before { content: "Location"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-events-cards td:nth-child(5)::before { content: "Virtual Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal Invoices mobile cards */
    #root .lf-client-invoices-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-invoices-cards table { min-width: 0 !important; }
    #root .lf-client-invoices-cards thead { display: none !important; }
    #root .lf-client-invoices-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-invoices-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-invoices-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-invoices-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(2)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(3)::before { content: "Paid"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(4)::before { content: "Balance"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(5)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(6)::before { content: "PDF"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal Payment Proofs mobile cards */
    #root .lf-client-proofs-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-proofs-cards table { min-width: 0 !important; }
    #root .lf-client-proofs-cards thead { display: none !important; }
    #root .lf-client-proofs-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-proofs-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-proofs-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-proofs-cards td:nth-child(1)::before { content: "Reference"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(2)::before { content: "Method"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(3)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(4)::before { content: "Uploaded"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* UI-5F: Client portal invoice-payments summary mobile cards (6 columns) */
    #root .lf-client-invoice-payments-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-invoice-payments-cards table { min-width: 0 !important; }
    #root .lf-client-invoice-payments-cards thead { display: none !important; }
    #root .lf-client-invoice-payments-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-invoice-payments-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-invoice-payments-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-invoice-payments-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoice-payments-cards td:nth-child(2)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoice-payments-cards td:nth-child(3)::before { content: "Receipt"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoice-payments-cards td:nth-child(4)::before { content: "Method"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoice-payments-cards td:nth-child(5)::before { content: "Reference"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoice-payments-cards td:nth-child(6)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal All Documents mobile cards */
    #root .lf-client-all-docs-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-all-docs-cards table { min-width: 0 !important; }
    #root .lf-client-all-docs-cards thead { display: none !important; }
    #root .lf-client-all-docs-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-all-docs-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-all-docs-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-all-docs-cards td:nth-child(1)::before { content: "Name"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(2)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(3)::before { content: "Source"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(4)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(5)::before { content: "Download"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* Product 9B: Client portal All Court Events mobile cards */
    #root .lf-client-all-events-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-all-events-cards table { min-width: 0 !important; }
    #root .lf-client-all-events-cards thead { display: none !important; }
    #root .lf-client-all-events-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-all-events-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-all-events-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-all-events-cards td:nth-child(1)::before { content: "Event"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-events-cards td:nth-child(2)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-events-cards td:nth-child(3)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-events-cards td:nth-child(4)::before { content: "Time"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-events-cards td:nth-child(5)::before { content: "Location"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-events-cards td:nth-child(6)::before { content: "Virtual Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal notice attachment grid - stack on narrow mobile */
    #root .lf-notice-attachment-grid button { grid-template-columns: 42px minmax(0,1fr) !important; }
    #root .lf-notice-attachment-grid button small { display: block; grid-column: 1 / -1; padding-left: 0; }
    /* R15d-12: Task board mobile cards */
    #root .lf-task-cards,
    #root .lf-task-cards * { box-sizing: border-box !important; }
    #root .lf-task-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-task-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-task-cards table,
    #root .lf-task-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-task-cards thead { display: none !important; }
    #root .lf-task-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-task-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-task-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-task-cards tbody td input,
    #root .lf-task-cards tbody td select,
    #root .lf-task-cards tbody td textarea { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-task-cards tbody td::before { min-width: 0 !important; }
    #root .lf-task-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-task-cards td:nth-child(1)::before { content: "Task"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-task-cards td:nth-child(2)::before { content: "Assignee"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-task-cards td:nth-child(3)::before { content: "Due"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-task-cards td:nth-child(4)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-task-cards td:nth-child(5)::before { content: "Timer"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-task-cards td:nth-child(6)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15d-14b: AppearanceEditorList mobile cards */
    #root .lf-appearance-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-appearance-cards table { min-width: 0 !important; }
    #root .lf-appearance-cards thead { display: none !important; }
    #root .lf-appearance-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-appearance-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-appearance-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-appearance-cards td:nth-child(1)::before { content: "Title"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(2)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(3)::before { content: "Time"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(4)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(5)::before { content: "Location"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(6)::before { content: "Virtual Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(7)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* UI-5D: Communications client activity mobile cards */
    #root .lf-communications-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-communications-cards table { min-width: 0 !important; }
    #root .lf-communications-cards thead { display: none !important; }
    #root .lf-communications-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-communications-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-communications-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-communications-cards td:nth-child(1)::before { content: "When"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-communications-cards td:nth-child(2)::before { content: "Action"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-communications-cards td:nth-child(3)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-communications-cards td:nth-child(4)::before { content: "Summary"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* UI-5E: Invitations mobile cards */
    #root .lf-invitation-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-invitation-cards table { min-width: 0 !important; }
    #root .lf-invitation-cards thead { display: none !important; }
    #root .lf-invitation-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-invitation-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-invitation-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-invitation-cards td:nth-child(1)::before { content: "Email"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invitation-cards td:nth-child(2)::before { content: "Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invitation-cards td:nth-child(3)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invitation-cards td:nth-child(4)::before { content: "Created"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invitation-cards td:nth-child(5)::before { content: "Expires"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invitation-cards td:nth-child(6)::before { content: "Link"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-2: Invoice Register mobile cards */
    #root .lf-invoice-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-invoice-cards table { min-width: 0 !important; }
    #root .lf-invoice-cards thead { display: none !important; }
    #root .lf-invoice-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-invoice-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-invoice-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-invoice-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(2)::before { content: "Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(3)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(4)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(5)::before { content: "Paid"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(6)::before { content: "Balance"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(7)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(8)::before { content: "PDF"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(9)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* UI-5B: Payments sub-table mobile cards */
    #root .lf-payment-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-payment-cards table { min-width: 0 !important; }
    #root .lf-payment-cards thead { display: none !important; }
    #root .lf-payment-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-payment-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-payment-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-payment-cards td:nth-child(1)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(2)::before { content: "Receipt"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(3)::before { content: "Method"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(4)::before { content: "Reference"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(5)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-payment-cards td:nth-child(6)::before { content: "Receipt PDF"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-6: Matter detail case notes mobile cards */
    #root .lf-matter-notes-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-matter-notes-cards table { min-width: 0 !important; }
    #root .lf-matter-notes-cards thead { display: none !important; }
    #root .lf-matter-notes-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-matter-notes-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-matter-notes-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-matter-notes-cards td:nth-child(1)::before { content: "Note"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-matter-notes-cards td:nth-child(2)::before { content: "Author"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-matter-notes-cards td:nth-child(3)::before { content: "Created"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-3: User Management / Team mobile cards */
    #root .lf-user-cards,
    #root .lf-user-cards * { box-sizing: border-box !important; }
    #root .lf-user-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-user-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-user-cards table,
    #root .lf-user-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-user-cards thead { display: none !important; }
    #root .lf-user-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-user-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-user-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-user-cards tbody td input,
    #root .lf-user-cards tbody td select,
    #root .lf-user-cards tbody td textarea { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-user-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-user-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-user-cards tbody td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-user-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-user-cards td:nth-child(1)::before { content: "Photo"; }
    #root .lf-user-cards td:nth-child(2)::before { content: "Name"; }
    #root .lf-user-cards td:nth-child(3)::before { content: "Email"; }
    #root .lf-user-cards td:nth-child(4)::before { content: "Role"; }
    #root .lf-user-cards td:nth-child(5)::before { content: "Status"; }
    #root .lf-user-cards td:nth-child(6)::before { content: "Client"; }
    #root .lf-user-cards td:nth-child(7)::before { content: "Actions"; }
    /* R15g-4: TimeEntryEditorList mobile cards */
    #root .lf-time-entry-cards,
    #root .lf-time-entry-cards * { box-sizing: border-box !important; }
    #root .lf-time-entry-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-time-entry-cards table,
    #root .lf-time-entry-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-time-entry-cards thead { display: none !important; }
    #root .lf-time-entry-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-time-entry-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-time-entry-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-time-entry-cards tbody td input,
    #root .lf-time-entry-cards tbody td select,
    #root .lf-time-entry-cards tbody td textarea { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-time-entry-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-time-entry-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-time-entry-cards tbody td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-time-entry-cards tbody tr:hover td { background: transparent !important; }
    /* Shared first three columns */
    #root .lf-time-entry-cards td:nth-child(1)::before { content: "Date"; }
    #root .lf-time-entry-cards td:nth-child(2)::before { content: "Description"; }
    #root .lf-time-entry-cards td:nth-child(3)::before { content: "Hours"; }
    /* canViewBilling=true variant (7 columns, default) */
    #root .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(4)::before { content: "Rate"; }
    #root .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(5)::before { content: "Billing class"; }
    #root .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(6)::before { content: "Invoice status"; }
    #root .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(7)::before { content: "Actions"; }
    /* canViewBilling=false variant (6 columns) */
    #root .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(4)::before { content: "Billing class"; }
    #root .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(5)::before { content: "Invoice status"; }
    #root .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(6)::before { content: "Actions"; }
    /* R15g-6-C: Admin reassignment control narrow */
    #root .lf-admin-reassign-control { flex-wrap: wrap; max-width: 100%; min-width: 0; width: 100%; margin-left: 0; gap: 4px; }
    #root .lf-admin-reassign-control select { max-width: 100%; min-width: 0; width: auto; flex: 1 1 auto; }
    #root .lf-admin-reassign-control button { max-width: 100%; min-width: 0; white-space: normal !important; }
    /* R15g-6-C: Matter detail card row containment at 360px */
    #root .lf-matter-detail-workspace .lf-task-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody tr { width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td { max-width: 100% !important; box-sizing: border-box !important; min-width: 0 !important; overflow-wrap: anywhere; }
    #root .lf-matter-detail-workspace .lf-task-cards table,
    #root .lf-matter-detail-workspace .lf-time-entry-cards table,
    #root .lf-matter-detail-workspace .lf-appearance-cards table,
    #root .lf-matter-detail-workspace .lf-invoice-cards table,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards table { min-width: 0 !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(1)::before { content: "Invoice"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(2)::before { content: "Amount"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(3)::before { content: "Paid"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(4)::before { content: "Balance"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(5)::before { content: "Status"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(6)::before { content: "PDF"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(7)::before { content: "Actions"; }
    /* R15g-10: AdvocatePerformance main mobile cards */
    #root .lf-advocate-performance-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-advocate-performance-cards table { min-width: 0 !important; }
    #root .lf-advocate-performance-cards thead { display: none !important; }
    #root .lf-advocate-performance-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-advocate-performance-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-advocate-performance-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-advocate-performance-cards td:nth-child(1)::before { content: "Name"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-performance-cards td:nth-child(2)::before { content: "Active"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-performance-cards td:nth-child(3)::before { content: "Tasks"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-performance-cards td:nth-child(4)::before { content: "Hours"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-performance-cards td:nth-child(5)::before { content: "Revenue"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-performance-cards td:nth-child(6)::before { content: "Court"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-10: AdvocatePerformance detail matters mobile cards */
    #root .lf-advocate-detail-matters-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-advocate-detail-matters-cards table { min-width: 0 !important; }
    #root .lf-advocate-detail-matters-cards thead { display: none !important; }
    #root .lf-advocate-detail-matters-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-advocate-detail-matters-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-advocate-detail-matters-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-advocate-detail-matters-cards td:nth-child(1)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-matters-cards td:nth-child(2)::before { content: "Stage"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-matters-cards td:nth-child(3)::before { content: "Next Court"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-10: AdvocatePerformance detail time mobile cards */
    #root .lf-advocate-detail-time-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-advocate-detail-time-cards table { min-width: 0 !important; }
    #root .lf-advocate-detail-time-cards thead { display: none !important; }
    #root .lf-advocate-detail-time-cards tbody tr { display: block; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-advocate-detail-time-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-advocate-detail-time-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-advocate-detail-time-cards td:nth-child(1)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-time-cards td:nth-child(2)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-time-cards td:nth-child(3)::before { content: "Task"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-time-cards td:nth-child(4)::before { content: "Hours"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-advocate-detail-time-cards td:nth-child(5)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-12: Audit log mobile cards */
    #root .lf-audit-log-cards,
    #root .lf-structured-audit-log-cards,
    #root .lf-audit-log-cards *,
    #root .lf-structured-audit-log-cards * { box-sizing: border-box !important; }
    #root .lf-audit-log-cards,
    #root .lf-structured-audit-log-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-audit-log-cards > div,
    #root .lf-structured-audit-log-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-audit-log-cards table,
    #root .lf-audit-log-cards tbody,
    #root .lf-structured-audit-log-cards table,
    #root .lf-structured-audit-log-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-audit-log-cards thead,
    #root .lf-structured-audit-log-cards thead { display: none !important; }
    #root .lf-audit-log-cards tbody tr,
    #root .lf-structured-audit-log-cards tbody tr { display: block; width: 100%; min-width: 0; max-width: 100%; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-audit-log-cards tbody td,
    #root .lf-structured-audit-log-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; max-width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-audit-log-cards tbody td > *,
    #root .lf-structured-audit-log-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-audit-log-cards tbody td button,
    #root .lf-structured-audit-log-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-audit-log-cards tbody td span,
    #root .lf-structured-audit-log-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-structured-audit-log-cards tbody td pre { width: 100% !important; max-width: 100% !important; min-width: 0 !important; overflow-x: auto !important; }
    #root .lf-audit-log-cards tbody td::before,
    #root .lf-structured-audit-log-cards tbody td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-audit-log-cards tbody tr:hover td,
    #root .lf-structured-audit-log-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-audit-log-cards td:nth-child(1)::before { content: "Date/Time"; }
    #root .lf-audit-log-cards td:nth-child(2)::before { content: "User"; }
    #root .lf-audit-log-cards td:nth-child(3)::before { content: "Role"; }
    #root .lf-audit-log-cards td:nth-child(4)::before { content: "Action"; }
    #root .lf-audit-log-cards td:nth-child(5)::before { content: "Entity Type"; }
    #root .lf-audit-log-cards td:nth-child(6)::before { content: "Entity ID"; }
    #root .lf-audit-log-cards td:nth-child(7)::before { content: "Summary"; }
    #root .lf-structured-audit-log-cards td:nth-child(1)::before { content: "Timestamp"; }
    #root .lf-structured-audit-log-cards td:nth-child(2)::before { content: "Actor"; }
    #root .lf-structured-audit-log-cards td:nth-child(3)::before { content: "Role"; }
    #root .lf-structured-audit-log-cards td:nth-child(4)::before { content: "Action"; }
    #root .lf-structured-audit-log-cards td:nth-child(5)::before { content: "Entity Type"; }
    #root .lf-structured-audit-log-cards td:nth-child(6)::before { content: "Entity ID"; }
    #root .lf-structured-audit-log-cards td:nth-child(7)::before { content: "Matter ID"; }
    #root .lf-structured-audit-log-cards td:nth-child(8)::before { content: "Client ID"; }
    #root .lf-structured-audit-log-cards td:nth-child(9)::before { content: "Metadata"; }
    #root .lf-timer-bubble { display: none !important; }
  }
  @media (min-width: 768px) and (max-width: 900px) {
    /* LOCAL-PILOT: stack the Communications inbox/thread split while the desktop sidebar still reduces the available tablet width. */
    #root .lf-communications-grid { grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-communications-grid > * { min-width: 0 !important; }
    /* R15g-8: Client portal My Matters - stack grid at tablet widths */
    #root .lf-client-matter-grid { grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; }
    /* R15g-6-C: Matter detail tablet cards only */
    #root .lf-matter-grid:has(.lf-matter-detail-workspace) { grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-task-cards,
    #root .lf-matter-detail-workspace .lf-time-entry-cards,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate,
    #root .lf-matter-detail-workspace .lf-appearance-cards,
    #root .lf-matter-detail-workspace .lf-invoice-cards,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards,
    #root .lf-matter-detail-workspace .lf-task-cards *,
    #root .lf-matter-detail-workspace .lf-time-entry-cards *,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate *,
    #root .lf-matter-detail-workspace .lf-appearance-cards *,
    #root .lf-matter-detail-workspace .lf-invoice-cards *,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards * { box-sizing: border-box !important; }
    #root .lf-matter-detail-workspace .lf-task-cards,
    #root .lf-matter-detail-workspace .lf-time-entry-cards,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate,
    #root .lf-matter-detail-workspace .lf-appearance-cards,
    #root .lf-matter-detail-workspace .lf-invoice-cards,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-matter-detail-workspace .lf-task-cards > div,
    #root .lf-matter-detail-workspace .lf-time-entry-cards > div,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate > div,
    #root .lf-matter-detail-workspace .lf-appearance-cards > div,
    #root .lf-matter-detail-workspace .lf-invoice-cards > div,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; width: 100% !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-task-cards table,
    #root .lf-matter-detail-workspace .lf-task-cards tbody,
    #root .lf-matter-detail-workspace .lf-time-entry-cards table,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate table,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody,
    #root .lf-matter-detail-workspace .lf-appearance-cards table,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody,
    #root .lf-matter-detail-workspace .lf-invoice-cards table,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards table,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-task-cards thead,
    #root .lf-matter-detail-workspace .lf-time-entry-cards thead,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate thead,
    #root .lf-matter-detail-workspace .lf-appearance-cards thead,
    #root .lf-matter-detail-workspace .lf-invoice-cards thead,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards thead { display: none !important; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody tr,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody tr,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody tr { display: block; width: 100%; min-width: 0; max-width: 100%; background: #fff; border: 1px solid #DDD8CE; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; max-width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td > *,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td > *,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td > *,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td > *,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td > *,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td input,
    #root .lf-matter-detail-workspace .lf-task-cards tbody td select,
    #root .lf-matter-detail-workspace .lf-task-cards tbody td textarea,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td input,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td select,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td textarea,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td input,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td select,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td textarea { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td button,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td button,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td button,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td button,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td button,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td span,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td span,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td span,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td span,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td span,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody td::before,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody td::before,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody td::before,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody td::before,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody td::before,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-matter-detail-workspace .lf-task-cards tbody tr:hover td,
    #root .lf-matter-detail-workspace .lf-time-entry-cards tbody tr:hover td,
    #root .lf-matter-detail-workspace .lf-time-entry-cards-no-rate tbody tr:hover td,
    #root .lf-matter-detail-workspace .lf-appearance-cards tbody tr:hover td,
    #root .lf-matter-detail-workspace .lf-invoice-cards tbody tr:hover td,
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(1)::before { content: "Task"; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(2)::before { content: "Assignee"; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(3)::before { content: "Due"; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(4)::before { content: "Status"; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(5)::before { content: "Timer"; }
    #root .lf-matter-detail-workspace .lf-task-cards td:nth-child(6)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards td:nth-child(1)::before { content: "Date"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards td:nth-child(2)::before { content: "Description"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards td:nth-child(3)::before { content: "Hours"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(4)::before { content: "Rate"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(5)::before { content: "Billing class"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(6)::before { content: "Invoice status"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards:not(.lf-time-entry-cards-no-rate) td:nth-child(7)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(4)::before { content: "Billing class"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(5)::before { content: "Invoice status"; }
    #root .lf-matter-detail-workspace .lf-time-entry-cards.lf-time-entry-cards-no-rate td:nth-child(6)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(1)::before { content: "Title"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(2)::before { content: "Date"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(3)::before { content: "Time"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(4)::before { content: "Type"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(5)::before { content: "Location"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(6)::before { content: "Virtual Court"; }
    #root .lf-matter-detail-workspace .lf-appearance-cards td:nth-child(7)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(1)::before { content: "Invoice"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(2)::before { content: "Amount"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(3)::before { content: "Paid"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(4)::before { content: "Balance"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(5)::before { content: "Status"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(6)::before { content: "PDF"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(7)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(1)::before { content: "Note"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(2)::before { content: "Author"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(3)::before { content: "Created"; }
  }
  @media (max-width: 480px) {
    #root .lf-court-mode-card { padding: 12px !important; }
    #root .lf-court-mode-stack { gap: 8px !important; }
  }
  /* UI-1: login-only polish — scoped to .lf-login-root */
  .lf-login-root { min-height: 100vh; background: var(--lf-background, #F5F2EB); }
  .lf-login-root .lf-login-brand { position: relative; isolation: isolate; }
  .lf-login-root .lf-login-brand::before {
    content: ""; position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background-image: linear-gradient(rgba(197,151,60,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(197,151,60,.06) 1px, transparent 1px);
    background-size: 48px 48px; opacity: .55;
  }
  .lf-login-root .lf-login-brand::after {
    content: ""; position: absolute; z-index: 0; pointer-events: none;
    top: -120px; right: -120px; width: 360px; height: 360px; border-radius: 50%;
    background: radial-gradient(circle, rgba(197,151,60,.22) 0%, rgba(197,151,60,0) 65%);
  }
  .lf-login-root .lf-login-brand > * { position: relative; z-index: 1; }
  .lf-login-root .lf-login-portal-tab:focus-visible { outline: 2px solid color-mix(in srgb, var(--lf-accent, #C5973C) 50%, transparent); outline-offset: 2px; }
  .lf-login-root .lf-login-input:focus { outline: none; border-color: var(--lf-primary, #112219) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--lf-primary, #112219) 16%, transparent); }
  .lf-login-root .lf-login-submit:not(:disabled):hover { background: color-mix(in srgb, var(--lf-button, var(--lf-primary, #112219)) 88%, #000 12%); }
  .lf-login-root .lf-login-oauth:not(:disabled):hover { background: color-mix(in srgb, var(--lf-accent, #C5973C) 8%, var(--lf-card, #fff)); border-color: var(--lf-primary, #112219); }
  .lf-login-root .lf-login-trust-row { display: flex; flex-wrap: wrap; gap: 14px 18px; justify-content: center; }
  @media (max-width: 900px) {
    .lf-login-root .lf-login-split { grid-template-columns: 1fr !important; }
    .lf-login-root .lf-login-brand { padding: 36px 24px !important; min-height: auto !important; }
    .lf-login-root .lf-login-brand-trust { display: none !important; }
    .lf-login-root .lf-login-card-wrap { padding-top: clamp(28px, 6vh, 56px) !important; }
  }
  @media (max-width: 480px) {
    .lf-login-root .lf-login-brand { padding: 28px 18px !important; }
    .lf-login-root .lf-login-card-wrap { padding: 16px !important; padding-top: clamp(20px, 4vh, 36px) !important; }
    .lf-login-root .lf-login-card-form { padding: 22px 18px !important; }
  }
  @keyframes lfPulse { 0% { opacity: .55; } 50% { opacity: 1; } 100% { opacity: .55; } }
  @keyframes lfSlideIn { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes lfDropIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      transform: none !important;
    }
  }
  @media (min-width: 768px) and (max-width: 900px) { #root .lf-task-split-grid { grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; } }
  @media (max-width: 760px) { #root .lf-dashboard-grid { grid-template-columns: 1fr !important; } }
  table th { text-align: left; padding: 9px 12px; background: color-mix(in srgb, var(--lf-card, #fff) 88%, var(--lf-background, #F3F4F6)); color: var(--lf-card-muted, var(--lf-text-muted, #6B7280)); font-size: 11px; text-transform: uppercase; letter-spacing: 0; font-weight: 700; }
  table td { padding: 10px 12px; border-top: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); color: var(--lf-card-text, var(--lf-text, #1A1A18)); background: var(--lf-card, #fff); vertical-align: middle; }
  table tr:nth-child(even) td { background: color-mix(in srgb, var(--lf-card, #fff) 96%, var(--lf-background, #FAFAFB)); }
  table tbody tr:hover td { background: color-mix(in srgb, var(--lf-accent, #C5973C) 9%, var(--lf-card, #fff)); }
  label > span { color: var(--lf-card-muted, var(--lf-text-muted, #6B7280)); font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .lf-app-shell .profile-tooltip span, body .profile-tooltip span { display: block; color: var(--lf-card-muted, var(--lf-text-muted, #6B6B66)); font-size: 12px; margin-top: 3px; }
  .lf-logo-preview img { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; border: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); }
  @media (max-width: 980px) {
    #root .lf-brand-profile-grid { grid-template-columns: minmax(0,1fr) !important; }
    #root .lf-brand-preview-panel { position: static !important; }
  }
  @media (max-width: 620px) {
    #root .lf-brand-preview-shell { grid-template-columns: minmax(0,1fr) !important; }
    #root .lf-brand-profile-actions > button { flex: 1 1 100%; }
  }
  section h2 { margin: 0; font-size: 14px; font-weight: 700; color: #1A1A18; }
  section h3 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #1A1A18; }
  section p { margin: 4px 0 0; color: #6B6B66; font-size: 12px; }
  /* UI-2: sidebar forest polish */
  #root .lf-desktop-sidebar { scrollbar-width: none; -ms-overflow-style: none; }
  #root .lf-desktop-sidebar::-webkit-scrollbar { width: 0; height: 0; display: none; }
  .lf-nav.is-active::before { content: ''; position: absolute; left: 0; top: 5px; bottom: 5px; width: 3px; background: var(--lf-accent, #C5973C); border-radius: 0 2px 2px 0; }
  .lf-nav.is-active { color: var(--lf-on-sidebar, #fff) !important; }
  /* UI-3: topbar + dashboard polish (scoped) */
  #root .lf-topbar { background: var(--lf-header-bg, #fff); }
  #root .lf-topbar-icon-btn:hover { background: color-mix(in srgb, var(--lf-on-header, #1A1A18) 8%, transparent); color: var(--lf-on-header, #1A1A18); }
  #root .lf-topbar-icon-btn:focus-visible { outline: 2px solid rgba(26,54,40,.25); outline-offset: 1px; }
  #root .lf-topbar-search:focus-within { border-color: #1A3628; box-shadow: 0 0 0 3px rgba(26,54,40,.09); }
  #root .lf-page-title { font-family: 'Playfair Display', Georgia, 'Times New Roman', serif; }
  #root .lf-dash-banner { position: relative; overflow: hidden; }
  #root .lf-dash-banner::after { content: ''; position: absolute; right: -30px; top: -30px; width: 200px; height: 200px; border-radius: 50%; background: rgba(197,151,60,.07); pointer-events: none; }
  #root .lf-dash-banner-amount { font-family: 'Playfair Display', Georgia, 'Times New Roman', serif; }
  #root .lf-dash-stat-card { transition: box-shadow .18s ease, transform .18s ease; }
  #root .lf-dash-stat-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  #root button.lf-dash-stat-card:not(:disabled):hover { transform: translateY(-1px); }
  #root .lf-dash-stat-value { font-family: 'Playfair Display', Georgia, 'Times New Roman', serif; }
  #root .lf-dash-panel { background: var(--lf-card, #fff); color: var(--lf-card-text, var(--lf-text, #1A1A18)); border: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  #root .lf-dash-panel-head { padding: 14px 18px; border-bottom: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  #root .lf-dash-panel-link { background: transparent; border: 0; color: var(--lf-link, #1A3628); font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; opacity: .85; }
  #root .lf-dash-panel-link:hover { opacity: 1; text-decoration: underline; }
  #root .lf-dash-pipeline-row { display: flex; align-items: center; gap: 13px; padding: 9px 18px; border-bottom: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); cursor: pointer; transition: background .15s; background: transparent; color: var(--lf-card-text, var(--lf-text, #1A1A18)); border-left: 0; border-right: 0; border-top: 0; width: 100%; text-align: left; }
  #root .lf-dash-pipeline-row:last-of-type { border-bottom: none; }
  #root .lf-dash-pipeline-row:hover { background: color-mix(in srgb, var(--lf-accent, #C5973C) 12%, var(--lf-card, #fff)); }
  #root .lf-dash-pipeline-track { background: color-mix(in srgb, var(--lf-card-border, #DDD8CE) 70%, transparent); }
  #root .lf-dash-table { width: 100%; border-collapse: collapse; min-width: 0; }
  @media (min-width: 768px) {
    #root .lf-dash-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; color: var(--lf-card-muted, var(--lf-text-muted, #6B7280)); padding: 9px 18px; background: color-mix(in srgb, var(--lf-card, #fff) 88%, var(--lf-background, #F5F2EB)); border-bottom: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); border-top: 0; }
    #root .lf-dash-table td { padding: 11px 18px; font-size: 13px; color: var(--lf-card-text, var(--lf-text, #1A1A18)); border-bottom: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); border-top: 0; background: var(--lf-card, #fff); vertical-align: middle; }
    #root .lf-dash-table tr:last-child td { border-bottom: none; }
    #root .lf-dash-table tr:nth-child(even) td { background: var(--lf-card, #fff); }
    #root .lf-dash-table tbody tr:hover td { background: color-mix(in srgb, var(--lf-accent, #C5973C) 10%, var(--lf-card, #fff)); cursor: default; }
    #root .lf-dash-table tr.lf-dash-today-row td { background: color-mix(in srgb, var(--lf-accent, #C5973C) 8%, var(--lf-card, #fff)); }
    #root .lf-dash-table tr.lf-dash-today-row td:first-child { border-left: 3px solid var(--lf-accent, #C5973C); padding-left: 15px; }
  }
  @media (max-width: 980px) {
    #root .lf-dash-banner { flex-direction: column !important; align-items: flex-start !important; }
    #root .lf-dash-banner-amount { font-size: 24px !important; align-self: flex-start; }
    #root .lf-dashboard-stats { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }
  }
  @media (max-width: 767px) {
    #root .lf-dash-banner { padding: 16px !important; }
    #root .lf-dash-table th, #root .lf-dash-table td { padding-left: 14px; padding-right: 14px; }
    #root .lf-dash-panel-head { padding: 12px 14px; }
    #root .lf-dash-pipeline-row { padding: 9px 14px; }
  }
  /* LOCAL-PILOT-GLOBAL-DOCUMENTS-EXPLORER-92 / GLOBAL-DOCUMENT-ACTIONS-94 / GLOBAL-DOCUMENT-BULK-LIFECYCLE-95 / GLOBAL-DOCUMENT-BULK-VISIBILITY-96 */
  #root .lf-global-documents-cards table { min-width: 1080px; }
  #root .lf-global-documents-selectable table { min-width: 1140px; }
  #root .lf-global-document-actions button:disabled { cursor: not-allowed; opacity: .55; }
  #root .lf-global-document-selection-control { border-radius: 7px; }
  #root .lf-global-document-selection-control:focus-within { outline: 2px solid rgba(197,151,60,.35); outline-offset: 1px; }
  #root .lf-global-document-select-checkbox { width: 18px; height: 18px; min-width: 18px !important; min-height: 18px !important; padding: 0 !important; margin: 0; accent-color: var(--lf-primary, #1A3628); cursor: pointer; }
  #root .lf-global-document-select-checkbox:disabled { cursor: not-allowed; }
  #root .lf-global-documents-selectable tr[data-document-selected="true"] td { background: color-mix(in srgb, var(--lf-accent, #C5973C) 10%, var(--lf-card, #fff)); }
  @media (max-width: 900px) {
    #root .lf-global-documents-filter-grid { grid-template-columns: repeat(2, minmax(140px, 1fr)) !important; }
  }
  @media (max-width: 640px) {
    #root .lf-global-documents-search { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    #root .lf-global-documents-search input { grid-column: 1 / -1; }
    #root .lf-global-documents-search button { width: 100%; min-width: 0; }
    #root .lf-global-documents-filter-grid { grid-template-columns: minmax(0, 1fr) !important; }
    #root .lf-global-documents-cards,
    #root .lf-global-documents-cards * { box-sizing: border-box !important; }
    #root .lf-global-documents-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; }
    #root .lf-global-documents-cards > div { width: 100% !important; max-width: 100% !important; overflow: visible !important; border: 0 !important; border-radius: 0 !important; }
    #root .lf-global-documents-cards table,
    #root .lf-global-documents-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-global-documents-cards thead { display: none !important; }
    #root .lf-global-documents-cards tbody tr { display: block; width: 100%; min-width: 0; margin-bottom: 12px; padding: 12px 14px; background: var(--lf-card, #fff); border: 1px solid var(--lf-card-border, var(--lf-border, #DDD8CE)); border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    #root .lf-global-documents-cards tbody td { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: 0; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-global-documents-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; }
    #root .lf-global-documents-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-global-documents-cards tbody td::before { min-width: 0; color: var(--lf-card-muted, var(--lf-text-muted, #6B7280)); font-size: 10px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(1)::before { content: "Document"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(2)::before { content: "Matter"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(3)::before { content: "Client"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(4)::before { content: "Folder"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(5)::before { content: "Date"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(6)::before { content: "Origin"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(7)::before { content: "Visibility"; }
    #root .lf-global-documents-cards:not(.lf-global-documents-selectable) td:nth-child(8)::before { content: "Actions"; }
    #root .lf-global-documents-selectable td:nth-child(1)::before { content: "Select"; }
    #root .lf-global-documents-selectable td:nth-child(2)::before { content: "Document"; }
    #root .lf-global-documents-selectable td:nth-child(3)::before { content: "Matter"; }
    #root .lf-global-documents-selectable td:nth-child(4)::before { content: "Client"; }
    #root .lf-global-documents-selectable td:nth-child(5)::before { content: "Folder"; }
    #root .lf-global-documents-selectable td:nth-child(6)::before { content: "Date"; }
    #root .lf-global-documents-selectable td:nth-child(7)::before { content: "Origin"; }
    #root .lf-global-documents-selectable td:nth-child(8)::before { content: "Visibility"; }
    #root .lf-global-documents-selectable td:nth-child(9)::before { content: "Actions"; }
    #root .lf-global-documents-selectable tbody tr[data-document-selected="true"] { border-color: color-mix(in srgb, var(--lf-accent, #C5973C) 72%, var(--lf-card-border, #DDD8CE)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lf-accent, #C5973C) 26%, transparent); }
    #root .lf-global-documents-selectable tr[data-document-selected="true"] td { background: transparent; }
    #root .lf-global-document-selection-control { width: 44px !important; min-height: 44px !important; justify-self: start; }
    #root .lf-global-document-actions { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    #root .lf-global-document-actions button { width: 100%; min-width: 0; padding-left: 5px !important; padding-right: 5px !important; white-space: normal; }
    #root .lf-global-document-preview-backdrop { padding: 8px !important; }
    #root .lf-global-document-preview { height: min(94vh, 820px) !important; }
    #root .lf-global-document-action-dialog-backdrop { padding: 8px !important; }
    #root .lf-global-document-action-dialog { max-height: calc(100vh - 16px); overflow-y: auto; }
    #root .lf-global-document-action-dialog > div:last-child { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #root .lf-global-document-action-dialog > div:last-child button { width: 100%; min-width: 0; }
    #root .lf-global-document-bulk-dialog > div:last-child { grid-template-columns: minmax(0, 1fr) !important; }
    #root .lf-global-documents-bulk-toolbar > div:first-child { display: grid !important; grid-template-columns: minmax(0, 1fr); align-items: stretch !important; }
    #root .lf-global-documents-selection-actions,
    #root .lf-global-documents-bulk-actions { display: grid !important; grid-template-columns: minmax(0, 1fr) !important; width: 100%; }
    #root .lf-global-documents-selection-actions button,
    #root .lf-global-documents-bulk-actions button { width: 100%; min-width: 0; }
    #root .lf-global-documents-selection-summary { overflow-wrap: anywhere; }
    #root .lf-global-document-bulk-result { display: grid !important; grid-template-columns: minmax(0, 1fr); align-items: stretch !important; width: 100%; }
    #root .lf-global-document-bulk-result button { width: 100%; min-width: 0; }
  }
  /* UI-5C: Deadline Center guidance card hover */
  .lf-deadline-guidance-card:hover { box-shadow: 0 4px 14px rgba(15,27,51,.10) !important; transform: translateY(-1px); }
  #root .lf-timer-bubble:hover { transform: translateY(-2px); }
`}</style>; }

export const styles = {
  shell: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '224px minmax(0,1fr)', background: 'var(--lf-background, #F5F2EB)', color: 'var(--lf-text, #1A1A18)', fontFamily: 'Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 13 },
  sidebar: { position: 'sticky', top: 0, minHeight: '100vh', maxHeight: '100vh', background: 'var(--lf-sidebar, #112219)', color: 'var(--lf-sidebar-text, #fff)', padding: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', boxShadow: '1px 0 0 rgba(255,255,255,.05)' },
  brandPanel: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 14px', borderBottom: '1px solid rgba(255,255,255,.08)' },
  logo: { width: 34, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--lf-accent, var(--lf-button, #C5973C))', color: 'var(--lf-button-text, #fff)', fontWeight: 900, fontSize: 15, boxShadow: '0 8px 18px rgba(197,151,60,.20)', overflow: 'hidden', flexShrink: 0 }, logoImage: { width: '100%', height: '100%', objectFit: 'cover' },
  brand: { fontSize: 13.5, fontWeight: 700, letterSpacing: 0, color: 'var(--lf-on-sidebar, #fff)', lineHeight: 1.2 }, brandSub: { fontSize: 10, color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 48%, transparent)', marginTop: 3, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 600 }, sideSectionLabel: { color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 42%, transparent)', fontSize: 9, fontWeight: 700, letterSpacing: 1.8, textTransform: 'uppercase', padding: '10px 16px 4px' },
  navList: { display: 'grid', gap: 0, padding: '8px 0' }, navGroup: { display: 'grid', gap: 0 }, navGroupButton: { border: 0, background: 'transparent', color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 42%, transparent)', borderRadius: 0, padding: '10px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontSize: 9, fontWeight: 800, letterSpacing: 1.8, textTransform: 'uppercase', width: '100%', textAlign: 'left' },   navGroupChevron: { color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 28%, transparent)', fontSize: 9, fontWeight: 700 }, navGroupItems: { display: 'grid', gap: 0 }, navItem: { position: 'relative', border: 0, background: 'transparent', color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 58%, transparent)', borderRadius: 0, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', fontWeight: 600, fontSize: 13, textAlign: 'left', width: '100%' }, navActive: { color: 'var(--lf-on-sidebar, #fff)' }, navNumber: { width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'inherit', flexShrink: 0 },

  timerCard: { marginTop: 'auto', marginInline: 12, marginBottom: 10, padding: '11px 13px', borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', display: 'grid', gap: 3 }, timerTop: { color: 'rgba(255,255,255,.7)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }, liveDot: { width: 7, height: 7, borderRadius: 999, background: '#22C55E', boxShadow: '0 0 0 3px rgba(34,197,94,.13)' },
  userCard: { display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: 10, alignItems: 'center', padding: '12px 16px 16px', borderTop: '1px solid color-mix(in srgb, var(--lf-on-sidebar, #fff) 12%, transparent)' }, avatar: { width: 30, height: 30, borderRadius: 999, background: 'var(--lf-accent, var(--lf-button, #C5973C))', color: 'var(--lf-on-accent, var(--lf-button-text, #fff))', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12, flexShrink: 0, overflow: 'hidden' }, avatarImg: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 999, display: 'block' }, userName: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--lf-on-sidebar, #fff)' }, userRole: { color: 'color-mix(in srgb, var(--lf-on-sidebar, #fff) 44%, transparent)', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700, marginTop: 2 }, logout: { border: '1px solid color-mix(in srgb, var(--lf-on-sidebar, #fff) 18%, transparent)', color: 'var(--lf-on-sidebar, #fff)', background: 'transparent', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12 },
  main: { minWidth: 0, display: 'flex', flexDirection: 'column' }, topbar: { display: 'flex', alignItems: 'center', gap: 12, height: 54, padding: '0 28px', background: 'var(--lf-header-bg, #FFFFFF)', color: 'var(--lf-on-header, var(--lf-header-text, #1A1A18))', borderBottom: '1px solid var(--lf-border, #DDD8CE)', position: 'sticky', top: 0, zIndex: 100, flexShrink: 0 }, topbarTitle: { display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }, mobileMenuButton: { display: 'none', minWidth: 42, minHeight: 38, border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 8, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A3628)', fontWeight: 700, cursor: 'pointer', alignItems: 'center', justifyContent: 'center', padding: '8px 10px', flexShrink: 0 }, eyebrow: { color: 'var(--lf-accent, #C5973C)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }, title: { margin: '2px 0 0', fontSize: 20, fontWeight: 700, lineHeight: 1.2 }, subtitle: { margin: '5px 0 0', color: 'var(--lf-text-muted, #6B6B66)', maxWidth: 680 }, topActions: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }, search: { width: 260, border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: '7px 11px', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', fontSize: 13 },
  topbarSearch: { flex: '1 1 auto', maxWidth: 400, minWidth: 0, position: 'relative', display: 'flex', alignItems: 'center', gap: 9, background: 'var(--lf-card, #F5F2EB)', border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 7, padding: '7px 13px', cursor: 'text', transition: 'border-color .15s ease, box-shadow .15s ease' }, topbarSearchIcon: { color: 'var(--lf-card-muted, var(--lf-text-muted, #6B7280))', flexShrink: 0, display: 'inline-flex' }, topbarSearchInput: { flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', minWidth: 0, padding: 0, fontFamily: 'inherit' }, topbarKbd: { fontSize: 10, color: 'var(--lf-card-muted, #6B7280)', border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace', whiteSpace: 'nowrap', flexShrink: 0 }, iconButton: { width: 34, height: 34, minWidth: 34, minHeight: 34, border: '1px solid transparent', borderRadius: 7, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'color-mix(in srgb, var(--lf-on-header, #6B7280) 68%, transparent)', position: 'relative', padding: 0, flexShrink: 0 }, iconBadgeDot: { position: 'absolute', top: 6, right: 7, width: 7, height: 7, borderRadius: '50%', background: 'var(--lf-danger, #B91C1C)', border: '1.5px solid var(--lf-card, #fff)', pointerEvents: 'none' },
  pageInner: { padding: '24px 28px 124px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, flex: 1 }, pageHeader: { display: 'grid', gap: 3, marginBottom: 4 }, pageCrumb: { fontSize: 10, color: 'var(--lf-text-muted, #6B7280)', textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 600 }, pageTitle: { margin: 0, fontSize: 24, fontWeight: 600, color: 'var(--lf-text, #1A1A18)', lineHeight: 1.2, letterSpacing: -.2 }, pageSub: { margin: '2px 0 0', fontSize: 13, color: 'var(--lf-text-muted, #6B7280)', maxWidth: 720, lineHeight: 1.5 },
  dashBanner: { background: 'var(--lf-primary, #1A3628)', borderRadius: 10, padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 14, color: 'var(--lf-on-primary, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }, dashBannerIcon: { width: 42, height: 42, background: 'color-mix(in srgb, var(--lf-accent, #C5973C) 22%, transparent)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--lf-accent, #C5973C)', flexShrink: 0, position: 'relative', zIndex: 1 }, dashBannerText: { flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }, dashBannerLabel: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.6, color: 'color-mix(in srgb, var(--lf-on-primary, #fff) 50%, transparent)', marginBottom: 3, fontWeight: 600 }, dashBannerSum: { fontSize: 14, color: 'color-mix(in srgb, var(--lf-on-primary, #fff) 84%, transparent)', lineHeight: 1.5 }, dashBannerSumStrong: { color: 'var(--lf-on-primary, #fff)', fontWeight: 600 }, dashBannerAmount: { fontSize: 27, fontWeight: 700, color: 'var(--lf-accent, #C5973C)', whiteSpace: 'nowrap', position: 'relative', zIndex: 1, letterSpacing: -.3 },
  dashAlert: { display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px', borderRadius: 7, borderLeft: '3px solid #C5973C', background: '#FEF5E4', color: '#3D3D3A', fontSize: 13 }, dashAlertIcon: { color: '#C5973C', flexShrink: 0, display: 'inline-flex' }, dashAlertText: { flex: 1, minWidth: 0 }, dashAlertClose: { marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: '#6B7280', padding: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  dashStatsGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }, dashStatCard: { position: 'relative', overflow: 'hidden', background: 'var(--lf-card, #fff)', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 10, padding: '16px 18px', display: 'grid', gap: 0, font: 'inherit', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', textAlign: 'left', width: '100%' }, dashStatTopBar: { position: 'absolute', top: 0, left: 0, right: 0, height: 2.5, borderRadius: '10px 10px 0 0' }, dashStatHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }, dashStatLabel: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B7280))', fontWeight: 600 }, dashStatIcon: { width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }, dashStatValue: { fontSize: 29, fontWeight: 600, color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', lineHeight: 1, letterSpacing: -.5 }, dashStatValueSm: { fontSize: 20 }, dashStatNote: { fontSize: 11, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B7280))', marginTop: 4 },
  dashPanelHeadTitle: { fontSize: 13, fontWeight: 600, color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', margin: 0 }, dashPanelHeadSub: { fontSize: 11.5, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B7280))', margin: '1px 0 0' }, dashPipelineLabel: { width: 96, fontSize: 12.5, color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', flexShrink: 0 }, dashPipelineTrack: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden', background: 'color-mix(in srgb, var(--lf-card-border, #DDD8CE) 80%, transparent)' }, dashPipelineFill: { height: '100%', background: 'var(--lf-accent, #C5973C)', borderRadius: 3 }, dashPipelineCount: { width: 24, fontSize: 12, fontWeight: 600, color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', textAlign: 'right', flexShrink: 0 }, dashPanelBody: { padding: '8px 0' }, dashPanelEmpty: { padding: 24, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B7280))', textAlign: 'center', fontSize: 13 },
  pageStack: { display: 'grid', gap: 16 },   heroCard: { borderRadius: 10, background: 'linear-gradient(135deg, var(--lf-primary, #112219), var(--lf-sidebar, #1A3628))', color: 'var(--lf-on-primary, #fff)', padding: 24, display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'end', boxShadow: theme.shadow }, heroKicker: { color: 'var(--lf-accent, var(--lf-button, #C5973C))', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }, heroFigure: { fontSize: 24, fontWeight: 700, color: 'var(--lf-accent, var(--lf-button, #C5973C))' },
  warningPanel: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #FDE68A', background: theme.amberBg, color: theme.amber, boxShadow: theme.shadow }, warningIcon: { width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: '#FDE68A', fontWeight: 900 }, 
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }, stat: { position: 'relative', overflow: 'hidden', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderLeft: '4px solid', borderRadius: 10, padding: 16, boxShadow: theme.shadow, display: 'grid', gap: 6 },
  splitGrid: { display: 'grid', gridTemplateColumns: 'minmax(260px,.72fr) minmax(0,1.28fr)', gap: 16 }, dashboardGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }, matterGrid: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16 },
  card: { background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 10, padding: '18px 20px', boxShadow: theme.shadow, minWidth: 0, transition: 'box-shadow .16s ease' }, cardHead: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12, alignItems: 'end' }, field: { display: 'grid', gap: 5 }, input: { width: '100%', border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: '7px 11px', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', fontSize: 13 }, colorInput: { width: '100%', height: 36, border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: 4, background: 'var(--lf-card, #fff)' }, primaryButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: 'var(--lf-primary, #1A3628)', color: 'var(--lf-on-primary, #fff)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, goldButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: 'var(--lf-accent, #C5973C)', color: 'var(--lf-on-accent, #1A1A18)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, dangerButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: 'var(--lf-danger, #B91C1C)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, ghostButton: { border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: '7px 16px', background: 'var(--lf-card, #fff)', color: 'var(--lf-link, var(--lf-primary, #1A3628))', fontWeight: 700, cursor: 'pointer', fontSize: 13, textDecoration: 'none' }, actionGroup: { display: 'flex', flexWrap: 'wrap', gap: 6 }, actionMenuWrap: { position: 'relative', display: 'inline-flex', justifyContent: 'flex-end' }, actionMenuButton: { width: 30, height: 28, border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, background: 'var(--lf-card, #fff)', color: 'var(--lf-link, var(--lf-primary, #1A3628))', fontWeight: 900, cursor: 'pointer', lineHeight: 1 }, actionMenu: { position: 'fixed', zIndex: 2600, minWidth: 154, display: 'grid', gap: 2, padding: 6, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8, boxShadow: theme.shadowLift, animation: 'lfDropIn .14s ease-out' }, actionMenuItem: { width: '100%', border: 0, borderRadius: 6, padding: '8px 10px', background: 'transparent', color: 'var(--lf-card-text, var(--lf-text, #1A1A18))', cursor: 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'left' }, actionMenuItemDanger: { color: theme.red, background: theme.redBg }, tinyButton: { border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: '4px 10px', background: 'var(--lf-card, #fff)', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--lf-link, var(--lf-primary, #1A3628))' }, dangerTinyButton: { border: '1px solid #FECACA', borderRadius: 6, padding: '4px 10px', background: theme.redBg, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: theme.red },
  tableWrap: { overflowX: 'auto', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }, badge: { display: 'inline-flex', padding: '4px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }, link: { color: 'var(--lf-link, #1A3628)', fontWeight: 700, textDecoration: 'none' }, meetingLink: { color: 'var(--lf-link, #1A3628)', fontWeight: 700, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }, videoBadge: { width: 22, height: 22, borderRadius: 6, display: 'inline-grid', placeItems: 'center', background: theme.blueBg, color: theme.blue, fontSize: 10, fontWeight: 900 }, joinButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, padding: '5px 10px', background: theme.green, color: '#fff', fontWeight: 800, fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap', boxShadow: '0 6px 14px rgba(4,120,87,.18)' }, mutedText: { color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))' }, tableSelect: { border: '1px solid var(--lf-border, #DDD8CE)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)' },
  pipelineRow: { display: 'grid', gridTemplateColumns: '116px 1fr 30px', gap: 10, alignItems: 'center', marginBottom: 10 }, pipelineTrack: { height: 8, background: '#EEF2F7', borderRadius: 999, overflow: 'hidden' }, pipelineFill: { height: '100%', background: theme.gold, borderRadius: 999 },
  matterButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderLeft: '3px solid transparent', borderBottom: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', padding: '12px 10px', cursor: 'pointer', borderRadius: 6 }, matterActive: { background: 'color-mix(in srgb, var(--lf-accent, #C5973C) 10%, var(--lf-card, #F5F2EB))', borderLeft: '3px solid var(--lf-accent, #C5973C)' }, detailStack: { display: 'grid', gap: 16, minWidth: 0 }, chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))' }, tabList: { display: 'flex', gap: 4, borderBottom: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))' }, tabButton: { border: 0, borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))', padding: '8px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }, tabActive: { color: 'var(--lf-link, #1A3628)', borderBottom: '2px solid var(--lf-accent, #C5973C)' }, assistantPanel: { display: 'grid', gap: 12 }, assistantIntro: { display: 'grid', gap: 4, padding: 14, borderRadius: 10, background: 'color-mix(in srgb, var(--lf-card, #fff) 90%, var(--lf-background, #F5F2EB))', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', color: 'var(--lf-card-muted, #6B6B66)' }, suggestionList: { display: 'grid', gap: 10 }, suggestionItem: { display: 'grid', gridTemplateColumns: '28px 1fr', gap: 10, alignItems: 'start', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', boxShadow: theme.shadow, lineHeight: 1.5 }, suggestionWarning: { background: theme.amberBg, borderColor: '#FDE68A', color: theme.amber }, suggestionGood: { background: theme.greenBg, borderColor: '#A7F3D0', color: theme.green }, suggestionIcon: { width: 28, height: 28, display: 'grid', placeItems: 'center', fontSize: 16 }, sub: { borderTop: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', paddingTop: 16 }, noteForm: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 12 }, file: { marginBottom: 12, fontSize: 12 }, hoverName: { color: 'var(--lf-link, #1A3628)', fontWeight: 800, cursor: 'help' },
  empty: { minHeight: 136, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))', gap: 6, padding: 18 }, emptyIcon: { width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--lf-card, #fff) 86%, var(--lf-background, #F3F4F6))', color: 'var(--lf-link, #1A3628)', fontWeight: 800 }, skeletonGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }, skeleton: { height: 120, borderRadius: 10, background: 'var(--lf-card, #fff)', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', boxShadow: theme.shadow, padding: 16, display: 'grid', gap: 10, alignContent: 'start' }, skeletonLineLarge: { height: 18, width: '55%', borderRadius: 6, background: 'color-mix(in srgb, var(--lf-card-border, #DDD8CE) 82%, transparent)', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLine: { height: 12, width: '80%', borderRadius: 6, background: 'color-mix(in srgb, var(--lf-card-border, #EEF2F7) 64%, transparent)', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLineShort: { height: 12, width: '42%', borderRadius: 6, background: 'color-mix(in srgb, var(--lf-card-border, #EEF2F7) 64%, transparent)', animation: 'lfPulse 1.4s ease-in-out infinite' },
  toast: { position: 'fixed', top: 22, right: 22, zIndex: 2000, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', minWidth: 300, maxWidth: 420, padding: '12px 14px', borderRadius: 10, boxShadow: theme.shadowLift, border: '1px solid', animation: 'lfSlideIn .18s ease-out' }, toastClose: { border: 0, background: 'transparent', color: 'inherit', fontWeight: 900, cursor: 'pointer', fontSize: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 4 }, mobileDrawerLayer: { position: 'fixed', inset: 0, zIndex: 2800 }, mobileBackdrop: { position: 'absolute', inset: 0, border: 0, padding: 0, background: 'rgba(8,18,37,.48)', cursor: 'pointer' }, mobileDrawer: { position: 'absolute', top: 0, left: 0, bottom: 0, width: 304, maxWidth: 'calc(100vw - 44px)', background: 'var(--lf-sidebar, #112219)', color: 'var(--lf-on-sidebar, var(--lf-sidebar-text, #fff))', padding: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', boxShadow: '18px 0 42px rgba(8,18,37,.32)' }, mobileDrawerHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 16px 12px', borderBottom: '1px solid color-mix(in srgb, var(--lf-on-sidebar, #fff) 12%, transparent)' }, mobileCloseButton: { minWidth: 38, minHeight: 38, border: '1px solid color-mix(in srgb, var(--lf-on-sidebar, #fff) 18%, transparent)', borderRadius: 8, background: 'transparent', color: 'var(--lf-on-sidebar, #fff)', cursor: 'pointer', fontWeight: 900, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, modalBackdrop: { position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,27,51,.28)', backdropFilter: 'blur(4px)' }, modalCard: { width: 420, maxWidth: '100%', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 10, boxShadow: theme.shadowLift, padding: 18 }, modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }, modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }, alert: { borderRadius: 8, padding: 12, background: theme.blueBg, color: theme.blue, fontWeight: 700 }, alertDanger: { background: theme.redBg, color: theme.red },
  loginShell: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(135deg, #F5F2EB, #EDE8DC)', color: '#fff' }, loginEditorial: { display: 'none' }, loginBadge: { display: 'none' }, loginMetricRow: { display: 'none' }, loginCard: { width: 410, maxWidth: 'calc(100vw - 32px)', color: theme.ink, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 28, boxShadow: theme.shadowLift }, loginLogo: { width: 48, height: 48, borderRadius: 10, background: 'var(--lf-accent, #C5973C)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, marginBottom: 12, overflow: 'hidden', fontSize: 22 }, loginModeSwitch: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 4, background: '#F3F4F6', borderRadius: 8, margin: '14px 0' }, loginModeButton: { border: 0, borderRadius: 6, padding: '7px 10px', background: 'transparent', color: theme.muted, fontWeight: 800, cursor: 'pointer', fontSize: 12 }, loginModeActive: { background: '#fff', color: 'var(--lf-primary, #1A3628)', boxShadow: theme.shadow }, loginHint: { marginTop: 12, color: theme.muted, fontSize: 12 },
loginSplit: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '54fr 46fr', fontFamily: 'Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 13 },
loginBrand: { background: 'var(--lf-primary, #112219)', color: '#fff', display: 'grid', placeItems: 'center', padding: 'clamp(40px, 6vw, 72px)', position: 'relative', overflow: 'hidden' },
loginBrandLogo: { width: 60, height: 60, borderRadius: 14, background: 'linear-gradient(135deg, #E2BB67 0%, var(--lf-accent, #C5973C) 55%, #B98B35 100%)', display: 'grid', placeItems: 'center', margin: '0 auto', color: '#fff', overflow: 'hidden', boxShadow: '0 10px 26px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.18)' },
loginBrandName: { margin: 0, fontSize: 34, fontWeight: 600, letterSpacing: -.2, fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif", color: '#fff' },
loginBrandType: { margin: '8px 0 0', fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--lf-accent, #C5973C)' },
loginBrandRule: { width: 56, height: 2, background: 'var(--lf-accent, #C5973C)', borderRadius: 2, margin: '14px auto 0' },
loginBrandTagline: { margin: '18px 0 0', fontSize: 14, color: 'rgba(255,255,255,.72)', lineHeight: 1.65, maxWidth: 440 },
loginBrandFeatures: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
loginFeatureItem: { padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.85)', fontSize: 13, fontWeight: 600, textAlign: 'center' },
loginTrustRow: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '14px 22px' },
loginTrustItem: { display: 'inline-flex', alignItems: 'center', gap: 8, color: 'rgba(255,255,255,.8)', fontSize: 12, fontWeight: 600, letterSpacing: .2 },
loginTrustIcon: { width: 28, height: 28, borderRadius: 8, display: 'inline-grid', placeItems: 'center', background: 'rgba(197,151,60,.12)', color: 'var(--lf-accent, #C5973C)', border: '1px solid rgba(197,151,60,.28)' },
loginBrandDivider: { height: 1, background: 'rgba(255,255,255,.1)', marginBottom: 16 },
loginBrandFooter: { margin: 0, fontSize: 12, color: 'rgba(255,255,255,.45)', textAlign: 'center', lineHeight: 1.5 },
loginCardWrap: { display: 'grid', alignItems: 'start', justifyItems: 'center', padding: 'clamp(24px, 5vw, 56px)', paddingTop: 'clamp(56px, 12vh, 120px)', background: 'var(--lf-background, #F5F2EB)' },
loginCardForm: { width: '100%', maxWidth: 360, color: 'var(--lf-card-text, #1A1A18)', background: 'var(--lf-card, #fff)', border: '1px solid var(--lf-card-border, #E8E2D6)', borderRadius: 14, padding: '32px 30px', boxShadow: '0 1px 2px rgba(17,34,25,.04), 0 18px 40px rgba(17,34,25,.06)' },
loginCardTitle: { margin: 0, fontSize: 27, fontWeight: 600, color: 'var(--lf-card-text, #1A1A18)', fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif", letterSpacing: -.2, lineHeight: 1.15 },
portalTabs: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, background: 'color-mix(in srgb, var(--lf-accent, #C5973C) 10%, var(--lf-background, #F5F2EB))', border: '1px solid var(--lf-card-border, #E8E2D6)', borderRadius: 10 },
portalTab: { border: 0, borderRadius: 7, padding: '9px 12px', background: 'transparent', color: 'var(--lf-card-muted, #5B5346)', fontWeight: 700, cursor: 'pointer', fontSize: 12.5, letterSpacing: .2, transition: 'background .16s ease, color .16s ease, box-shadow .16s ease' },
portalTabActive: { background: 'var(--lf-card, #fff)', color: 'var(--lf-primary, #112219)', boxShadow: '0 1px 2px color-mix(in srgb, var(--lf-primary, #112219) 6%, transparent), 0 4px 12px color-mix(in srgb, var(--lf-primary, #112219) 8%, transparent)' },
loginField: { display: 'grid', gap: 6 },
loginLabel: { color: '#5B5346', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2 },
loginInput: { width: '100%', border: '1px solid var(--lf-card-border, #E8E2D6)', borderRadius: 8, padding: '10px 12px', background: 'var(--lf-card, #fff)', fontSize: 13.5, color: 'var(--lf-card-text, #1A1A18)' },
loginPrimaryButton: { border: 0, borderRadius: 9, padding: '12px 16px', background: 'var(--lf-button, var(--lf-primary, #112219))', color: 'var(--lf-button-text, var(--lf-on-primary, #fff))', fontWeight: 700, cursor: 'pointer', fontSize: 13.5, letterSpacing: .3, boxShadow: '0 8px 18px color-mix(in srgb, var(--lf-primary, #112219) 18%, transparent)' },
loginOauthButton: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '9px 14px', fontSize: 13, border: '1px solid var(--lf-card-border, #E8E2D6)', borderRadius: 8, cursor: 'pointer', background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', fontWeight: 600, transition: 'background .16s ease, border-color .16s ease' },
loginOauthIcon: { width: 16, height: 16, display: 'inline-flex' },
loginInstallNote: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px dashed var(--lf-card-border, #E8E2D6)', background: 'color-mix(in srgb, var(--lf-accent, #C5973C) 8%, var(--lf-card, #fff))', fontSize: 12, color: 'var(--lf-card-muted, #5B5346)' },
loginInstallActionButton: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--lf-primary, #112219)', background: 'transparent', color: 'var(--lf-primary, #112219)', fontSize: 12, cursor: 'pointer', fontWeight: 700 },
loginInstallDismiss: { padding: '4px 6px', borderRadius: 4, border: 'none', background: 'transparent', color: '#A8A091', fontSize: 14, cursor: 'pointer', lineHeight: 1 },
loginDemoHint: { marginTop: 12, color: '#9C9384', fontSize: 11.5, textAlign: 'center', letterSpacing: .2 },
  logoPreview: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }, formHelper: { color: 'var(--lf-card-muted, var(--lf-text-muted, #6B6B66))', fontSize: 12, lineHeight: 1.4, alignSelf: 'center' }, clientShell: { minHeight: '100vh', background: 'var(--lf-background, #F5F2EB)', color: 'var(--lf-text, #1A1A18)' }, clientHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '16px 24px', background: 'var(--lf-header-bg, var(--lf-card, #fff))', color: 'var(--lf-on-header, var(--lf-header-text, #1A1A18))', borderBottom: '1px solid var(--lf-border, #DDD8CE)', boxShadow: theme.shadow }, clientBrand: { display: 'flex', alignItems: 'center', gap: 10 }, clientActions: { display: 'flex', alignItems: 'center', gap: 8 }, clientMain: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16, padding: 24 }, clientMatterList: { minWidth: 0 }, clientStatusGrid: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }, clientDescription: { color: 'var(--lf-text-muted, #6B6B66)', marginTop: 12 }, profileTooltip: { position: 'fixed', zIndex: 5000, pointerEvents: 'none', width: 260, display: 'grid', gridTemplateColumns: '42px 1fr', gap: 10, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 10, padding: 12, boxShadow: theme.shadowLift }, tooltipAvatar: { width: 42, height: 42, borderRadius: 10, background: 'var(--lf-primary, #1A3628)', color: 'var(--lf-on-primary, #fff)', display: 'grid', placeItems: 'center', fontWeight: 900 },
  noticeAttachmentPreview: { gridColumn: '1 / -1', display: 'grid', gap: 8, padding: 10, border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8, background: 'color-mix(in srgb, var(--lf-card, #fff) 88%, var(--lf-background, #F5F2EB))' }, noticeAttachmentPreviewItem: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '8px 10px', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8, background: 'var(--lf-card, #fff)' }, noticeAttachmentSummary: { display: 'flex', flexWrap: 'wrap', gap: 6 }, noticeList: { display: 'grid', gap: 12 }, noticeItem: { display: 'grid', gap: 10, padding: 14, border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8, background: 'var(--lf-card, #fff)', color: 'var(--lf-card-text, #1A1A18)' }, noticeItemHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, noticeTitle: { margin: 0, fontSize: 15, color: 'var(--lf-card-text, #1A1A18)', lineHeight: 1.25 }, noticeBody: { margin: 0, color: 'var(--lf-card-text, #1A1A18)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }, noticeFileGrid: { display: 'grid', gap: 8 }, noticeFileLink: { display: 'grid', gridTemplateColumns: '42px minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '9px 10px', border: '1px solid var(--lf-card-border, var(--lf-border, #DDD8CE))', borderRadius: 8, background: 'color-mix(in srgb, var(--lf-card, #fff) 88%, var(--lf-background, #F5F2EB))', color: 'var(--lf-link, #1A3628)', textDecoration: 'none', fontWeight: 700 }, noticeFileIcon: { width: 42, minHeight: 28, borderRadius: 6, display: 'grid', placeItems: 'center', background: theme.blueBg, color: theme.blue, fontSize: 10, fontWeight: 900 },
  timerBubble: { position: 'fixed', bottom: 24, right: 24, zIndex: 500, display: 'flex', alignItems: 'center', gap: 13, background: 'var(--lf-sidebar, #112219)', border: '1px solid color-mix(in srgb, var(--lf-on-sidebar, #fff) 14%, transparent)', color: 'var(--lf-on-sidebar, #fff)', borderRadius: 12, padding: '11px 18px', boxShadow: '0 8px 28px rgba(0,0,0,.25)', cursor: 'pointer', fontSize: 12, transition: 'transform .2s ease', textAlign: 'left', fontFamily: 'inherit' },
};

const THEME_CSS_MAP = {
  primaryColor: '--lf-primary',
  accentColor: '--lf-accent',
  backgroundColor: '--lf-background',
  surfaceColor: '--lf-surface',
  textColor: '--lf-text',
  textSecondaryColor: '--lf-text-muted',
  cardTextColor: '--lf-card-text',
  cardMutedColor: '--lf-card-muted',
  sidebarColor: '--lf-sidebar',
  sidebarTextColor: '--lf-sidebar-text',
  onSidebarColor: '--lf-on-sidebar',
  buttonColor: '--lf-button',
  buttonTextColor: '--lf-button-text',
  onButtonColor: '--lf-on-button',
  borderColor: '--lf-border',
  linkColor: '--lf-link',
  onPrimaryColor: '--lf-on-primary',
  onAccentColor: '--lf-on-accent',
  successColor: '--lf-success',
  warningColor: '--lf-warning',
  errorColor: '--lf-danger',
  infoColor: '--lf-info',
  cardColor: '--lf-card',
  cardBorderColor: '--lf-card-border',
  headerColor: '--lf-header-bg',
  headerTextColor: '--lf-header-text',
  onHeaderColor: '--lf-on-header',
};



export function applyFirmTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const resolved = resolveReadableTheme(theme);
  const targets = [document.documentElement, document.querySelector('.lf-app-shell')].filter(Boolean);
  Object.entries(THEME_CSS_MAP).forEach(([key, cssVar]) => {
    if (resolved[key]) targets.forEach(target => target.style.setProperty(cssVar, resolved[key]));
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lexflow:theme-preview', { detail: { theme: resolved } }));
  }
}

export function clearFirmTheme() {
  const targets = [document.documentElement, document.querySelector('.lf-app-shell')].filter(Boolean);
  Object.values(THEME_CSS_MAP).forEach(cssVar => targets.forEach(target => target.style.removeProperty(cssVar)));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lexflow:theme-preview', { detail: { theme: null } }));
  }
}

export async function loadAndApplyFirmTheme() {
  try {
    const { api } = await import('./lib/apiClient.js');
    const data = await api('/firm-settings/theme');
    if (data?.theme) applyFirmTheme(data.theme);
    else clearFirmTheme();
  } catch {
    // Keep default theme if fetch fails
  }
}
