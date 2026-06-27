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
    description: 'Place a saved visual signature or firm stamp on a matter PDF, then download or save a signed copy.',
  },
  {
    id: 'tenth',
    title: 'Tenth-lining / appellate formatting',
    description: 'Prepare legal-document formatting helpers for appellate practice.',
  },
];

const activeToolNames = new Set(['Merge PDFs', 'Rotate pages', 'Extract pages', 'Split / reorder pages', 'Delete pages', 'Add page numbers / paginate bundle', 'Court bundle prep', 'Images to PDF', 'Sign / stamp PDF', 'Tenth-lining / appellate formatting']);

export default function DocumentToolCards({ onOpenMerge, onOpenRotate, onOpenExtract, onOpenSplit, onOpenDelete, onOpenPaginate, onOpenBundle, onOpenImages, onOpenStamp, onOpenTenth, selectedTool }) {
  const openHandlers = {
    'Merge PDFs': onOpenMerge,
    'Rotate pages': onOpenRotate,
    'Extract pages': onOpenExtract,
    'Split / reorder pages': onOpenSplit,
    'Delete pages': onOpenDelete,
    'Add page numbers / paginate bundle': onOpenPaginate,
    'Court bundle prep': onOpenBundle,
    'Images to PDF': onOpenImages,
    'Sign / stamp PDF': onOpenStamp,
    'Tenth-lining / appellate formatting': onOpenTenth,
  };

  return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12, minWidth: 0 }}>
        {documentToolCards.map(tool => {
          const active = activeToolNames.has(tool.title);
          const handler = openHandlers[tool.title];
          const selected = selectedTool === tool.id;
          return (
            <div key={tool.id} style={{ border: `1px solid ${selected ? theme.gold : theme.line}`, borderLeft: `4px solid ${selected ? theme.forest : theme.line}`, borderRadius: 8, background: selected ? theme.goldPale : '#fff', padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14, color: theme.ink, lineHeight: 1.35, wordBreak: 'break-word' }}>{tool.title}</strong>
                {selected && <Badge tone="green">Selected</Badge>}
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
                  color: active ? theme.forest : theme.muted,
                  borderColor: selected ? theme.gold : active ? theme.forest : theme.line,
                  cursor: active ? 'pointer' : 'not-allowed',
                  opacity: active ? 1 : 0.75,
                }}
              >
                {selected ? 'Continue' : active ? 'Open tool' : 'Not available yet'}
              </button>
            </div>
          );
        })}
      </div>
  );
}
