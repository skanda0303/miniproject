import { listFiles, getFileContent } from './drive.js';
import { analyzeFileContent } from './gemini.js';
import cron from 'node-cron';

export class DriveAgent {
    constructor(auth, db) {
        this.auth = auth;
        this.db = db;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('Drive Agent started...');

        // Run every 15 minutes
        cron.schedule('*/15 * * * *', () => {
            this.processNewFiles();
        });

        // Initial run
        await this.processNewFiles();
    }

    async processNewFiles() {
        console.log('Scanning Drive for new activity...');
        await this.logAction('SCAN_START', 'Scanning for new or updated files...');

        try {
            const files = await listFiles(this.auth, 500); // Increased page size
            let processedCount = 0;
            let skippedCount = 0;

            for (const file of files) {
                // Filter for Documents, Spreadsheets, Presentations
                const allowedMimeTypes = [
                    'text/csv',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // Excel
                    'application/pdf',
                    'application/vnd.ms-powerpoint',
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PPTX
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
                    'application/vnd.google-apps.spreadsheet',
                    'application/vnd.google-apps.presentation',
                    'application/vnd.google-apps.document'
                ];

                const existing = await this.db.get('SELECT * FROM files WHERE id = ?', file.id);

                if (!existing || existing.modifiedTime !== file.modifiedTime) {
                    await this.logAction('PROCESSING', `Checking: ${file.name} (${file.mimeType})`);

                    try {
                        let content = null;
                        let analysis = null;

                        // Try to read content for supported types
                        try {
                            content = await getFileContent(this.auth, file.id, file.mimeType);
                        } catch (readError) {
                            console.log(`Could not read content for ${file.name}, using metadata only.`);
                            content = null;
                        }

                        // Analyze with Gemini (or fallback to metadata categorization)
                        if (content && typeof content === 'string' && !content.startsWith('[Binary')) {
                            analysis = await analyzeFileContent(file.name, content);
                        } else {
                            // Fallback: Ask Gemini to categorize based ONLY on name
                            analysis = await analyzeFileContent(file.name, `[NO CONTENT READABLE] MimeType: ${file.mimeType}`);
                        }

                        // Safety fallback if Gemini completely fails
                        if (!analysis) {
                            analysis = {
                                summary: 'Analysis failed',
                                tags: ['uncategorized', 'error'],
                                value_score: 0,
                                category: 'Uncategorized'
                            };
                        }

                        // Store results (Even if it failed, so we don't retry incessantly)
                        await this.db.run(
                            `INSERT OR REPLACE INTO files (id, name, mimeType, modifiedTime, summary, tags, value_score, processed_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                file.id,
                                file.name,
                                file.mimeType,
                                file.modifiedTime,
                                analysis.summary || 'No summary available',
                                JSON.stringify(analysis.tags || []),
                                analysis.value_score || 5,
                                new Date().toISOString()
                            ]
                        );

                        processedCount++;
                        await this.logAction('ANALYZED', `Processed: ${file.name}`);

                        // Reorganization suggestion
                        if (analysis.category && analysis.category !== 'Uncategorized' && analysis.category !== 'Other') {
                            await this.db.run(
                                `INSERT INTO reorganization_suggestions (file_id, original_path, suggested_path, reason)
                                 VALUES (?, ?, ?, ?)`,
                                [file.id, file.name, analysis.category, `Auto-categorized as "${analysis.category}"`]
                            );
                            await this.logAction('SUGGESTION', `Proposed: ${file.name} -> ${analysis.category}`);
                        }
                    } catch (e) {
                        // Critical failure for this file - mark as processed with Error so we move on
                        console.error(`CRITICAL FAIL ${file.name}:`, e);
                        await this.db.run(
                            `INSERT OR REPLACE INTO files (id, name, mimeType, modifiedTime, summary, tags, value_score, processed_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [file.id, file.name, file.mimeType, file.modifiedTime, `Error: ${e.message}`, '[]', 0, new Date().toISOString()]
                        );
                        await this.logAction('ERROR', `Skipped ${file.name} due to internal error`);
                    }
                } else {
                    skippedCount++;
                }
            }

            await this.logAction('SCAN_COMPLETE', `Scan finished. Processed: ${processedCount}, Already Indexed: ${skippedCount}`);
        } catch (error) {
            console.error('Agent processing error:', error);
            await this.logAction('CRITICAL_ERROR', 'Failed to complete Drive scan.');
        }
    }

    async logAction(action, details) {
        await this.db.run(
            'INSERT INTO logs (timestamp, action, details) VALUES (?, ?, ?)',
            [new Date().toISOString(), action, details]
        );
    }

    async queryFiles(query) {
        // Enhanced search: check summary, name, and tags
        const searchTerm = `%${query.toLowerCase()}%`;
        console.log(`[queryFiles] Searching for: "${searchTerm}"`);

        const results = await this.db.all(
            `SELECT * FROM files 
             WHERE LOWER(summary) LIKE ? 
             OR LOWER(name) LIKE ? 
             OR LOWER(tags) LIKE ?
             ORDER BY value_score DESC
             LIMIT 20`,
            [searchTerm, searchTerm, searchTerm]
        );

        console.log(`[queryFiles] Found ${results.length} results`);
        return results;
    }
}
