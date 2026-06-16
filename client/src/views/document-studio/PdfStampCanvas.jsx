import { useEffect, useRef, useState, useCallback } from 'react';
import { styles, theme } from '../../theme.jsx';
// PRODUCT-27C: worker resolved via Vite URL import so the asset is emitted but the
// (large) pdf.js library itself is loaded lazily through a dynamic import below.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_DISPLAY_WIDTH = 560;

// Round to one decimal place; PDF point coordinates do not need more precision.
function round1(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export default function PdfStampCanvas({
  pdfData,
  pageNumber,
  stampX,
  stampY,
  stampWidth,
  selectedAssetUrl,
  onPageChange,
  onXChange,
  onYChange,
  onWidthChange,
  disabled = false,
}) {
  const wrapperRef = useRef(null);
  const canvasRef = useRef(null);
  const pdfDocRef = useRef(null);
  const renderTaskRef = useRef(null);
  const dragRef = useRef(null);

  const [numPages, setNumPages] = useState(0);
  const [pageWidthPt, setPageWidthPt] = useState(0);
  const [pageHeightPt, setPageHeightPt] = useState(0);
  const [displayScale, setDisplayScale] = useState(1); // CSS px per PDF point
  const [assetAspect, setAssetAspect] = useState(null); // naturalHeight / naturalWidth
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [errorMessage, setErrorMessage] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Track the asset's natural aspect ratio so the preview height matches the
  // server's computeStampedHeight (height = width * naturalHeight / naturalWidth).
  useEffect(() => {
    if (!selectedAssetUrl) {
      setAssetAspect(null);
      return undefined;
    }
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active && img.naturalWidth > 0) setAssetAspect(img.naturalHeight / img.naturalWidth);
    };
    img.onerror = () => { if (active) setAssetAspect(null); };
    img.src = selectedAssetUrl;
    return () => { active = false; };
  }, [selectedAssetUrl]);

  // Load the PDF document once per pdfData. pdf.js may transfer the underlying
  // buffer to its worker, so hand it a private copy and keep the proxy in a ref.
  useEffect(() => {
    if (!pdfData) {
      pdfDocRef.current = null;
      setNumPages(0);
      setStatus('idle');
      return undefined;
    }
    let active = true;
    let loadingTask = null;
    setStatus('loading');
    setErrorMessage('');

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const copy = pdfData.slice(0);
        loadingTask = pdfjs.getDocument({ data: copy });
        const pdf = await loadingTask.promise;
        if (!active) {
          pdf.destroy().catch(() => {});
          return;
        }
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);
        setStatus('ready');
      } catch (err) {
        if (!active) return;
        pdfDocRef.current = null;
        setNumPages(0);
        setStatus('error');
        setErrorMessage(err?.message || 'Could not load the PDF preview.');
      }
    })();

    return () => {
      active = false;
      if (loadingTask) loadingTask.destroy().catch(() => {});
      const pdf = pdfDocRef.current;
      pdfDocRef.current = null;
      if (pdf) pdf.destroy().catch(() => {});
    };
  }, [pdfData]);

  // Render the active page whenever the document, page, or container width change.
  const renderPage = useCallback(async () => {
    const pdf = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;

    const safePage = Math.min(Math.max(Number(pageNumber) || 1, 1), pdf.numPages);

    let page;
    try {
      page = await pdf.getPage(safePage);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err?.message || 'Could not render this page.');
      return;
    }

    // Unscaled viewport gives the true page size in PDF points (handles rotation).
    const baseViewport = page.getViewport({ scale: 1 });
    const widthPt = baseViewport.width;
    const heightPt = baseViewport.height;

    const containerWidth = wrapperRef.current?.clientWidth || MAX_DISPLAY_WIDTH;
    const targetWidth = Math.min(widthPt, containerWidth, MAX_DISPLAY_WIDTH);
    const cssScale = targetWidth / widthPt;
    const dpr = window.devicePixelRatio || 1;

    const viewport = page.getViewport({ scale: cssScale * dpr });
    const ctx = canvas.getContext('2d');

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.round(widthPt * cssScale)}px`;
    canvas.style.height = `${Math.round(heightPt * cssScale)}px`;

    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
    }

    const task = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    try {
      await task.promise;
      setPageWidthPt(widthPt);
      setPageHeightPt(heightPt);
      setDisplayScale(cssScale);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        setStatus('error');
        setErrorMessage(err?.message || 'Could not render this page.');
      }
    }
  }, [pageNumber]);

  useEffect(() => {
    if (status !== 'ready') return undefined;
    renderPage();
    return () => {
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
      }
    };
  }, [status, renderPage]);

  const heightPt = stampWidth * (assetAspect || 1);

  function placeFromPointer(clientX, clientY, offsetXPt = 0, offsetTopPt = 0) {
    if (status !== 'ready' || disabled || !pageWidthPt || !pageHeightPt) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const S = rect.width / pageWidthPt; // CSS px per PDF point
    if (!Number.isFinite(S) || S <= 0) return;

    const cx = clientX - rect.left;
    const cy = clientY - rect.top;

    // Click marks the top-left of the stamp. PDF origin is bottom-left, so flip Y
    // and subtract the stamp height to convert the top edge into a bottom edge.
    let pdfX = (cx / S) - offsetXPt;
    let pdfY = pageHeightPt - ((cy / S) - offsetTopPt) - heightPt;

    pdfX = clamp(pdfX, 0, Math.max(0, pageWidthPt - stampWidth));
    pdfY = clamp(pdfY, 0, Math.max(0, pageHeightPt - heightPt));

    onXChange?.({ target: { value: round1(pdfX) } });
    onYChange?.({ target: { value: round1(pdfY) } });
  }

  function handleCanvasClick(event) {
    if (disabled || isDragging) return;
    placeFromPointer(event.clientX, event.clientY);
  }

  function handleOverlayPointerDown(event) {
    if (disabled || status !== 'ready' || !pageWidthPt || !pageHeightPt) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const S = rect.width / pageWidthPt;
    if (!Number.isFinite(S) || S <= 0) return;
    dragRef.current = {
      offsetXPt: (event.clientX - rect.left - overlayLeft) / S,
      offsetTopPt: (event.clientY - rect.top - overlayTop) / S,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleOverlayPointerMove(event) {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    placeFromPointer(event.clientX, event.clientY, dragRef.current.offsetXPt, dragRef.current.offsetTopPt);
  }

  function endOverlayDrag(event) {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    setIsDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function goToPage(next) {
    if (!numPages) return;
    const target = clamp(next, 1, numPages);
    if (target !== pageNumber) onPageChange?.(target);
  }

  // Overlay geometry (top-left origin in CSS px), mirroring the server placement.
  const overlayLeft = stampX * displayScale;
  const overlayTop = (pageHeightPt - stampY - heightPt) * displayScale;
  const overlayWidth = stampWidth * displayScale;
  const overlayHeight = heightPt * displayScale;
  const showOverlay = status === 'ready' && pageHeightPt > 0 && Number.isFinite(overlayLeft);

  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: theme.muted }}>
          Click the preview to place the signature/stamp. Drag the marker to move it.
        </span>
        {numPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={() => goToPage(pageNumber - 1)}
              disabled={pageNumber <= 1}
              style={{ ...styles.tinyButton, fontSize: 11, padding: '4px 10px', opacity: pageNumber <= 1 ? 0.5 : 1, cursor: pageNumber <= 1 ? 'not-allowed' : 'pointer' }}
            >
              ‹ Prev
            </button>
            <span style={{ fontSize: 12, color: theme.muted }}>Page {pageNumber} of {numPages}</span>
            <button
              type="button"
              onClick={() => goToPage(pageNumber + 1)}
              disabled={pageNumber >= numPages}
              style={{ ...styles.tinyButton, fontSize: 11, padding: '4px 10px', opacity: pageNumber >= numPages ? 0.5 : 1, cursor: pageNumber >= numPages ? 'not-allowed' : 'pointer' }}
            >
              Next ›
            </button>
          </div>
        )}
        {numPages === 1 && status === 'ready' && (
          <span style={{ fontSize: 12, color: theme.muted }}>Single-page PDF</span>
        )}
      </div>

      <div
        ref={wrapperRef}
        style={{ border: `1px solid ${theme.line}`, borderRadius: 8, background: theme.wash, padding: 12, display: 'grid', placeItems: 'center', minHeight: 120, overflow: 'auto', minWidth: 0 }}
      >
        {status === 'error' && (
          <span style={{ fontSize: 12, color: theme.red, textAlign: 'center', lineHeight: 1.5 }}>
            {errorMessage || 'PDF preview unavailable.'} You can still place the stamp using the presets and advanced coordinates below.
          </span>
        )}
        {status === 'loading' && (
          <span style={{ fontSize: 12, color: theme.muted }}>Loading PDF preview…</span>
        )}
        {(status === 'idle' || (!pdfData && status !== 'error')) && (
          <span style={{ fontSize: 12, color: theme.muted }}>Select a PDF document to enable click-to-place.</span>
        )}
        {status === 'ready' && (
          <div style={{ position: 'relative', lineHeight: 0, maxWidth: '100%' }}>
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              style={{ display: 'block', cursor: disabled ? 'not-allowed' : 'crosshair', maxWidth: '100%', border: `1px solid ${theme.line}`, background: '#fff' }}
            />
            {showOverlay && (
              <div
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={endOverlayDrag}
                onPointerCancel={endOverlayDrag}
                style={{
                  position: 'absolute',
                  left: overlayLeft,
                  top: overlayTop,
                  width: overlayWidth,
                  height: overlayHeight,
                  border: `1px solid ${theme.blue}`,
                  background: selectedAssetUrl ? 'transparent' : 'rgba(29,78,216,0.12)',
                  pointerEvents: disabled ? 'none' : 'auto',
                  boxSizing: 'border-box',
                  cursor: disabled ? 'not-allowed' : isDragging ? 'grabbing' : 'grab',
                  touchAction: 'none',
                }}
              >
                {selectedAssetUrl && (
                  <img
                    src={selectedAssetUrl}
                    alt="Stamp placement preview"
                    style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: 0.85 }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
