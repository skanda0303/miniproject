import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });

export async function analyzeFileContent(fileName, content) {
    try {
        const validCategories = ["Finance", "Legal", "Education", "Projects", "Personal", "Tech", "Work", "Resumes"];

        const prompt = `
          You are a Drive Organization Expert. Analyze this file content and categorize it into ONE of these folders: ${validCategories.join(', ')}.
          
          File Name: ${fileName}
          Content Snippet: ${JSON.stringify(content.substring(0, 8000)) /* Safe stringify to prevent quote breaking */}
          
          Instructions:
          1. Return valid JSON only. No markdown formatting.
          2. Category MUST be one of: ${validCategories.join(', ')}.
          3. Value Score: 1-10 based on importance/density.
          
          Response Format:
          {
            "summary": "3-sentence max summary",
            "tags": ["tag1", "tag2"],
            "value_score": integer,
            "category": "String"
          }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Clean markdown blocks if present
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // Try to find the JSON object if there is extra text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            text = jsonMatch[0];
        }

        try {
            const data = JSON.parse(text);
            // Fallback for categories
            if (!validCategories.includes(data.category)) {
                data.category = "Projects"; // Default safe path
            }
            return data;
        } catch (e) {
            console.log("Gemini JSON Parse Failed. Raw:", text);
            return {
                summary: "Analysis failed due to model output format.",
                tags: ["error"],
                value_score: 0,
                category: "Uncategorized"
            };
        }
    } catch (error) {
        console.error('Gemini Analysis Error:', error);
        return null;
    }
}

export async function generateEmbedding(text) {
    try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await embedModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error('Embedding Error:', error);
        return null;
    }
}
