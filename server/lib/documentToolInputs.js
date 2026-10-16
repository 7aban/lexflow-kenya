'use strict';

const INPUT_BYTES = 20 * 1024 * 1024;
const BODY_BYTES = 28 * 1024 * 1024; // Base64 input plus a bounded JSON envelope.
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

class DocumentToolInputError extends Error {
  constructor(message, status = 400, code = 'invalid_computer_pdf_input') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Match the byte-limit units accepted by Express, without adding a dependency.
function byteLimit(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?\s*$/i.exec(String(value));
  if (!match) throw new Error('Invalid document upload body limit');
  const power = ['b', 'kb', 'mb', 'gb', 'tb', 'pb'].indexOf((match[2] || 'b').toLowerCase());
  return Math.floor(Number(match[1]) * (1024 ** power));
}

function outputByteLimit(uploadMaxMb, uploadBodyLimit) {
  // Leave 8 KiB for the existing upload's filename, data URL and JSON fields.
  const bodyCapacity = Math.max(0, Math.floor((byteLimit(uploadBodyLimit) - 8192) / 4) * 3);
  return Math.min(MAX_OUTPUT_BYTES, uploadMaxMb * 1024 * 1024, bodyCapacity);
}

function decodeComputerFiles(body, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DocumentToolInputError('A JSON object is required');
  if (hasOwn(body, 'documentId') || hasOwn(body, 'documentIds')) throw new DocumentToolInputError('Choose computer files or stored document IDs, not both');
  const allowed = new Set(['files', 'filename', ...(operation === 'rotate' ? ['degrees'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new DocumentToolInputError('Unsupported computer PDF request fields');
  const count = operation === 'rotate' ? [1, 1] : [2, 10];
  if (!Array.isArray(body.files) || body.files.length < count[0] || body.files.length > count[1]) {
    throw new DocumentToolInputError(operation === 'rotate' ? 'Select exactly 1 PDF file' : 'Select between 2 and 10 PDF files');
  }
  if (hasOwn(body, 'filename') && (typeof body.filename !== 'string' || body.filename.length > 180)) throw new DocumentToolInputError('filename must be a string of no more than 180 characters');
  let inputBytes = 0;
  const files = body.files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['name', 'mimeType', 'data'].includes(key))) throw new DocumentToolInputError('Each file requires name, mimeType and data only');
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f\x7f]/.test(file.name)) throw new DocumentToolInputError('Each file requires a display name of no more than 180 characters');
    if (file.mimeType !== 'application/pdf') throw new DocumentToolInputError('Only PDF files are supported');
    if (typeof file.data !== 'string' || !file.data.length) throw new DocumentToolInputError('PDF data is required');
    const prefix = 'data:application/pdf;base64,';
    const payload = file.data.startsWith(prefix) ? file.data.slice(prefix.length) : file.data;
    // Check size before allocating a decoded Buffer or scanning a large payload.
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const decodedLength = (payload.length / 4) * 3 - padding;
    if (decodedLength > INPUT_BYTES - inputBytes) throw new DocumentToolInputError('Selected PDFs exceed the 20 MiB input limit', 413, 'computer_pdf_input_too_large');
    if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new DocumentToolInputError('PDF data must be canonical base64 or a PDF base64 data URL');
    const content = Buffer.from(payload, 'base64');
    if (!content.length || content.length !== decodedLength || content.toString('base64') !== payload) throw new DocumentToolInputError('PDF data must be nonempty canonical base64');
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n\t ]/.test(content.subarray(0, 9).toString('latin1')) || !/%%EOF[\s\x00]*$/.test(content.subarray(-1024).toString('latin1'))) throw new DocumentToolInputError('Could not read PDF — it may be corrupt or encrypted');
    inputBytes += content.length;
    return content; // Names are display metadata, never paths or document IDs.
  });
  return { files, inputBytes };
}

// Only counters live in this closure. Buffers and leases belong to requests.
function createProcessingGate(maximum = 1) {
  let active = 0;
  const leases = new WeakMap();
  return {
    acquire(req, res) {
      if (leases.has(req)) return leases.get(req);
      if (active >= maximum) return null;
      active++;
      let processing = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        leases.delete(req);
        req.removeListener('aborted', transportEnded);
        res.removeListener('close', transportEnded);
        res.removeListener('finish', transportEnded);
      };
      const transportEnded = () => { if (!processing) release(); };
      const lease = {
        start() { if (released) return false; processing = true; return true; },
        finish: release,
      };
      leases.set(req, lease);
      req.once('aborted', transportEnded);
      res.once('close', transportEnded);
      res.once('finish', transportEnded);
      return lease;
    },
    releaseParsing(req) { leases.get(req)?.finish(); },
  };
}

module.exports = { INPUT_BYTES, BODY_BYTES, hasOwn, byteLimit, outputByteLimit, decodeComputerFiles, createProcessingGate, DocumentToolInputError };
