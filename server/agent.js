import { listFiles, getFileContent, ALLOWED_MIME_TYPES } from './drive.js';
import { analyzeFileContent, generateEmbedding } from './gemini.js';
import cron from 'node-cron';
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export class DriveAgent {
    constructor(auth, db) {
        this.auth = auth;
        this.db = db;
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('Drive Agent started (PDF + DOCX only, RAG-powered)...');

        // Run every 15 minutes
        this.task = cron.schedule('0 */6 * * *', () => {
            this.processNewFiles();
        });

        // Initial run
        await this.processNewFiles();
    }

    stop() {
        if (this.task) {
            this.task.stop();
            this.task = null;
        }
        this.isRunning = false;
        console.log('Drive Agent stopped.');
    }

    async processNewFiles() {
        console.log('Scanning Drive for PDF and DOCX files...');
        await this.logAction('SCAN_START', 'Scanning for PDF and Word documents...');

        try {
            // listFiles now only returns PDF and DOCX files
            const files = await listFiles(this.auth, 200);
            let processedCount = 0;
            let skippedCount = 0;

            console.log(`Found ${files.length} PDF/DOCX files in Drive.`);

            for (const file of files) {
                // Double-check MIME type (belt-and-suspenders)
                if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
                    console.log(`Skipping unsupported type: ${file.name} (${file.mimeType})`);
                    skippedCount++;
                    continue;
                }

                const existing = await this.db.get('SELECT * FROM files WHERE id = ?', file.id);
                const embeddingCheck = await this.db.get('SELECT COUNT(*) as count FROM embeddings WHERE file_id = ?', file.id);
                const hasEmbeddings = embeddingCheck && embeddingCheck.count > 0;

                const needsProcessing = !existing || existing.modifiedTime !== file.modifiedTime || !hasEmbeddings;

                if (needsProcessing) {
                    const reason = !existing ? 'New' : !hasEmbeddings ? 'Missing Embeddings' : 'Modified';
                    await this.logAction('PROCESSING', `Analyzing: ${file.name} [${reason}]`);
                    console.log(`Processing: ${file.name} (${file.mimeType}) [${reason}]`);

                    try {
                        // Step 1: Extract text content
                        let content = null;
                        try {
                            content = await getFileContent(this.auth, file.id, file.mimeType);
                        } catch (readError) {
                            console.log(`Could not read content for ${file.name}: ${readError.message}`);
                        }

                        let analysis = null;

                        if (content && typeof content === 'string' && content.trim().length > 50) {
                            // Step 2: AI Analysis — get summary, tags, category, value score
                            console.log(`Running AI analysis on ${file.name}...`);
                            try {
                                analysis = await analyzeFileContent(file.name, content);
                                console.log(`AI Analysis result for ${file.name}: category=${analysis?.category}, score=${analysis?.value_score}`);
                            } catch (aiErr) {
                                console.error(`AI analysis failed for ${file.name}:`, aiErr.message);
                                analysis = null;
                            }

                            // Fallback if AI analysis failed
                            if (!analysis) {
                                analysis = {
                                    summary: `${file.name} — content extracted but AI analysis failed.`,
                                    tags: ['auto-indexed'],
                                    value_score: 3,
                                    category: this.inferCategoryFromName(file.name)
                                };
                            }

                            // Step 3: RAG Indexing — chunk and embed the content
                            await this.indexFileContent(file.id, content, {
                                fileName: file.name,
                                mimeType: file.mimeType,
                                category: analysis.category
                            });

                        } else {
                            // No readable content — metadata-only entry
                            console.log(`No readable content for ${file.name}. Using metadata-only entry.`);
                            analysis = {
                                summary: `${file.name} — could not extract readable text.`,
                                tags: ['no-content'],
                                value_score: 1,
                                category: this.inferCategoryFromName(file.name)
                            };
                        }

                        // Step 4: Store file record with category
                        await this.db.run(
                            `INSERT OR REPLACE INTO files (id, name, mimeType, modifiedTime, summary, tags, value_score, category, processed_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                file.id,
                                file.name,
                                file.mimeType,
                                file.modifiedTime,
                                analysis.summary,
                                JSON.stringify(analysis.tags),
                                analysis.value_score,
                                analysis.category,
                                new Date().toISOString()
                            ]
                        );

                        // Step 5: Create reorganization suggestion if category is meaningful
                        if (analysis.category && analysis.category !== 'Uncategorized') {
                            await this.createFolderSuggestion(file.id, file.name, analysis.category, analysis.summary);
                        }

                        processedCount++;
                        await this.logAction('ANALYZED', `✓ ${file.name} → [${analysis.category}] (score: ${analysis.value_score})`);

                        // Rate limiting: wait between files to respect Gemini API limits
                        console.log('Waiting 6s between files to respect rate limits...');
                        await new Promise(resolve => setTimeout(resolve, 6000));

                    } catch (e) {
                        console.error(`CRITICAL FAIL ${file.name}:`, e);
                        await this.db.run(
                            `INSERT OR REPLACE INTO files (id, name, mimeType, modifiedTime, summary, tags, value_score, category, processed_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [file.id, file.name, file.mimeType, file.modifiedTime, `Error: ${e.message}`, '[]', 0, 'Uncategorized', new Date().toISOString()]
                        );
                        await this.logAction('ERROR', `Failed to process ${file.name}: ${e.message}`);
                    }
                } else {
                    skippedCount++;
                }
            }

            await this.logAction('SCAN_COMPLETE', `Scan done. Processed: ${processedCount}, Already indexed: ${skippedCount}`);
            console.log(`Scan complete. Processed: ${processedCount}, Skipped: ${skippedCount}`);
        } catch (error) {
            console.error('Agent processing error:', error);
            await this.logAction('CRITICAL_ERROR', `Drive scan failed: ${error.message}`);
        }
    }

    /**
     * Infer a rough category from the filename when AI analysis is unavailable.
     */
    inferCategoryFromName(fileName) {
        const lower = fileName.toLowerCase();
        if (lower.includes('resume') || lower.includes('cv')) return 'Resumes';
        if (lower.includes('invoice') || lower.includes('receipt') || lower.includes('finance') || lower.includes('budget')) return 'Finance';
        if (lower.includes('contract') || lower.includes('agreement') || lower.includes('legal')) return 'Legal';
        if (lower.includes('lab') || lower.includes('assignment') || lower.includes('lecture') || lower.includes('notes') || lower.includes('study')) return 'Education';
        if (lower.includes('project') || lower.includes('proposal') || lower.includes('report')) return 'Projects';
        if (lower.includes('tech') || lower.includes('code') || lower.includes('api') || lower.includes('software')) return 'Tech';
        return 'Work';
    }

    /**
     * Create or update a reorganization suggestion for a file.
     */
    async createFolderSuggestion(fileId, fileName, category, reason) {
        try {
            // Check if a suggestion already exists for this file
            const existing = await this.db.get(
                `SELECT id FROM reorganization_suggestions WHERE file_id = ? AND status = 'PENDING'`,
                fileId
            );

            if (!existing) {
                await this.db.run(
                    `INSERT INTO reorganization_suggestions (file_id, original_path, suggested_path, reason, status) VALUES (?, ?, ?, ?, 'PENDING')`,
                    [fileId, fileName, category, `AI categorized as "${category}": ${reason?.substring(0, 120) || 'No reason provided'}`]
                );
                console.log(`Folder suggestion created: ${fileName} → ${category}`);
            }
        } catch (e) {
            console.error(`Failed to create folder suggestion for ${fileName}:`, e.message);
        }
    }

    /**
     * Chunk and embed file content into the vector store (SQLite embeddings table).
     */
    async indexFileContent(fileId, content, metadata) {
        try {
            console.log(`Indexing content for ${metadata.fileName} (${content.length} chars)...`);

            // Delete existing embeddings for this file before re-indexing
            await this.db.run('DELETE FROM embeddings WHERE file_id = ?', fileId);

            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: 800,
                chunkOverlap: 150,
            });

            const docs = await splitter.createDocuments([content]);
            console.log(`Split into ${docs.length} chunks.`);

            let successCount = 0;

            for (let i = 0; i < docs.length; i++) {
                const doc = docs[i];
                let retries = 3;
                let embedding = null;

                while (retries > 0 && !embedding) {
                    try {
                        embedding = await generateEmbedding(doc.pageContent);
                    } catch (err) {
                        console.error(`Embedding failed (chunk ${i + 1}/${docs.length}, retries left: ${retries - 1}):`, err.message);
                        if (err.message.includes('429')) {
                            let delay = (4 - retries) * 8000;
                            const match = err.message.match(/retry in ([\d\.]+)s/);
                            if (match) {
                                delay = Math.ceil(parseFloat(match[1]) * 1000) + 2000;
                                console.log(`API requested wait: ${delay}ms`);
                            }
                            console.log(`Rate limited. Waiting ${delay}ms...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        }
                        retries--;
                    }
                }

                if (embedding) {
                    await this.db.run(
                        `INSERT INTO embeddings (file_id, content, embedding, metadata) VALUES (?, ?, ?, ?)`,
                        [fileId, doc.pageContent, JSON.stringify(embedding), JSON.stringify(metadata)]
                    );
                    successCount++;
                } else {
                    console.error(`Failed to embed chunk ${i + 1} of ${metadata.fileName} after all retries.`);
                }

                // Throttle between chunks
                await new Promise(resolve => setTimeout(resolve, 4000));
            }

            console.log(`Indexed ${successCount}/${docs.length} chunks for ${metadata.fileName}`);
        } catch (e) {
            console.error(`Indexing failed for ${fileId}:`, e);
        }
    }

    async logAction(action, details) {
        await this.db.run(
            'INSERT INTO logs (timestamp, action, details) VALUES (?, ?, ?)',
            [new Date().toISOString(), action, details]
        );
    }

    /**
     * Smart RAG search:
     * 1. If query mentions a specific filename → instantly fetch those chunks (no API call needed)
     * 2. Otherwise → generate query embedding with a 30s timeout, then cosine similarity
     * 3. Final fallback → keyword search within embedded content
     */
    async vectorSearch(query) {
        console.log(`[RAG] Searching for: "${query}"`);

        // ── Step 1: Filename-aware fast path ─────────────────────────────────
        // If the user mentions a specific file by name OR any word in the query
        // matches a significant part of a filename stem, skip embedding entirely
        const allFiles = await this.db.all('SELECT id, name FROM files');
        const qLower = query.toLowerCase();
        const qWords = qLower.split(/\s+/).filter(w => w.length > 3);

        const mentionedFile = allFiles.find(f => {
            const fname = f.name.toLowerCase();
            const stem = fname.replace(/\.[^.]+$/, ''); // strip extension
            // Full name/stem match, OR any query word appears in the stem
            return qLower.includes(fname) || qLower.includes(stem) ||
                qWords.some(w => stem.includes(w));
        });

        if (mentionedFile) {
            console.log(`[RAG] Filename detected in query: "${mentionedFile.name}" — fetching chunks directly.`);
            const chunks = await this.db.all(
                'SELECT * FROM embeddings WHERE file_id = ? ORDER BY id ASC',
                mentionedFile.id
            );
            if (chunks.length > 0) {
                // Return up to 10 chunks from this specific file
                return chunks.slice(0, 10).map(r => {
                    const metadata = JSON.parse(r.metadata);
                    return {
                        file_id: r.file_id,
                        content: r.content,
                        fileName: metadata.fileName,
                        category: metadata.category || 'Uncategorized',
                        similarity: 1.0,
                        source: 'filename-match'
                    };
                });
            }
            console.log(`[RAG] File found in DB but no embeddings yet for "${mentionedFile.name}".`);
        }

        // ── Step 2: Vector search with 30s timeout ───────────────────────────
        let queryEmbedding = null;
        try {
            const embeddingPromise = generateEmbedding(query);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Embedding timeout after 30s')), 30000)
            );
            queryEmbedding = await Promise.race([embeddingPromise, timeoutPromise]);
        } catch (e) {
            console.error('[RAG] Embedding failed or timed out:', e.message);
        }

        let vectorResults = [];
        if (queryEmbedding) {
            const allEmbeddings = await this.db.all('SELECT * FROM embeddings');

            if (allEmbeddings.length > 0) {
                const scored = allEmbeddings.map(record => {
                    const recordEmbedding = JSON.parse(record.embedding);
                    const metadata = JSON.parse(record.metadata);
                    const sim = this.cosineSimilarity(queryEmbedding, recordEmbedding);
                    return {
                        file_id: record.file_id,
                        content: record.content,
                        fileName: metadata.fileName,
                        category: metadata.category || 'Uncategorized',
                        similarity: isNaN(sim) ? 0 : sim,
                        source: 'vector'
                    };
                });

                scored.sort((a, b) => b.similarity - a.similarity);
                vectorResults = scored.filter(r => r.similarity > 0.25).slice(0, 8);
                console.log(`[RAG] Vector: found ${vectorResults.length} chunks above 0.25. Best: ${scored[0]?.similarity.toFixed(4) ?? 0}`);
            }
        }

        // ── Step 3: Keyword search (Hybrid supplement) ──────────────────────
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why', 'when', 'where', 'who', 'which', 'summarize', 'explain', 'tell', 'me', 'about', 'pdf', 'file', 'files', 'document', 'my', 'in', 'of', 'for', 'to', 'and', 'or', 'with', 'from', 'can', 'you', 'please', 'know']);

        const keywords = query.toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w))
            .flatMap(w => w.endsWith('s') && w.length > 4 ? [w, w.slice(0, -1)] : [w]);

        const uniqueKeywords = [...new Set(keywords)];

        if (uniqueKeywords.length > 0) {
            console.log(`[RAG] Keyword search with: ${uniqueKeywords.join(', ')}`);
            const contentConditions = uniqueKeywords.map(() => 'LOWER(e.content) LIKE ?').join(' OR ');
            const nameConditions = uniqueKeywords.map(() => 'LOWER(f.name) LIKE ?').join(' OR ');
            const params = uniqueKeywords.map(k => `%${k}%`);

            // Cast a wide net: fetch up to 50 candidates, then rank in JS
            const candidateResults = await this.db.all(
                `SELECT e.file_id, e.content, e.metadata
                 FROM embeddings e
                 JOIN files f ON e.file_id = f.id
                 WHERE ${contentConditions} OR ${nameConditions}
                 LIMIT 50`,
                [...params, ...params]
            );

            if (candidateResults.length > 0) {
                // Score each chunk by how many unique query keywords it contains
                const scored = candidateResults.map(r => {
                    const metadata = JSON.parse(r.metadata);
                    const contentLower = r.content.toLowerCase();
                    const matchCount = uniqueKeywords.filter(k => contentLower.includes(k)).length;
                    const matchRatio = matchCount / uniqueKeywords.length;
                    return {
                        file_id: r.file_id,
                        content: r.content,
                        fileName: metadata.fileName,
                        category: metadata.category || 'Uncategorized',
                        similarity: 0.5 + (0.45 * matchRatio),
                        matchCount,
                        matchRatio,
                        source: 'keyword'
                    };
                });

                // Sort by coverage (most keywords matched first)
                scored.sort((a, b) => b.matchRatio - a.matchRatio);

                // Only keep chunks matching at least 25% of keywords for multi-word queries
                const minCoverage = uniqueKeywords.length > 3 ? 0.25 : 0;
                const topKeywordResults = scored.filter(s => s.matchRatio > minCoverage).slice(0, 10);

                console.log(`[RAG] Keyword: ${candidateResults.length} candidates -> ${topKeywordResults.length} after coverage filter. Best: ${topKeywordResults[0]?.matchCount}/${uniqueKeywords.length}`);

                topKeywordResults.forEach(kw => {
                    const existing = vectorResults.find(v => v.content === kw.content);
                    if (existing) {
                        existing.similarity = Math.max(existing.similarity, kw.similarity);
                        existing.source = existing.source === 'vector' ? 'hybrid' : existing.source;
                    } else {
                        vectorResults.push(kw);
                    }
                });
            }
        }

        if (vectorResults.length > 0) {
            return vectorResults.sort((a, b) => b.similarity - a.similarity).slice(0, 8);
        }

        // ── Step 4: Final fallback ──────────────────────────────────────────
        console.log('[RAG] No matches. Returning best-effort chunks.');
        const finalFallback = await this.db.all('SELECT * FROM embeddings ORDER BY id ASC LIMIT 5');
        return finalFallback.map(r => {
            const metadata = JSON.parse(r.metadata);
            return { file_id: r.file_id, content: r.content, fileName: metadata.fileName, category: metadata.category || 'Uncategorized', similarity: 0.1, source: 'fallback' };
        });

    }

    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            // Log once if mismatch to avoid spamming
            if (vecA && vecB && vecA.length !== vecB.length && !this._dimWarned) {
                console.warn(`[RAG] Embedding DIMENSION MISMATCH: Query(${vecA.length}) != DB(${vecB.length}). You may need to re-index your files.`);
                this._dimWarned = true;
            }
            return 0;
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dotProduct / denom;
    }
}
