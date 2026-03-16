import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { getTextExtractor } from 'office-text-extractor';

const require = createRequire(import.meta.url);
// pdf-parse v2.x exports a PDFParse class (not a default function)
const { PDFParse } = require('pdf-parse');

const officeParser = getTextExtractor();

// Only these MIME types will be processed — PDF and Word documents only
export const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
];

export async function listFiles(auth, pageSize = 200) {
    const drive = google.drive({ version: 'v3', auth });

    // Build a query that only fetches PDF and DOCX files from Drive
    const mimeQuery = ALLOWED_MIME_TYPES.map(m => `mimeType = '${m}'`).join(' or ');

    const res = await drive.files.list({
        pageSize,
        q: `(${mimeQuery}) and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)',
        orderBy: 'modifiedTime desc'
    });
    return res.data.files || [];
}

/**
 * Robustly convert any response data into a Node.js Buffer.
 */
function toBuffer(data) {
    if (!data) return null;
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (data instanceof Uint8Array) return Buffer.from(data);
    // Axios/googleapis sometimes returns a stream or object with arrayBuffer()
    if (typeof data.arrayBuffer === 'function') return null; // handled async below
    // If it's a plain object (e.g. JSON accidentally returned), bail
    if (typeof data === 'object') {
        try {
            const str = JSON.stringify(data);
            console.warn('[toBuffer] Got JSON object instead of binary:', str.substring(0, 200));
        } catch (_) { }
        return null;
    }
    return null;
}

/**
 * Download a file from Drive as a raw Buffer.
 * Uses stream piping to avoid memory issues with large files.
 */
async function downloadAsBuffer(drive, fileId) {
    return new Promise(async (resolve, reject) => {
        try {
            const res = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );

            const chunks = [];
            res.data.on('data', chunk => chunks.push(chunk));
            res.data.on('end', () => resolve(Buffer.concat(chunks)));
            res.data.on('error', err => reject(err));
        } catch (e) {
            reject(e);
        }
    });
}

export async function getFileContent(auth, fileId, mimeType) {
    const drive = google.drive({ version: 'v3', auth });

    try {
        // ── PDF Handling ──────────────────────────────────────────────────────
        if (mimeType === 'application/pdf') {
            console.log(`[PDF] Downloading ${fileId} via stream...`);
            try {
                const buffer = await downloadAsBuffer(drive, fileId);

                if (!buffer || buffer.length === 0) {
                    console.warn(`[PDF] Empty buffer for ${fileId}`);
                    return null;
                }

                console.log(`[PDF] Buffer size: ${buffer.length} bytes`);

                // Verify it actually starts with the PDF magic bytes
                const magic = buffer.slice(0, 5).toString('ascii');
                if (!magic.startsWith('%PDF')) {
                    console.warn(`[PDF] File ${fileId} does not start with %PDF (got: ${magic}). Skipping.`);
                    return null;
                }

                // Use pdf-parse v2.x API: new PDFParse({data: buffer}).getText()
                const parser = new PDFParse({ data: buffer });
                const result = await parser.getText();

                // getText() returns { text, pages, ... }
                const text = typeof result === 'string' ? result : result?.text;

                if (!text || text.trim().length < 20) {
                    console.warn(`[PDF] Extracted text too short for ${fileId} (${text?.length ?? 0} chars). File may be scanned/image-only.`);
                    return null;
                }

                console.log(`[PDF] Extracted ${text.length} chars from ${fileId}`);
                return text;

            } catch (pdfError) {
                console.error(`[PDF] Parse error for ${fileId}:`, pdfError.message);
                return null;
            }
        }

        // ── DOCX Handling ─────────────────────────────────────────────────────
        if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            console.log(`[DOCX] Downloading ${fileId} via stream...`);
            const tempFilePath = path.join(os.tmpdir(), `agent_${fileId}_${Date.now()}.docx`);

            try {
                const buffer = await downloadAsBuffer(drive, fileId);

                if (!buffer || buffer.length === 0) {
                    console.warn(`[DOCX] Empty buffer for ${fileId}`);
                    return null;
                }

                console.log(`[DOCX] Buffer size: ${buffer.length} bytes`);
                await fs.promises.writeFile(tempFilePath, buffer);

                // Try office-text-extractor first
                try {
                    const text = await officeParser.extractText({ input: tempFilePath, type: 'file' });
                    if (text && text.trim().length > 20) {
                        console.log(`[DOCX] Extracted ${text.length} chars from ${fileId}`);
                        return text;
                    }
                    console.warn(`[DOCX] office-text-extractor returned short/empty text for ${fileId}`);
                } catch (officeErr) {
                    console.error(`[DOCX] office-text-extractor failed for ${fileId}:`, officeErr.message);
                }

                // Fallback: export DOCX as plain text via Drive API
                console.log(`[DOCX] Trying Drive export as plain text for ${fileId}...`);
                try {
                    // Note: This only works for Google Docs, not native DOCX.
                    // But worth trying as a last resort.
                    const exportRes = await drive.files.export({ fileId, mimeType: 'text/plain' });
                    if (exportRes.data && typeof exportRes.data === 'string' && exportRes.data.trim().length > 20) {
                        console.log(`[DOCX] Drive export succeeded: ${exportRes.data.length} chars`);
                        return exportRes.data;
                    }
                } catch (_) {
                    // Expected to fail for native DOCX — ignore
                }

                return null;

            } catch (docxError) {
                console.error(`[DOCX] Download error for ${fileId}:`, docxError.message);
                return null;
            } finally {
                // Cleanup temp file
                fs.unlink(tempFilePath, err => {
                    if (err && err.code !== 'ENOENT') console.error('[DOCX] Temp cleanup error:', err.message);
                });
            }
        }

    } catch (e) {
        console.error(`[getFileContent] Unexpected error for ${fileId} (${mimeType}):`, e.message);
        return null;
    }

    return null;
}

export async function moveFile(auth, fileId, folderId) {
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.update({
        fileId,
        addParents: folderId,
        fields: 'id, parents'
    });
    return res.data;
}

export async function createFolder(auth, name, parentId = null) {
    const drive = google.drive({ version: 'v3', auth });
    const fileMetadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };
    const res = await drive.files.create({
        resource: fileMetadata,
        fields: 'id'
    });
    return res.data.id;
}
