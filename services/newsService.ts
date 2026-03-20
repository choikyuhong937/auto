// services/newsService.ts
import { GoogleGenAI } from "@google/genai";
import { geminiRateLimiter } from './geminiService'; // Import the rate limiter instance
import type { NewsArticle } from '../types';
import { v4 as uuidv4 } from 'uuid';

// FIX: Updated model name as per guidelines.
const model = "gemini-3-flash-preview";

/**
 * Fetches recent news articles for a given ticker using Gemini with Google Search grounding.
 * @param ticker The ticker symbol (e.g., 'BTCUSDT').
 * @returns A promise resolving to an array of NewsArticle objects.
 */
export const getRecentNews = async (ticker: string): Promise<NewsArticle[]> => {
    const assetName = ticker.replace('USDT', '');
    const prompt = `Provide a concise, neutral summary of the top 3 most impactful recent news articles and market sentiment shifts for the cryptocurrency ${assetName}. Focus on facts that could influence its price in the short term (e.g., regulatory changes, partnerships, technical updates, major whale movements).`;

    try {
        // Use the rate limiter to enqueue the Gemini API call
        const response = await geminiRateLimiter.enqueue(async () => {
            return await geminiRateLimiter.getAI().models.generateContent({
                model,
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }],
                },
            });
        }, `getRecentNews_${ticker}`); // Provide context for logging

        // FIX: Access the .text property directly for the response content.
        const summary = response.text;
        const citations = response.candidates?.[0]?.groundingMetadata?.groundingChunks;

        const articles: NewsArticle[] = [];
        
        // Add the main summary as a high-impact news item
        articles.push({
            id: uuidv4(),
            headline: `AI 뉴스 요약 (${assetName}): ${summary}`,
            source: "Gemini 실시간 검색",
            timestamp: Date.now(),
            impact: 'high',
        });

        // Add individual citations as medium-impact news items
        if (citations && Array.isArray(citations)) {
            const uniqueUrls = new Set<string>();
            for (const citation of citations) {
                if (citation.web && citation.web.uri && citation.web.title && !uniqueUrls.has(citation.web.uri)) {
                    uniqueUrls.add(citation.web.uri);
                    try {
                        articles.push({
                            id: uuidv4(),
                            headline: citation.web.title,
                            source: new URL(citation.web.uri).hostname.replace('www.', ''), // Extract domain as source
                            timestamp: Date.now() - Math.floor(Math.random() * 3600000), // Stagger timestamp within the last hour
                            impact: 'medium',
                        });
                    } catch (e) {
                        console.warn('Could not parse citation URL:', citation.web.uri);
                    }
                }
            }
        }

        return articles;

    } catch (error: any) { // Catch any errors from enqueue
        console.error(`실시간 뉴스 로딩 실패 (${ticker}):`, error);
        return [{
            id: uuidv4(),
            headline: `실시간 뉴스 로딩 실패: ${error.message || '알 수 없는 오류'}`,
            source: "시스템 오류",
            timestamp: Date.now(),
            impact: 'high',
        }];
    }
};
