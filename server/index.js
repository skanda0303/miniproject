import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDb } from './db.js';
import { DriveAgent } from './agent.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

let db;
let agent;

// OAuth2 configuration
const createOAuthClient = () => {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL || `http://localhost:${PORT}/auth/callback`
    );
};

let oauth2Client = createOAuthClient();

const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.metadata.readonly'
];

app.get('/api/status', async (req, res) => {
    const fileCount = await db.get('SELECT COUNT(*) as count FROM files');
    const embeddingCount = await db.get('SELECT COUNT(*) as count FROM embeddings');

    res.json({
        status: 'Agent is running',
        authenticated: !!oauth2Client.credentials.access_token,
        fileCount: fileCount.count,
        indexingComplete: fileCount.count > 0 && embeddingCount.count >= fileCount.count
    });
});

app.get('/auth/url', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.json({ url });
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Save tokens to DB
        await db.run(
            `INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, scope, token_type, expiry_date) 
           VALUES (1, ?, ?, ?, ?, ?)`,
            [tokens.access_token, tokens.refresh_token, tokens.scope, tokens.token_type, tokens.expiry_date]
        );

        // Start the agent
        agent = new DriveAgent(oauth2Client, db);
        agent.start();

        res.send('Authentication successful! The agent is now processing your Drive. You can close this tab.');
    } catch (error) {
        console.error('Error retrieving access token', error);
        res.status(500).send('Authentication failed');
    }
});

app.get('/api/files', async (req, res) => {
    const files = await db.all('SELECT id, name, mimeType, summary, tags, value_score, category, processed_at FROM files ORDER BY processed_at DESC');
    res.json(files);
});

app.post('/api/scan', async (req, res) => {
    if (!agent) return res.status(400).json({ error: 'Agent not started' });

    // Run in background
    agent.processNewFiles().catch(err => console.error("Manual scan error:", err));

    res.json({ message: 'Scan started' });
});

app.post('/api/reset', async (req, res) => {
    if (!agent) return res.status(400).json({ error: 'Agent not started' });

    try {
        // Clear files, embeddings, and suggestions tables
        await db.run('DELETE FROM files');
        await db.run('DELETE FROM embeddings');
        await db.run('DELETE FROM reorganization_suggestions');
        await db.run('DELETE FROM logs');

        await agent.logAction('RESET', 'Database cleared. Starting fresh analysis...');

        // Trigger immediate scan
        agent.processNewFiles().catch(err => console.error("Reset scan error:", err));

        res.json({ message: 'Database reset. Analysis restarted.' });
    } catch (e) {
        console.error('Reset error:', e);
        res.status(500).json({ error: 'Failed to reset database' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        // Stop the agent if running
        if (agent) {
            agent.stop();
            agent = null;
        }

        // Clear tokens and data
        await db.run('DELETE FROM tokens');
        await db.run('DELETE FROM files');
        await db.run('DELETE FROM reorganization_suggestions');
        await db.run('DELETE FROM logs');

        console.log('Before Reset:', oauth2Client.credentials);

        // Completely reset the OAuth client instance
        oauth2Client = createOAuthClient();

        console.log('After Reset:', oauth2Client.credentials);

        res.json({ message: 'Logged out successfully. Tokens and data cleared.' });
    } catch (e) {
        console.error('Logout error:', e);
        res.status(500).json({ error: 'Failed to logout' });
    }
});

app.post('/api/ask', async (req, res) => {
    const { question, history } = req.body;
    if (!agent) return res.status(400).json({ error: 'Agent not started' });

    try {
        // Pure RAG: embed the question and find semantically similar chunks
        console.log(`[RAG] Query: "${question}"`);
        const relevantChunks = await agent.vectorSearch(question);

        // Build context from top chunks
        const contextLines = relevantChunks.map(chunk =>
            `File: ${chunk.fileName} (Category: ${chunk.category || 'Uncategorized'})\nRelevance: ${(chunk.similarity * 100).toFixed(1)}%\nContent: ${chunk.content}`
        );

        // Add global context (folders/stats) so AI can answer meta-questions
        const stats = await db.get('SELECT COUNT(*) as total FROM files');
        const categories = await db.all('SELECT DISTINCT category FROM files');
        const categoryList = categories.map(c => c.category).join(', ');

        const globalContext = `[Drive Overview] Total indexed files: ${stats.total}. Your folders (categories) are: ${categoryList}.`;
        const fullContext = relevantChunks.length > 0
            ? `${globalContext}\n\n${contextLines.join('\n\n---\n\n')}`
            : `${globalContext}\n\nNo specific document fragments matched this query. Use general knowledge if it's a greeting or general question.`;

        // Deduplicate source files for display
        const uniqueFiles = [...new Map(
            relevantChunks.map(item => [
                item.file_id,
                { name: item.fileName, id: item.file_id, category: item.category, similarity: item.similarity }
            ])
        ).values()];

        // Generate answer with Local AI (Gemma 2)
        try {
            const { generateAnswer } = await import('./gemini.js');
            const answer = await generateAnswer(question, fullContext, history);
            res.json({ answer, files: uniqueFiles });
        } catch (genError) {
            console.error('Local AI Error:', genError.message);

            // Return local-focused fallback
            const offlineAnswer = `⚠️ Local AI (Ollama) is currently unavailable or busy. Please ensure the Ollama app is running and 'gemma2' is loaded.\n\n` +
                `**Raw context from your files:**\n` +
                relevantChunks.slice(0, 3).map(c => `📄 ${c.fileName}:\n${c.content}`).join('\n\n---\n\n');

            res.json({ answer: offlineAnswer, files: uniqueFiles });
        }

    } catch (e) {
        console.error('RAG Error:', e);
        res.status(500).json({ error: 'Failed to process RAG request' });
    }
});

app.get('/api/suggestions', async (req, res) => {
    const suggestions = await db.all('SELECT * FROM reorganization_suggestions WHERE status = "PENDING"');
    res.json(suggestions);
});

app.post('/api/approve', async (req, res) => {
    const { id } = req.body;
    const suggestion = await db.get('SELECT * FROM reorganization_suggestions WHERE id = ?', id);

    if (suggestion && agent) {
        try {
            await agent.logAction('EXECUTING', `Moving ${suggestion.original_path} to ${suggestion.suggested_path}...`);

            // 1. Find or create the target folder
            const drive = google.drive({ version: 'v3', auth: oauth2Client });
            let folderId;

            // Check if folder exists
            const folderRes = await drive.files.list({
                q: `name = '${suggestion.suggested_path}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id)'
            });

            if (folderRes.data.files.length > 0) {
                folderId = folderRes.data.files[0].id;
            } else {
                // Create it
                const createRes = await drive.files.create({
                    resource: {
                        name: suggestion.suggested_path,
                        mimeType: 'application/vnd.google-apps.folder'
                    },
                    fields: 'id'
                });
                folderId = createRes.data.id;
                await agent.logAction('DRIVE', `Created new folder: ${suggestion.suggested_path}`);
            }

            // 2. Move the file
            const fileId = suggestion.file_id;
            const fileMetadata = await drive.files.get({ fileId, fields: 'parents' });
            const previousParents = fileMetadata.data.parents ? fileMetadata.data.parents.join(',') : '';

            await drive.files.update({
                fileId,
                addParents: folderId,
                removeParents: previousParents,
                fields: 'id, parents'
            });

            // 3. Mark as COMPLETED in DB
            await db.run('UPDATE reorganization_suggestions SET status = "COMPLETED" WHERE id = ?', id);
            await agent.logAction('SUCCESS', `Successfully moved ${suggestion.original_path} to ${suggestion.suggested_path}`);

            res.json({ success: true });
        } catch (e) {
            console.error('Move error:', e);
            await agent.logAction('FAILURE', `Failed to move ${suggestion.original_path}: ${e.message}`);
            res.status(500).json({ error: 'Failed to move file' });
        }
    } else {
        res.status(404).json({ error: 'Suggestion not found' });
    }
});

app.post('/api/deny', async (req, res) => {
    const { id } = req.body;
    try {
        await db.run('UPDATE reorganization_suggestions SET status = "DENIED" WHERE id = ?', id);
        res.json({ success: true });
    } catch (e) {
        console.error('Deny error:', e);
        res.status(500).json({ error: 'Failed to deny suggestion' });
    }
});

app.listen(PORT, async () => {
    db = await initDb();

    // Auto-load tokens
    const savedTokens = await db.get('SELECT * FROM tokens WHERE id = 1');
    if (savedTokens) {
        oauth2Client.setCredentials({
            access_token: savedTokens.access_token,
            refresh_token: savedTokens.refresh_token,
            scope: savedTokens.scope,
            token_type: savedTokens.token_type,
            expiry_date: savedTokens.expiry_date
        });
        console.log('Restored credentials from DB');
        agent = new DriveAgent(oauth2Client, db);
        agent.start();
    }

    console.log(`Server running on http://localhost:${PORT}`);
});
