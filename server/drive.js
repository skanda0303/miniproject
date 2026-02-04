import { google } from 'googleapis';

export async function listFiles(auth, pageSize = 100) {
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
        pageSize,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)',
        orderBy: 'modifiedTime desc'
    });
    return res.data.files;
}

export async function getFileContent(auth, fileId, mimeType) {
    const drive = google.drive({ version: 'v3', auth });

    try {
        // Text-based files
        if (mimeType.includes('text') || mimeType === 'application/json') {
            const res = await drive.files.get({ fileId, alt: 'media' });
            return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        }

        // Google Formats (Export to text)
        if (mimeType === 'application/vnd.google-apps.document') {
            const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
            return res.data;
        }
        if (mimeType === 'application/vnd.google-apps.spreadsheet') {
            const res = await drive.files.export({ fileId, mimeType: 'text/csv' });
            return res.data;
        }
        if (mimeType === 'application/vnd.google-apps.presentation') {
            const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
            return res.data;
        }

        // Binary files (PDF, PPTX, DOCX, XLSX) - categorize by filename
        if (mimeType === 'application/pdf' ||
            mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
            mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            mimeType === 'application/vnd.ms-powerpoint') {
            return `[Binary Document] Analyze filename and metadata for categorization.`;
        }

    } catch (e) {
        console.error(`Content Read Failed for ${fileId}:`, e.message);
        return null;
    }

    return null;
}

export async function moveFile(auth, fileId, folderId) {
    const drive = google.drive({ version: 'v3', auth });

    // Instead of removing parents (which fails for shared files),
    // just add the new parent. This creates a "shortcut" behavior.
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
