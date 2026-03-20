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

// === 백업/복원 ===

const BACKUP_MILESTONE_KEY = 'autobiography_last_backup_milestone';

/** 마지막으로 백업을 권유한 진행률 구간 반환 (0, 10, 20, ...) */
export function getLastBackupMilestone(): number {
  return parseInt(localStorage.getItem(BACKUP_MILESTONE_KEY) || '0', 10);
}

export function setLastBackupMilestone(milestone: number): void {
  localStorage.setItem(BACKUP_MILESTONE_KEY, String(milestone));
}

/** 데이터를 JSON 파일로 내보내기 (API 키 제외) */
export function exportBackup(data: AutobiographyData): void {
  const backup = {
    ...data,
    geminiApiKey: '', // API 키는 백업에 포함하지 않음
    _backupDate: new Date().toISOString(),
    _version: 1,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toLocaleDateString('ko-KR').replace(/\./g, '').replace(/\s/g, '-');
  a.download = `자서전_백업_${data.userName || '나'}_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** JSON 파일에서 데이터 복원 */
export function importBackup(file: File): Promise<AutobiographyData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        // 필수 필드 검증
        if (!parsed.chapters || !parsed.chatHistory || !parsed.userName) {
          reject(new Error('올바른 백업 파일이 아닙니다.'));
          return;
        }
        const restored: AutobiographyData = {
          chapters: parsed.chapters || [],
          chatHistory: parsed.chatHistory || [],
          currentChapter: parsed.currentChapter || 1,
          userName: parsed.userName || '',
          birthYear: parsed.birthYear || 0,
          geminiApiKey: '', // API 키는 사용자가 다시 입력해야 함
          progress: parsed.progress || 0,
        };
        resolve(restored);
      } catch {
        reject(new Error('파일을 읽을 수 없습니다. JSON 형식인지 확인해주세요.'));
      }
    };
    reader.onerror = () => reject(new Error('파일 읽기에 실패했습니다.'));
    reader.readAsText(file);
  });
}
