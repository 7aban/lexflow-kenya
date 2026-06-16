import { useState } from 'react';
import { styles, theme } from '../../theme.jsx';
import PdfStampCanvas from './PdfStampCanvas.jsx';

const PRESETS = [
  { label: 'Top Left', x: 50, y: 742, width: 150 },
  { label: 'Top Right', x: 395, y: 742, width: 150 },
  { label: 'Bottom Left', x: 50, y: 50, width: 150 },
  { label: 'Bottom Right', x: 395, y: 50, width: 150 },
  { label: 'Signature line', x: 200, y: 100, width: 200 },
];

export default function StampPlacementHelper({
  stampX,
  stampY,
  stampWidth,
  onXChange,
  onYChange,
  onWidthChange,
  selectedAssetUrl,
  disabled,
  pdfData,
  pageNumber,
  onPageChange,
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  function applyPreset(p) {
    if (disabled) return;
    const event = (val) => ({ target: { value: val } });
    onXChange(event(p.x));
    onYChange(event(p.y));
    onWidthChange(event(p.width));
  }

  const previewScale = Math.min(stampWidth / 200, 1);
  const previewWidth = Math.round(120 * previewScale);

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0, gridColumn: '1 / -1' }}>
      {pdfData && (
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: theme.muted, fontWeight: 700 }}>Click or drag to place</span>
          <div style={{ fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
            Click the PDF preview to place the signature/stamp. Drag the preview marker to move it; advanced coordinates remain editable below.
          </div>
          <PdfStampCanvas
            pdfData={pdfData}
            pageNumber={pageNumber}
            stampX={stampX}
            stampY={stampY}
            stampWidth={stampWidth}
            selectedAssetUrl={selectedAssetUrl}
            onPageChange={onPageChange}
            onXChange={onXChange}
            onYChange={onYChange}
            onWidthChange={onWidthChange}
            disabled={disabled}
          />
        </div>
      )}

      <div style={{ border: `1px solid ${theme.line}`, borderRadius: 6, background: '#FAFAF9', padding: '8px 12px', fontSize: 12, color: theme.muted, lineHeight: 1.5 }}>
        A4 reference: 595 × 842 pt. PDF coordinates start from the bottom-left corner.
      </div>

      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 12, color: theme.muted }}>Quick placement presets</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              disabled={disabled}
              style={{ ...styles.tinyButton, fontSize: 11, padding: '4px 10px', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: '#FAFAF9', minHeight: 80, display: 'grid', placeItems: 'center', padding: 12, overflow: 'hidden' }}>
        {selectedAssetUrl ? (
          <img
            src={selectedAssetUrl}
            alt="Selected stamp preview"
            style={{ maxWidth: 120, maxHeight: 80, width: previewWidth, objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: 12, color: theme.muted }}>No asset selected</span>
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(a => !a)}
          style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, fontSize: 12, color: theme.blue, fontWeight: 700 }}
        >
          {showAdvanced ? '−' : '+'} Advanced placement
        </button>
        {showAdvanced && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))', gap: 10, marginTop: 10 }}>
            <label style={{ ...styles.field, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>X (pt from left)</span>
              <input type="number" style={styles.input} value={stampX} onChange={onXChange} disabled={disabled} />
            </label>
            <label style={{ ...styles.field, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>Y (pt from bottom)</span>
              <input type="number" style={styles.input} value={stampY} onChange={onYChange} disabled={disabled} />
            </label>
            <label style={{ ...styles.field, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: theme.muted }}>Width (pt)</span>
              <input type="number" min="1" max="2000" style={styles.input} value={stampWidth} onChange={onWidthChange} disabled={disabled} />
            </label>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: theme.muted, fontStyle: 'italic' }}>
        For exact placement, adjust advanced coordinates below.
      </div>
    </div>
  );
}
