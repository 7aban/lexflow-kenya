export const theme = {
  navy900: '#081225',
  navy800: '#0F1B33',
  navy700: '#162744',
  navy600: '#1B3A5C',
  gold: '#D4A34A',
  goldDark: '#B98B35',
  ink: '#101827',
  muted: '#697386',
  line: '#E5E7EB',
  paper: '#FFFFFF',
  wash: '#F5F7FA',
  green: '#047857',
  greenBg: '#ECFDF5',
  red: '#B91C1C',
  redBg: '#FEF2F2',
  amber: '#B45309',
  amberBg: '#FFFBEB',
  blue: '#1D4ED8',
  blueBg: '#EFF6FF',
  shadow: '0 1px 3px rgba(0,0,0,0.08)',
  shadowLift: '0 14px 32px rgba(15,27,51,0.12)',
};

export const defaultFirmSettings = { name: 'LexFlow Kenya', logo: '', primaryColor: '#0F1B33', accentColor: '#D4A34A', websiteURL: '', email: 'accounts@lexflow.co.ke', phone: '+254 700 123456', address: 'Nairobi, Kenya', advocateBillingVisibility: 1 };

export function StyleTag() { return <style>{`
  * { box-sizing: border-box; }
  body { margin: 0; background: #F5F7FA; font: 400 13px/1.45 Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif; color: #101827; }
  button, input, select, textarea { font: inherit; }
  button { transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .16s ease; }
  button:not(:disabled):hover { transform: translateY(-1px); }
  button:disabled { opacity: .5; cursor: not-allowed !important; transform: none !important; }
  input:focus, select:focus, textarea:focus { outline: 2px solid rgba(212,163,74,.25); border-color: #D4A34A !important; }
  section:hover { box-shadow: 0 8px 22px rgba(15,27,51,.08); }
  .lf-nav:hover, .lf-nav-group:hover { background: rgba(255,255,255,.08) !important; color: #fff !important; }
  .lf-resource-link:hover { background: rgba(255,255,255,.08) !important; color: #fff !important; }
  #root .lf-mobile-only, #root .lf-mobile-drawer-layer { display: none !important; }
  @media (max-width: 980px) {
    #root main { padding: 16px; }
    #root header { align-items: stretch; flex-direction: column; }
    #root .lf-top-actions { flex-wrap: wrap; }
    #root header input { width: 100% !important; }
  }
  @media (max-width: 767px) {
    #root .lf-app-shell { grid-template-columns: 1fr; }
    #root .lf-desktop-sidebar { display: none !important; }
    #root .lf-mobile-only { display: inline-flex !important; }
    #root .lf-mobile-drawer-layer { display: block !important; }
    #root .lf-topbar-title { align-items: flex-start; }
    #root .lf-top-actions { width: 100%; align-items: stretch; }
    #root .lf-top-actions > * { max-width: 100%; }
    #root .lf-mobile-search { flex: 1 1 100%; min-width: 0; }
    #root .lf-mobile-search input { width: 100% !important; }
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
    #root .lf-court-dates-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-deadline-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-deadline-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-deadline-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-deadline-cards td:nth-child(1)::before { content: "Due"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(2)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(3)::before { content: "Deadline"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(4)::before { content: "Matter / Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(5)::before { content: "Owner"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(6)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-deadline-cards td:nth-child(7)::before { content: "Action"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15d-9: MatterDocuments staff mobile cards (8 columns) */
    #root .lf-doc-cards-staff > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-doc-cards-staff table { min-width: 0 !important; }
    #root .lf-doc-cards-staff thead { display: none !important; }
    #root .lf-doc-cards-staff tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    /* R15d-9: MatterDocuments client mobile cards (6 columns) */
    #root .lf-doc-cards-client > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-doc-cards-client table { min-width: 0 !important; }
    #root .lf-doc-cards-client thead { display: none !important; }
    #root .lf-doc-cards-client tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-client-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-client-matters-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-client-events-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-client-invoices-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-invoices-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-invoices-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-invoices-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(2)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(3)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-invoices-cards td:nth-child(4)::before { content: "PDF"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal Payment Proofs mobile cards */
    #root .lf-client-proofs-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-proofs-cards table { min-width: 0 !important; }
    #root .lf-client-proofs-cards thead { display: none !important; }
    #root .lf-client-proofs-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-proofs-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-proofs-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-proofs-cards td:nth-child(1)::before { content: "Reference"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(2)::before { content: "Method"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(3)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-proofs-cards td:nth-child(4)::before { content: "Uploaded"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15e-1: Client portal All Documents mobile cards */
    #root .lf-client-all-docs-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-client-all-docs-cards table { min-width: 0 !important; }
    #root .lf-client-all-docs-cards thead { display: none !important; }
    #root .lf-client-all-docs-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-client-all-docs-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-client-all-docs-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-client-all-docs-cards td:nth-child(1)::before { content: "Name"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(2)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(3)::before { content: "Source"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(4)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-client-all-docs-cards td:nth-child(5)::before { content: "Download"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
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
    #root .lf-task-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-appearance-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-appearance-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-appearance-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-appearance-cards td:nth-child(1)::before { content: "Title"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(2)::before { content: "Date"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(3)::before { content: "Time"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(4)::before { content: "Type"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(5)::before { content: "Location"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(6)::before { content: "Virtual Court"; min-width: 80px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-appearance-cards td:nth-child(7)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-2: Invoice Register mobile cards */
    #root .lf-invoice-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-invoice-cards table { min-width: 0 !important; }
    #root .lf-invoice-cards thead { display: none !important; }
    #root .lf-invoice-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-invoice-cards tbody td { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: none; background: transparent !important; }
    #root .lf-invoice-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-invoice-cards td:nth-child(1)::before { content: "Invoice"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(2)::before { content: "Client"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(3)::before { content: "Matter"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(4)::before { content: "Amount"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(5)::before { content: "Status"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(6)::before { content: "PDF"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    #root .lf-invoice-cards td:nth-child(7)::before { content: "Actions"; min-width: 64px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; }
    /* R15g-6: Matter detail case notes mobile cards */
    #root .lf-matter-notes-cards > div { overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-matter-notes-cards table { min-width: 0 !important; }
    #root .lf-matter-notes-cards thead { display: none !important; }
    #root .lf-matter-notes-cards tbody tr { display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-user-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    #root .lf-user-cards tbody td { display: grid; grid-template-columns: minmax(0,1fr); align-items: start; gap: 4px; width: 100%; min-width: 0; padding: 6px 0; border-top: none; background: transparent !important; white-space: normal !important; overflow-wrap: anywhere; word-break: break-word; }
    #root .lf-user-cards tbody td > * { min-width: 0 !important; max-width: 100% !important; overflow-wrap: anywhere; }
    #root .lf-user-cards tbody td input,
    #root .lf-user-cards tbody td select,
    #root .lf-user-cards tbody td textarea { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
    #root .lf-user-cards tbody td button { white-space: normal !important; max-width: 100% !important; }
    #root .lf-user-cards tbody td span { white-space: normal !important; max-width: 100% !important; }
    #root .lf-user-cards tbody td::before { min-width: 0 !important; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7280; flex-shrink: 0; overflow-wrap: normal; word-break: normal; }
    #root .lf-user-cards tbody tr:hover td { background: transparent !important; }
    #root .lf-user-cards td:nth-child(1)::before { content: "Name"; }
    #root .lf-user-cards td:nth-child(2)::before { content: "Email"; }
    #root .lf-user-cards td:nth-child(3)::before { content: "Role"; }
    #root .lf-user-cards td:nth-child(4)::before { content: "Status"; }
    #root .lf-user-cards td:nth-child(5)::before { content: "Client"; }
    #root .lf-user-cards td:nth-child(6)::before { content: "Actions"; }
    /* R15g-4: TimeEntryEditorList mobile cards */
    #root .lf-time-entry-cards,
    #root .lf-time-entry-cards * { box-sizing: border-box !important; }
    #root .lf-time-entry-cards { width: 100% !important; max-width: 100% !important; overflow: visible !important; border: none !important; border-radius: 0 !important; }
    #root .lf-time-entry-cards table,
    #root .lf-time-entry-cards tbody { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
    #root .lf-time-entry-cards thead { display: none !important; }
    #root .lf-time-entry-cards tbody tr { display: block; width: 100%; min-width: 0; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(3)::before { content: "Status"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(4)::before { content: "PDF"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(5)::before { content: "Actions"; }
  }
  @media (min-width: 768px) and (max-width: 900px) {
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
    #root .lf-matter-detail-workspace .lf-matter-notes-cards tbody tr { display: block; width: 100%; min-width: 0; max-width: 100%; background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
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
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(3)::before { content: "Status"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(4)::before { content: "PDF"; }
    #root .lf-matter-detail-workspace .lf-invoice-cards td:nth-child(5)::before { content: "Actions"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(1)::before { content: "Note"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(2)::before { content: "Author"; }
    #root .lf-matter-detail-workspace .lf-matter-notes-cards td:nth-child(3)::before { content: "Created"; }
  }
  @media (max-width: 480px) {
    #root .lf-court-mode-card { padding: 12px !important; }
    #root .lf-court-mode-stack { gap: 8px !important; }
  }
  @keyframes lfPulse { 0% { opacity: .55; } 50% { opacity: 1; } 100% { opacity: .55; } }
  @keyframes lfSlideIn { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes lfDropIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  @media (min-width: 768px) and (max-width: 900px) { #root .lf-task-split-grid { grid-template-columns: minmax(0,1fr) !important; width: 100% !important; max-width: 100% !important; } }
  @media (max-width: 760px) { #root .lf-dashboard-grid { grid-template-columns: 1fr !important; } }
  table th { text-align: left; padding: 9px 12px; background: #F3F4F6; color: #6B7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0; font-weight: 700; }
  table td { padding: 10px 12px; border-top: 1px solid #E5E7EB; vertical-align: middle; }
  table tr:nth-child(even) td { background: #FAFAFB; }
  table tbody tr:hover td { background: #F8FAFC; }
  label > span { color: #6B7280; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .lf-app-shell .profile-tooltip span, body .profile-tooltip span { display: block; color: #697386; font-size: 12px; margin-top: 3px; }
  .lf-logo-preview img { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; border: 1px solid #E5E7EB; }
  section h2 { margin: 0; font-size: 14px; font-weight: 700; color: #101827; }
  section h3 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #101827; }
  section p { margin: 4px 0 0; color: #697386; font-size: 12px; }
`}</style>; }

export const styles = {
  shell: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', background: '#F5F7FA', color: theme.ink, fontFamily: 'Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 13 },
  sidebar: { position: 'sticky', top: 0, minHeight: '100vh', background: 'var(--lf-sidebar, var(--lf-primary, #0F1B33))', color: 'var(--lf-sidebar-text, #fff)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '1px 0 0 rgba(255,255,255,.05)' },
  brandPanel: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px 14px', borderBottom: '1px solid rgba(255,255,255,.10)' },
  logo: { width: 36, height: 36, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--lf-accent, var(--lf-button, #D4A34A))', color: 'var(--lf-button-text, #fff)', fontWeight: 900, fontSize: 18, boxShadow: '0 8px 18px rgba(212,163,74,.20)', overflow: 'hidden' }, logoImage: { width: '100%', height: '100%', objectFit: 'cover' },
  brand: { fontSize: 16, fontWeight: 700, letterSpacing: 0 }, brandSub: { fontSize: 11, color: '#9CA8BA', marginTop: 2 }, sideSectionLabel: { color: '#7F8CA3', fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase', padding: '0 8px' },
  navList: { display: 'grid', gap: 7 }, navGroup: { display: 'grid', gap: 3 }, navGroupButton: { border: 0, background: 'transparent', color: '#7F8CA3', borderRadius: 6, padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: .8, textTransform: 'uppercase' },   navGroupChevron: { color: 'var(--lf-accent, var(--lf-button, #D4A34A))', fontSize: 11, fontWeight: 900 }, navGroupItems: { display: 'grid', gap: 3 }, navItem: { border: 0, borderLeft: '3px solid transparent', background: 'transparent', color: '#C9D3E2', borderRadius: 6, padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600, textAlign: 'left' }, navActive: { background: 'rgba(255,255,255,.10)', color: '#fff', borderLeft: '3px solid var(--lf-accent, var(--lf-button, #D4A34A))' }, navNumber: { width: 24, height: 24, borderRadius: 6, background: 'rgba(255,255,255,.08)', display: 'grid', placeItems: 'center', fontSize: 10, color: 'var(--lf-accent, var(--lf-button, #D4A34A))', fontWeight: 800 },

  timerCard: { marginTop: 'auto', padding: 12, borderRadius: 8, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.10)', display: 'grid', gap: 4 }, timerTop: { color: '#DDE5F1', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }, liveDot: { width: 8, height: 8, borderRadius: 999, background: '#22C55E', boxShadow: '0 0 0 4px rgba(34,197,94,.13)' },
  userCard: { display: 'grid', gridTemplateColumns: '34px 1fr auto', gap: 8, alignItems: 'center', paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.10)' }, avatar: { width: 34, height: 34, borderRadius: 8, background: '#243653', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12 }, userName: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }, userRole: { color: '#AAB4C3', fontSize: 11, textTransform: 'capitalize' }, logout: { border: '1px solid rgba(255,255,255,.18)', color: '#fff', background: 'transparent', borderRadius: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12 },
  main: { padding: 24, minWidth: 0 }, topbar: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', marginBottom: 20 }, topbarTitle: { display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }, mobileMenuButton: { display: 'none', minWidth: 42, minHeight: 38, border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff', color: 'var(--lf-primary, #1B3A5C)', fontWeight: 800, cursor: 'pointer', alignItems: 'center', justifyContent: 'center', padding: '8px 10px' }, eyebrow: { color: theme.goldDark, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }, title: { margin: '2px 0 0', fontSize: 20, fontWeight: 700, lineHeight: 1.2 }, subtitle: { margin: '5px 0 0', color: theme.muted, maxWidth: 680 }, topActions: { display: 'flex', gap: 8, alignItems: 'center' }, search: { width: 260, border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 },
  pageStack: { display: 'grid', gap: 16 },   heroCard: { borderRadius: 10, background: 'linear-gradient(135deg, var(--lf-primary, #0F1B33), var(--lf-sidebar, #1B3A5C))', color: '#fff', padding: 24, display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'end', boxShadow: theme.shadow }, heroKicker: { color: 'var(--lf-accent, var(--lf-button, #D4A34A)))', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }, heroFigure: { fontSize: 24, fontWeight: 700, color: 'var(--lf-accent, var(--lf-button, #D4A34A)))' },
  warningPanel: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #FDE68A', background: theme.amberBg, color: theme.amber, boxShadow: theme.shadow }, warningIcon: { width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', background: '#FDE68A', fontWeight: 900 }, 
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }, stat: { position: 'relative', overflow: 'hidden', background: '#fff', border: `1px solid ${theme.line}`, borderLeft: '4px solid', borderRadius: 10, padding: 16, boxShadow: theme.shadow, display: 'grid', gap: 6 }, 
  splitGrid: { display: 'grid', gridTemplateColumns: 'minmax(260px,.72fr) minmax(0,1.28fr)', gap: 16 }, dashboardGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }, matterGrid: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16 },
  card: { background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: '18px 20px', boxShadow: theme.shadow, minWidth: 0, transition: 'box-shadow .16s ease, transform .16s ease' }, cardHead: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12, alignItems: 'end' }, field: { display: 'grid', gap: 5 }, input: { width: '100%', border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 11px', background: '#fff', fontSize: 13 }, colorInput: { width: '100%', height: 36, border: `1px solid ${theme.line}`, borderRadius: 6, padding: 4, background: '#fff' }, primaryButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: 'var(--lf-primary, #1B3A5C)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, goldButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: 'var(--lf-accent, #D4A34A)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, dangerButton: { border: 0, borderRadius: 6, padding: '7px 16px', background: theme.red, color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13 }, ghostButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '7px 16px', background: '#fff', color: 'var(--lf-primary, #1B3A5C)', fontWeight: 700, cursor: 'pointer', fontSize: 13, textDecoration: 'none' }, actionGroup: { display: 'flex', flexWrap: 'wrap', gap: 6 }, actionMenuWrap: { position: 'relative', display: 'inline-flex', justifyContent: 'flex-end' }, actionMenuButton: { width: 30, height: 28, border: `1px solid ${theme.line}`, borderRadius: 6, background: '#fff', color: 'var(--lf-primary, #1B3A5C)', fontWeight: 900, cursor: 'pointer', lineHeight: 1 }, actionMenu: { position: 'fixed', zIndex: 2600, minWidth: 154, display: 'grid', gap: 2, padding: 6, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 8, boxShadow: theme.shadowLift, animation: 'lfDropIn .14s ease-out' }, actionMenuItem: { width: '100%', border: 0, borderRadius: 6, padding: '8px 10px', background: '#fff', color: theme.ink, cursor: 'pointer', fontSize: 12, fontWeight: 700, textAlign: 'left' }, actionMenuItemDanger: { color: theme.red, background: theme.redBg }, tinyButton: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '4px 10px', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--lf-primary, #1B3A5C)' }, dangerTinyButton: { border: '1px solid #FECACA', borderRadius: 6, padding: '4px 10px', background: theme.redBg, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: theme.red },
  tableWrap: { overflowX: 'auto', border: `1px solid ${theme.line}`, borderRadius: 8 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 620 }, badge: { display: 'inline-flex', padding: '4px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }, link: { color: theme.navy600, fontWeight: 700, textDecoration: 'none' }, meetingLink: { color: theme.navy600, fontWeight: 700, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }, videoBadge: { width: 22, height: 22, borderRadius: 6, display: 'inline-grid', placeItems: 'center', background: theme.blueBg, color: theme.blue, fontSize: 10, fontWeight: 900 }, joinButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, padding: '5px 10px', background: theme.green, color: '#fff', fontWeight: 800, fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap', boxShadow: '0 6px 14px rgba(4,120,87,.18)' }, mutedText: { color: theme.muted }, tableSelect: { border: `1px solid ${theme.line}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 },
  pipelineRow: { display: 'grid', gridTemplateColumns: '116px 1fr 30px', gap: 10, alignItems: 'center', marginBottom: 10 }, pipelineTrack: { height: 8, background: '#EEF2F7', borderRadius: 999, overflow: 'hidden' }, pipelineFill: { height: '100%', background: theme.gold, borderRadius: 999 },
  matterButton: { width: '100%', display: 'grid', gap: 4, textAlign: 'left', border: 0, borderLeft: '3px solid transparent', borderBottom: `1px solid ${theme.line}`, background: '#fff', padding: '12px 10px', cursor: 'pointer', borderRadius: 6 }, matterActive: { background: '#F8FAFC', borderLeftColor: theme.gold }, detailStack: { display: 'grid', gap: 16, minWidth: 0 }, chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: theme.muted }, tabList: { display: 'flex', gap: 4, borderBottom: `1px solid ${theme.line}` }, tabButton: { border: 0, borderBottom: '2px solid transparent', background: 'transparent', color: theme.muted, padding: '8px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }, tabActive: { color: theme.navy600, borderBottomColor: theme.gold }, assistantPanel: { display: 'grid', gap: 12 }, assistantIntro: { display: 'grid', gap: 4, padding: 14, borderRadius: 10, background: '#F8FAFC', border: `1px solid ${theme.line}`, color: theme.muted }, suggestionList: { display: 'grid', gap: 10 }, suggestionItem: { display: 'grid', gridTemplateColumns: '28px 1fr', gap: 10, alignItems: 'start', padding: '12px 14px', borderRadius: 10, border: `1px solid ${theme.line}`, background: '#fff', boxShadow: theme.shadow, lineHeight: 1.5 }, suggestionWarning: { background: theme.amberBg, borderColor: '#FDE68A', color: theme.amber }, suggestionGood: { background: theme.greenBg, borderColor: '#A7F3D0', color: theme.green }, suggestionIcon: { width: 28, height: 28, display: 'grid', placeItems: 'center', fontSize: 16 }, sub: { borderTop: `1px solid ${theme.line}`, paddingTop: 16 }, noteForm: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 12 }, file: { marginBottom: 12, fontSize: 12 }, hoverName: { color: theme.navy600, fontWeight: 800, cursor: 'help' },
  empty: { minHeight: 136, display: 'grid', placeItems: 'center', textAlign: 'center', color: theme.muted, gap: 6, padding: 18 }, emptyIcon: { width: 42, height: 42, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#F3F4F6', color: theme.navy600, fontWeight: 800 }, skeletonGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }, skeleton: { height: 120, borderRadius: 10, background: '#fff', border: `1px solid ${theme.line}`, boxShadow: theme.shadow, padding: 16, display: 'grid', gap: 10, alignContent: 'start' }, skeletonLineLarge: { height: 18, width: '55%', borderRadius: 6, background: '#E5E7EB', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLine: { height: 12, width: '80%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' }, skeletonLineShort: { height: 12, width: '42%', borderRadius: 6, background: '#EEF2F7', animation: 'lfPulse 1.4s ease-in-out infinite' },
  toast: { position: 'fixed', top: 22, right: 22, zIndex: 2000, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', minWidth: 300, maxWidth: 420, padding: '12px 14px', borderRadius: 10, boxShadow: theme.shadowLift, border: '1px solid', animation: 'lfSlideIn .18s ease-out' }, toastClose: { border: 0, background: 'transparent', color: 'inherit', fontWeight: 900, cursor: 'pointer', fontSize: 16 }, mobileDrawerLayer: { position: 'fixed', inset: 0, zIndex: 2800 }, mobileBackdrop: { position: 'absolute', inset: 0, border: 0, padding: 0, background: 'rgba(8,18,37,.48)', cursor: 'pointer' }, mobileDrawer: { position: 'absolute', top: 0, left: 0, bottom: 0, width: 304, maxWidth: 'calc(100vw - 44px)', background: 'var(--lf-sidebar, var(--lf-primary, #0F1B33))', color: 'var(--lf-sidebar-text, #fff)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', boxShadow: '18px 0 42px rgba(8,18,37,.32)' }, mobileDrawerHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,.10)' }, mobileCloseButton: { minWidth: 38, minHeight: 38, border: '1px solid rgba(255,255,255,.18)', borderRadius: 8, background: 'transparent', color: '#fff', cursor: 'pointer', fontWeight: 900 }, modalBackdrop: { position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,27,51,.28)', backdropFilter: 'blur(4px)' }, modalCard: { width: 420, maxWidth: '100%', background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, boxShadow: theme.shadowLift, padding: 18 }, modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }, modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }, alert: { borderRadius: 8, padding: 12, background: theme.blueBg, color: theme.blue, fontWeight: 700 }, alertDanger: { background: theme.redBg, color: theme.red },
  loginShell: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'linear-gradient(135deg, #F5F7FA, #EEF2F7)', color: '#fff' }, loginEditorial: { display: 'none' }, loginBadge: { display: 'none' }, loginMetricRow: { display: 'none' }, loginCard: { width: 410, maxWidth: 'calc(100vw - 32px)', color: theme.ink, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 28, boxShadow: theme.shadowLift }, loginLogo: { width: 48, height: 48, borderRadius: 10, background: 'var(--lf-accent, #D4A34A)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 900, marginBottom: 12, overflow: 'hidden', fontSize: 22 }, loginModeSwitch: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 4, background: '#F3F4F6', borderRadius: 8, margin: '14px 0' }, loginModeButton: { border: 0, borderRadius: 6, padding: '7px 10px', background: 'transparent', color: theme.muted, fontWeight: 800, cursor: 'pointer', fontSize: 12 }, loginModeActive: { background: '#fff', color: 'var(--lf-primary, #1B3A5C)', boxShadow: theme.shadow }, loginHint: { marginTop: 12, color: theme.muted, fontSize: 12 },
loginSplit: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '1fr 1fr', fontFamily: 'Segoe UI, Roboto, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: 13 },
loginBrand: { background: 'linear-gradient(135deg, var(--lf-primary, #0F1B33) 0%, #0a1220 100%)', color: '#fff', display: 'grid', placeItems: 'center', padding: 48, position: 'relative', overflow: 'hidden' },
loginBrandLogo: { width: 72, height: 72, borderRadius: 16, background: 'var(--lf-accent, #D4A34A)', display: 'grid', placeItems: 'center', margin: '0 auto', color: '#fff', overflow: 'hidden', boxShadow: '0 12px 28px rgba(0,0,0,.25)' },
loginBrandName: { margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -.5 },
loginBrandTagline: { margin: '6px 0 0', fontSize: 14, color: 'rgba(255,255,255,.6)', lineHeight: 1.5 },
loginBrandFeatures: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
loginFeatureItem: { padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.85)', fontSize: 13, fontWeight: 600, textAlign: 'center' },
loginBrandDivider: { height: 1, background: 'rgba(255,255,255,.1)', marginBottom: 16 },
loginBrandFooter: { margin: 0, fontSize: 12, color: 'rgba(255,255,255,.45)', textAlign: 'center', lineHeight: 1.5 },
loginCardWrap: { display: 'grid', placeItems: 'center', padding: 32, background: '#F8F6F3' },
loginCardForm: { width: '100%', maxWidth: 420, color: theme.ink, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 12, padding: 32, boxShadow: theme.shadowLift },
loginCardTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: theme.ink },
  logoPreview: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }, formHelper: { color: theme.muted, fontSize: 12, lineHeight: 1.4, alignSelf: 'center' }, clientShell: { minHeight: '100vh', background: '#F5F7FA' }, clientHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '16px 24px', background: '#fff', borderBottom: `1px solid ${theme.line}`, boxShadow: theme.shadow }, clientBrand: { display: 'flex', alignItems: 'center', gap: 10 }, clientActions: { display: 'flex', alignItems: 'center', gap: 8 }, clientMain: { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 16, padding: 24 }, clientMatterList: { minWidth: 0 }, clientStatusGrid: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }, clientDescription: { color: theme.muted, marginTop: 12 }, profileTooltip: { position: 'fixed', zIndex: 5000, pointerEvents: 'none', width: 260, display: 'grid', gridTemplateColumns: '42px 1fr', gap: 10, background: '#fff', border: `1px solid ${theme.line}`, borderRadius: 10, padding: 12, boxShadow: theme.shadowLift }, tooltipAvatar: { width: 42, height: 42, borderRadius: 10, background: 'var(--lf-primary, #1B3A5C)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 900 },
  noticeAttachmentPreview: { gridColumn: '1 / -1', display: 'grid', gap: 8, padding: 10, border: `1px solid ${theme.line}`, borderRadius: 8, background: '#F8FAFC' }, noticeAttachmentPreviewItem: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '8px 10px', border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff' }, noticeAttachmentSummary: { display: 'flex', flexWrap: 'wrap', gap: 6 }, noticeList: { display: 'grid', gap: 12 }, noticeItem: { display: 'grid', gap: 10, padding: 14, border: `1px solid ${theme.line}`, borderRadius: 8, background: '#fff' }, noticeItemHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }, noticeTitle: { margin: 0, fontSize: 15, color: theme.ink, lineHeight: 1.25 }, noticeBody: { margin: 0, color: theme.ink, lineHeight: 1.55, whiteSpace: 'pre-wrap' }, noticeFileGrid: { display: 'grid', gap: 8 }, noticeFileLink: { display: 'grid', gridTemplateColumns: '42px minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '9px 10px', border: `1px solid ${theme.line}`, borderRadius: 8, background: '#F8FAFC', color: theme.navy600, textDecoration: 'none', fontWeight: 700 }, noticeFileIcon: { width: 42, minHeight: 28, borderRadius: 6, display: 'grid', placeItems: 'center', background: theme.blueBg, color: theme.blue, fontSize: 10, fontWeight: 900 },
};

const THEME_CSS_MAP = {
  primaryColor: '--lf-primary',
  accentColor: '--lf-accent',
  backgroundColor: '--lf-background',
  surfaceColor: '--lf-surface',
  textColor: '--lf-text',
  textSecondaryColor: '--lf-text-muted',
  sidebarColor: '--lf-sidebar',
  sidebarTextColor: '--lf-sidebar-text',
  buttonColor: '--lf-button',
  buttonTextColor: '--lf-button-text',
  borderColor: '--lf-border',
  linkColor: '--lf-link',
  successColor: '--lf-success',
  warningColor: '--lf-warning',
  errorColor: '--lf-danger',
  infoColor: '--lf-info',
};

export function applyFirmTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  const root = document.documentElement;
  Object.entries(THEME_CSS_MAP).forEach(([key, cssVar]) => {
    if (theme[key]) root.style.setProperty(cssVar, theme[key]);
  });
}

export function clearFirmTheme() {
  const root = document.documentElement;
  Object.values(THEME_CSS_MAP).forEach(cssVar => root.style.removeProperty(cssVar));
}

export async function loadAndApplyFirmTheme() {
  try {
    const { api } = await import('./lib/apiClient.js');
    const data = await api('/firm-settings/theme');
    if (data?.theme) applyFirmTheme(data.theme);
  } catch {
    // Keep default theme if fetch fails
  }
}
