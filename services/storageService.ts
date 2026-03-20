// IndexedDB-based persistence for autobiography data

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageData?: string; // base64 image
  timestamp: number;
}

export interface Chapter {
  id: number;
  title: string;
  content: string;
  photos: string[]; // base64 images associated with this chapter
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AutobiographyData {
  chapters: Chapter[];
  chatHistory: ChatMessage[];
  currentChapter: number;
  userName: string;
  birthYear: number; // 출생연도
  geminiApiKey: string;
  progress: number; // 0~100, AI가 판단한 자서전 전체 진행률
}

const DB_NAME = 'autobiography_db';
const DB_VERSION = 1;
const STORE_NAME = 'autobiography';
const DATA_KEY = 'main';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveData(data: AutobiographyData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, DATA_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadData(): Promise<AutobiographyData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(DATA_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export function createDefaultData(): AutobiographyData {
  return {
    chapters: [],
    chatHistory: [],
    currentChapter: 1,
    userName: '',
    birthYear: 0,
    geminiApiKey: '',
    progress: 0,
  };
}
