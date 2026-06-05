import { styles, theme } from '../../theme.jsx';
import { Badge } from '../../components/ui.jsx';

const documentToolCards = [
  {
    id: 'merge',
    title: 'Merge PDFs',
    description: 'Combine pleadings, exhibits, and annexures into one staged court bundle.',
  },
  {
    id: 'extract',
    title: 'Extract pages',
    description: 'Pull selected page ranges from one matter PDF into a new document.',
  },
  {
    id: 'split',
    title: 'Split / reorder pages',
    description: 'Prepare page ranges and reorder scanned bundles before final export.',
  },
  {
    id: 'delete',
    title: 'Delete pages',
    description: 'Remove duplicate, blank, or incorrectly scanned pages during review.',
  },
  {
    id: 'rotate',
    title: 'Rotate pages',
    description: 'Correct sideways pages in affidavits, exhibits, and annexures.',
  },
  {
    id: 'paginate',
    title: 'Add page numbers / paginate bundle',
    description: 'Apply court-ready pagination before filing or service.',
  },
  {
    id: 'bundle',
    title: 'Court bundle prep',
    description: 'Combine selected matter PDFs into a single court-ready bundle with optional page numbers.',
  },
  {
    id: 'images',
    title: 'Images to PDF',
    description: 'Convert evidence images and scanned pages into PDF output.',
  },
  {
    id: 'stamp',
    title: 'Sign / stamp PDF',
    description: 'Place a stored signature or stamp image onto a PDF page.',
  },
  {
    id: 'tenth-lining',
    title: 'Tenth-lining / appellate formatting',
    description: 'Prepare legal-document formatting helpers for appellate practice.',
  },
];

const workflowPrinciples = [
  'First outputs will use temporary preview/download before any matter record is created.',
  'Saving to matter documents will be an explicit later action with audit history.',
  'Client access will be considered later only where the workflow is appropriate.',
  'Current matter, document, and client visibility controls remain unchanged.',
];

const activeToolNames = new Set(['Merge PDFs', 'Rotate pages', 'Extract pages', 'Delete pages', 'Add page numbers / paginate bundle', 'Court bundle prep', 'Sign / stamp PDF']);

export default function DocumentToolCards({ onOpenMerge, onOpenRotate, onOpenExtract, onOpenDelete, onOpenPaginate, onOpenBundle, onOpenStamp, selectedTool }) {
  const openHandlers = {
    'Merge PDFs': onOpenMerge,
    'Rotate pages': onOpenRotate,
    'Extract pages': onOpenExtract,
    'Delete pages': onOpenDelete,
    'Add page numbers / paginate bundle': onOpenPaginate,
    'Court bundle prep': onOpenBundle,
    'Sign / stamp PDF': onOpenStamp,
  };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
        {documentToolCards.map(tool => {
          const active = activeToolNames.has(tool.title);
          const handler = openHandlers[tool.title];
          return (
            <div key={tool.title} style={{ border: `1px solid ${active ? theme.blue : theme.line}`, borderRadius: 8, background: '#fff', padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14, color: theme.ink, lineHeight: 1.35, wordBreak: 'break-word' }}>{tool.title}</strong>
                <Badge tone={active ? 'green' : 'amber'}>{active ? 'Available' : 'Coming soon'}</Badge>
              </div>
              <span style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>{tool.description}</span>
              <button
                type="button"
                disabled={!active}
                onClick={handler}
                style={{
                  ...styles.ghostButton,
                  justifySelf: 'start',
                  fontSize: 12,
                  padding: '5px 12px',
                  color: active ? 'var(--lf-primary, #1B3A5C)' : theme.muted,
                  borderColor: active ? theme.blue : theme.line,
                  cursor: active ? 'pointer' : 'not-allowed',
                  opacity: active ? 1 : 0.75,
                }}
              >
                {selectedTool === tool.id ? 'Active' : active ? 'Open Tool' : 'Not available yet'}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#F8FAFC', padding: '14px 16px', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, color: theme.ink }}>Planned workflow</strong>
          <Badge tone="blue">Design principle</Badge>
        </div>
        <div style={{ display: 'grid', gap: 7 }}>
          {workflowPrinciples.map(item => (
            <div key={item} style={{ display: 'grid', gridTemplateColumns: '8px minmax(0, 1fr)', gap: 8, alignItems: 'start', fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: theme.blue, marginTop: 6 }} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
