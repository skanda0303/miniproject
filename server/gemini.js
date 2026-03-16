import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

const embeddingsModel = new GoogleGenerativeAIEmbeddings({
    model: "gemini-embedding-001",
    taskType: TaskType.RETRIEVAL_DOCUMENT,
    apiKey: process.env.GEMINI_API_KEY
});

const OLLAMA_BASE = 'http://127.0.0.1:11434';

export async function analyzeFileContent(fileName, content) {
    const validCategories = ["Finance", "Legal", "Education", "Projects", "Personal", "Tech", "Work", "Resumes"];

    const prompt = `
      You are an expert Document Analyst. Your task is to categorize and summarize this file.
      
      ### Inputs:
      - File Name: ${fileName}
      - Content Snippet: ${content.substring(0, 8000)}
      
      ### Guidelines:
      1. **Inference**: If the content is sparse or contains "sentences with little meaning", use the File Name and any context clues (like keywords) to infer the most likely category.
      2. **Categories**: You MUST choose exactly ONE from: ${validCategories.join(', ')}.
      3. **Summary**: Provide a concise 2-sentence summary. If the file is nearly empty, describe what it *seems* to be based on the title.
      4. **Response Format**: Return valid JSON only.
      
      {
        "summary": "String",
        "tags": ["tag1", "tag2"],
        "value_score": integer (1-10),
        "category": "String"
      }
    `;

    try {
        console.log(`[LOCAL AI] Analyzing ${fileName}...`);
        const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma2:9b',
                prompt: prompt,
                format: 'json',
                stream: false,
                options: { temperature: 0.1 }
            })
        });

        if (response.ok) {
            const data = await response.json();
            // Robust parsing: sometimes local AI wraps JSON in backticks despite format:json
            let cleanResponse = data.response.trim();
            if (cleanResponse.includes('```')) {
                cleanResponse = cleanResponse.replace(/```json/g, '').replace(/```/g, '').trim();
                const match = cleanResponse.match(/\{[\s\S]*\}/);
                if (match) cleanResponse = match[0];
            }

            const result = JSON.parse(cleanResponse);
            if (validCategories.includes(result.category)) {
                return result;
            }
        }
    } catch (ollamaError) {
        console.error(`[LOCAL AI ERROR] Analysis failed for ${fileName}:`, ollamaError.message);
    }

    return {
        summary: "Analysis failed (Local AI Offline).",
        tags: ["error"],
        value_score: 0,
        category: "Uncategorized"
    };
}

export async function generateEmbedding(text) {
    try {
        const response = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma2:9b',
                prompt: text.substring(0, 8000) // Truncate if too long for embedding
            })
        });

        if (response.ok) {
            const data = await response.json();
            return data.embedding;
        }
    } catch (ollamaError) {
        console.error('[LOCAL AI ERROR] Embedding failed:', ollamaError.message);
    }
    return null;
}

export async function generateAnswer(question, context, history = []) {
    // Trim context to top 6 chunks to allow more detail while staying within token limits
    // We split by our custom separator and skip the first item if it's just the global overview to ensure we get actual file content
    const chunks = context.split('\n\n---\n\n');
    const trimmedContext = chunks.slice(0, 7).join('\n\n---\n\n');

    // Format history for the prompt
    const historyString = history.length > 0
        ? history.join('\n')
        : "No previous conversation.";

    const prompt = `You are "Intellect", an intelligent personal assistant for managing Google Drive documents.
Your goal is to help users find information in their files and manage their storage.

### Core Guidelines:
1. **Be Proactive & Conversational**: Respond naturally, but also provide the information found immediately. Don't ask for permission to summarize if you've already found the content.
2. **Proactive Inference**: If the user's queston is brief (e.g., just one or two words like "Budget" or "USN"), try to find relevant files OR explain what you know about that topic in the context of their documents.
3. **Contextual Awareness**: 
   - Use the [Context & Drive Info] below to answer factual questions.
   - If the information isn't in the documents, use your general intelligence but mention you're drawing from broader knowledge.
   - You can see how many files they have and their categories—use this to give "big picture" answers if they ask about their storage.
4. **Tone**: State-of-the-art, premium, and friendly.

### Conversation History:
${historyString}

### Context & Drive Info:
${trimmedContext}

### User's Question:
"${question}"

Assistant:`;

    try {
        console.log('[LOCAL AI] Generating answer with gemma2:9b...');
        const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma2:9b',
                prompt: prompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 512
                }
            })
        });

        if (response.ok) {
            const data = await response.json();
            return data.response.trim();
        }
    } catch (ollamaError) {
        throw new Error(`[OLLAMA_OFFLINE] ${ollamaError.message}`);
    }

    throw new Error('[OLLAMA_ERROR] Model failed to generate response.');
}
