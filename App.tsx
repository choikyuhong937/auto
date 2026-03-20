import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { AutobiographyPanel } from './components/AutobiographyPanel';
import {
  loadData,
  saveData,
  createDefaultData,
  exportBackup,
  importBackup,
  getLastBackupMilestone,
  setLastBackupMilestone,
  type AutobiographyData,
  type ChatMessage,
  type Chapter,
} from './services/storageService';
import { sendMessage, generateGreeting, type GeminiResponse } from './services/geminiService';

declare global {
  interface Window {
    Kakao: any;
  }
}

type Tab = 'chat' | 'book';

const KAKAO_APP_KEY = '29011e480114ee01b0c0822d028a820d';

const App: React.FC = () => {
  const [data, setData] = useState<AutobiographyData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [requestingPhoto, setRequestingPhoto] = useState(false);
  const [pendingChapter, setPendingChapter] = useState<Chapter | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [showSetup, setShowSetup] = useState(false);
  const [showBackupPrompt, setShowBackupPrompt] = useState(false);
  const [showBackupMenu, setShowBackupMenu] = useState(false);
  const backupFileRef = useRef<HTMLInputElement>(null);

  // Initialize Kakao SDK
  useEffect(() => {
    if (window.Kakao && !window.Kakao.isInitialized()) {
      window.Kakao.init(KAKAO_APP_KEY);
    }
  }, []);

  // Load saved data on mount
  useEffect(() => {
    loadData().then((saved) => {
      if (saved && saved.geminiApiKey) {
        setData(saved);
      } else {
        setShowSetup(true);
        setData(createDefaultData());
      }
    });
  }, []);

  // Auto-save whenever data changes
  useEffect(() => {
    if (data) {
      saveData(data);
    }
  }, [data]);

  // 10% 단위로 백업 권유
  useEffect(() => {
    if (!data || data.progress === 0) return;
    const currentMilestone = Math.floor(data.progress / 10) * 10;
    const lastMilestone = getLastBackupMilestone();
    if (currentMilestone > lastMilestone && currentMilestone >= 10) {
      setShowBackupPrompt(true);
    }
  }, [data?.progress]);

  const handleSetup = async (apiKey: string, name: string, birthYear: number) => {
    const newData = {
      ...(createDefaultData()),
      geminiApiKey: apiKey,
      userName: name,
      birthYear,
    };
    setData(newData);
    setShowSetup(false);

    // AI가 먼저 대화를 시작 - 사용자 메시지 없이 AI가 인사
    setIsLoading(true);
    try {
      const response = await generateGreeting(apiKey, name, birthYear);

      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: response.message,
        timestamp: Date.now(),
      };

      setData((prev) => prev ? {
        ...prev,
        chatHistory: [assistantMsg],
      } : prev);
    } catch (error: any) {
      const errorMsg: ChatMessage = {
        id: `${Date.now()}-error`,
        role: 'assistant',
        content: `오류가 발생했습니다: ${error.message || '알 수 없는 오류'}. API 키를 확인해주세요.`,
        timestamp: Date.now(),
      };
      setData((prev) => prev ? {
        ...prev,
        chatHistory: [errorMsg],
      } : prev);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendMessage = useCallback(
    async (text: string, imageData?: string) => {
      if (!data) return;

      const userMsg: ChatMessage = {
        id: `${Date.now()}-user`,
        role: 'user',
        content: text,
        imageData,
        timestamp: Date.now(),
      };

      const updatedHistory = [...data.chatHistory, userMsg];
      setData((prev) => prev ? { ...prev, chatHistory: updatedHistory } : prev);
      setIsLoading(true);

      try {
        const response: GeminiResponse = await sendMessage(
          data.geminiApiKey,
          data.chatHistory,
          text,
          data.currentChapter,
          data.chapters,
          imageData,
          data.userName,
          data.birthYear
        );

        const assistantMsg: ChatMessage = {
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: response.message,
          timestamp: Date.now(),
        };

        setRequestingPhoto(response.requestPhoto);

        if (response.progress !== undefined) {
          setData((prev) => prev ? { ...prev, progress: response.progress! } : prev);
        }

        if (response.chapterComplete && response.chapter) {
          const newChapter: Chapter = {
            id: data.currentChapter,
            title: response.chapter.title,
            content: response.chapter.content,
            photos: [],
            confirmed: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          setPendingChapter(newChapter);
          // Switch to book tab on mobile to show the new chapter
          setActiveTab('book');
        }

        setData((prev) =>
          prev
            ? { ...prev, chatHistory: [...updatedHistory, assistantMsg] }
            : prev
        );
      } catch (error: any) {
        const errorMsg: ChatMessage = {
          id: `${Date.now()}-error`,
          role: 'assistant',
          content: `오류가 발생했습니다: ${error.message || '알 수 없는 오류'}. API 키를 확인해주세요.`,
          timestamp: Date.now(),
        };
        setData((prev) =>
          prev
            ? { ...prev, chatHistory: [...updatedHistory, errorMsg] }
            : prev
        );
      } finally {
        setIsLoading(false);
      }
    },
    [data]
  );

  const handleConfirmChapter = useCallback(() => {
    if (!data || !pendingChapter) return;
    const confirmed = { ...pendingChapter, confirmed: true, updatedAt: Date.now() };
    setData((prev) =>
      prev
        ? {
            ...prev,
            chapters: [...prev.chapters, confirmed],
            currentChapter: prev.currentChapter + 1,
          }
        : prev
    );
    setPendingChapter(null);
    setActiveTab('chat');
  }, [data, pendingChapter]);

  const handleEditChapter = useCallback((content: string) => {
    setPendingChapter((prev) =>
      prev ? { ...prev, content, updatedAt: Date.now() } : prev
    );
  }, []);

  const handleEditTitle = useCallback((title: string) => {
    setPendingChapter((prev) =>
      prev ? { ...prev, title, updatedAt: Date.now() } : prev
    );
  }, []);

  const handleShareKakao = useCallback((chapter: Chapter) => {
    if (!window.Kakao?.isInitialized()) return;
    const previewText = chapter.content.length > 100
      ? chapter.content.substring(0, 100) + '...'
      : chapter.content;
    window.Kakao.Share.sendDefault({
      objectType: 'feed',
      content: {
        title: `${data?.userName || '나'}의 자서전 - ${chapter.title}`,
        description: previewText,
        imageUrl: 'https://rsi-predict-three.vercel.app/og-image.png',
        link: {
          mobileWebUrl: window.location.href,
          webUrl: window.location.href,
        },
      },
      buttons: [
        {
          title: '자서전 보기',
          link: {
            mobileWebUrl: window.location.href,
            webUrl: window.location.href,
          },
        },
        {
          title: '나도 만들기',
          link: {
            mobileWebUrl: window.location.href,
            webUrl: window.location.href,
          },
        },
      ],
    });
  }, [data]);

  const handleCopyChapter = useCallback((chapter: Chapter) => {
    const text = `[${data?.userName || '나'}의 자서전]\n\n${chapter.title}\n\n${chapter.content}`;
    navigator.clipboard.writeText(text).then(() => {
      alert('클립보드에 복사되었습니다!');
    });
  }, [data]);

  const handleBackupNow = useCallback(() => {
    if (!data) return;
    exportBackup(data);
    const milestone = Math.floor(data.progress / 10) * 10;
    setLastBackupMilestone(milestone);
    setShowBackupPrompt(false);
  }, [data]);

  const handleDismissBackup = useCallback(() => {
    if (!data) return;
    const milestone = Math.floor(data.progress / 10) * 10;
    setLastBackupMilestone(milestone);
    setShowBackupPrompt(false);
  }, [data]);

  const handleRestore = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const restored = await importBackup(file);
      // API 키가 없으면 현재 키 유지
      if (data?.geminiApiKey) {
        restored.geminiApiKey = data.geminiApiKey;
      }
      if (!restored.geminiApiKey) {
        const key = prompt('API 키를 입력해주세요:');
        if (key) restored.geminiApiKey = key;
        else {
          alert('API 키가 필요합니다.');
          return;
        }
      }
      setData(restored);
      setShowBackupMenu(false);
      alert(`복원 완료! (${restored.chapters.filter(c => c.confirmed).length}개 챕터, 대화 ${restored.chatHistory.length}개)`);
    } catch (err: any) {
      alert(err.message || '복원에 실패했습니다.');
    }
    e.target.value = '';
  }, [data]);

  const handleReset = () => {
    if (confirm('정말로 모든 데이터를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
      setData(createDefaultData());
      setPendingChapter(null);
      setShowSetup(true);
    }
  };

  if (!data) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>불러오는 중...</p>
      </div>
    );
  }

  if (showSetup) {
    return <SetupScreen onComplete={handleSetup} />;
  }

  const hasPending = pendingChapter !== null;
  const pendingCount = data.chapters.filter(c => c.confirmed).length;

  return (
    <div className="app-container">
      {/* Mobile Tab Bar */}
      <div className="mobile-tabs">
        <button
          className={`mobile-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          💬 대화
        </button>
        <button
          className={`mobile-tab ${activeTab === 'book' ? 'active' : ''} ${hasPending ? 'has-pending' : ''}`}
          onClick={() => setActiveTab('book')}
        >
          📖 자서전 {hasPending && <span className="pending-dot"></span>}
          {pendingCount > 0 && <span className="chapter-badge">{pendingCount}</span>}
        </button>
      </div>

      {/* Desktop Layout */}
      <div className="panels-container">
        <div className={`panel-left ${activeTab === 'chat' ? 'mobile-visible' : 'mobile-hidden'}`}>
          <ChatPanel
            messages={data.chatHistory}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
            requestingPhoto={requestingPhoto}
            chapterCount={data.chapters.filter(c => c.confirmed).length}
            chapters={data.chapters}
            currentChapter={data.currentChapter}
            hasPendingChapter={pendingChapter !== null}
            progress={data.progress}
            onViewAutobiography={() => setActiveTab('book')}
          />
        </div>
        <div className={`panel-right ${activeTab === 'book' ? 'mobile-visible' : 'mobile-hidden'}`}>
          <AutobiographyPanel
            chapters={data.chapters}
            pendingChapter={pendingChapter}
            onConfirmChapter={handleConfirmChapter}
            onEditChapter={handleEditChapter}
            onEditTitle={handleEditTitle}
            userName={data.userName}
            onShareKakao={handleShareKakao}
            onCopyChapter={handleCopyChapter}
            progress={data.progress}
          />
        </div>
      </div>

      {/* Settings & Backup buttons */}
      <div className="floating-buttons">
        <button className="backup-btn" onClick={() => setShowBackupMenu(true)} title="백업/복원">
          💾
        </button>
        <button className="settings-btn-float" onClick={handleReset} title="초기화">
          ⚙️
        </button>
      </div>

      {/* Hidden file input for restore */}
      <input
        type="file"
        ref={backupFileRef}
        accept=".json"
        onChange={handleRestore}
        style={{ display: 'none' }}
      />

      {/* 10% 단위 백업 권유 팝업 */}
      {showBackupPrompt && (
        <div className="backup-prompt-overlay" onClick={handleDismissBackup}>
          <div className="backup-prompt" onClick={(e) => e.stopPropagation()}>
            <div className="backup-prompt-icon">💾</div>
            <h3>백업하시겠어요?</h3>
            <p>자서전이 {data?.progress}%까지 진행됐어요!<br/>혹시 모를 상황에 대비해 백업해두세요.</p>
            <div className="backup-prompt-actions">
              <button className="backup-prompt-later" onClick={handleDismissBackup}>
                나중에
              </button>
              <button className="backup-prompt-save" onClick={handleBackupNow}>
                지금 백업하기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 백업/복원 메뉴 */}
      {showBackupMenu && (
        <div className="backup-prompt-overlay" onClick={() => setShowBackupMenu(false)}>
          <div className="backup-menu" onClick={(e) => e.stopPropagation()}>
            <h3>백업 / 복원</h3>
            <p className="backup-menu-desc">대화 내용과 자서전을 파일로 저장하거나,<br/>이전에 저장한 파일에서 복원할 수 있어요.</p>
            <button className="backup-menu-item export" onClick={handleBackupNow}>
              <span className="backup-menu-item-icon">📤</span>
              <div>
                <div className="backup-menu-item-title">백업 파일 저장</div>
                <div className="backup-menu-item-sub">현재 대화와 자서전을 파일로 내보내기</div>
              </div>
            </button>
            <button className="backup-menu-item import" onClick={() => backupFileRef.current?.click()}>
              <span className="backup-menu-item-icon">📥</span>
              <div>
                <div className="backup-menu-item-title">백업에서 복원</div>
                <div className="backup-menu-item-sub">저장해둔 파일에서 불러오기</div>
              </div>
            </button>
            <button className="backup-menu-close" onClick={() => setShowBackupMenu(false)}>
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Setup Screen Component
const SetupScreen: React.FC<{ onComplete: (apiKey: string, name: string, birthYear: number) => void }> = ({
  onComplete,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('');
  const [birthYear, setBirthYear] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      onComplete(apiKey.trim(), name.trim(), parseInt(birthYear, 10) || 0);
    }
  };

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-icon">📖</div>
        <h1>나의 자서전</h1>
        <p className="setup-description">
          대화를 하면서 자서전을 만들어 드립니다.<br />
          편하게 이야기하시면 됩니다.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="setup-field">
            <label>이름을 알려주세요</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
              className="setup-input"
            />
          </div>
          <div className="setup-field">
            <label>몇 년생이신가요?</label>
            <input
              type="number"
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value)}
              placeholder="1970"
              className="setup-input"
              min="1920"
              max={new Date().getFullYear()}
            />
          </div>
          <div className="setup-field">
            <label>API 키 입력</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="받으신 API 키를 여기에 붙여넣기"
              className="setup-input"
              required
            />
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="setup-link"
            >
              API 키가 없으시면 여기를 눌러 발급받으세요 →
            </a>
          </div>
          <button type="submit" className="setup-submit" disabled={!apiKey.trim()}>
            시작하기
          </button>
        </form>
      </div>
    </div>
  );
};

export default App;
