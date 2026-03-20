import React, { useState, useRef, useEffect } from 'react';
import type { ChatMessage, Chapter } from '../services/storageService';

// 한글 기준 약 800자 = 1페이지 (A4, 11pt 기준 추정)
const CHARS_PER_PAGE = 800;

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (text: string, imageData?: string) => void;
  isLoading: boolean;
  requestingPhoto: boolean;
  chapterCount: number;
  chapters: Chapter[];
  currentChapter: number;
  hasPendingChapter: boolean;
  progress: number;
  onViewAutobiography: () => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  onSendMessage,
  isLoading,
  requestingPhoto,
  chapterCount,
  chapters,
  currentChapter,
  hasPendingChapter,
  progress,
  onViewAutobiography,
}) => {
  const [input, setInput] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSend = () => {
    const text = input.trim();
    if (!text && !previewImage) return;
    onSendMessage(text || '(사진을 보냈습니다)', previewImage || undefined);
    setInput('');
    setPreviewImage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h2>대화</h2>
        <span className="chat-subtitle">AI와 대화하며 자서전을 만들어보세요</span>
      </div>

      {/* 자서전 진행 상황 위젯 */}
      {(() => {
        const confirmedChapters = chapters.filter(c => c.confirmed);
        const totalChars = confirmedChapters.reduce((sum, ch) => sum + ch.content.length, 0);
        const pageCount = totalChars / CHARS_PER_PAGE;
        const hasContent = confirmedChapters.length > 0 || hasPendingChapter;

        // 실제 소요 시간 기반 추산: 챕터가 2개 이상이면 평균 계산, 아니면 표시 안함
        let avgMinutesPerChapter: number | null = null;
        if (confirmedChapters.length >= 2) {
          const firstCreated = confirmedChapters[0].createdAt;
          const lastCreated = confirmedChapters[confirmedChapters.length - 1].createdAt;
          const totalMinutes = (lastCreated - firstCreated) / 1000 / 60;
          avgMinutesPerChapter = Math.round(totalMinutes / (confirmedChapters.length - 1));
        }

        if (!hasContent) return null;

        return (
          <div className="progress-widget">
            {/* 메인 배너 (기존 기능 유지) */}
            <div className="chapter-progress-banner" onClick={onViewAutobiography}>
              <div className="chapter-progress-info">
                <span className="chapter-progress-icon">📖</span>
                <span className="chapter-progress-text">
                  {hasPendingChapter
                    ? `자서전 ${chapterCount}챕터 완성 + 새 챕터 확인 대기중!`
                    : `자서전 ${chapterCount}챕터 완성`}
                </span>
              </div>
              <button className="chapter-progress-btn">
                {hasPendingChapter ? '확인하기' : '보러가기'}
              </button>
            </div>

            {/* 상세 진행 상황 */}
            <div className="progress-details">
              {/* 진행률 바 */}
              <div className="progress-bar-section">
                <div className="progress-bar-header">
                  <span className="progress-bar-label">자서전 진행률</span>
                  <span className="progress-bar-percent">{progress}%</span>
                </div>
                <div className="progress-bar-track">
                  <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
                </div>
              </div>

              {/* 통계 카드 */}
              <div className="progress-stats">
                <div className="progress-stat-item">
                  <span className="progress-stat-value">
                    {confirmedChapters.length > 0 ? (pageCount >= 1 ? pageCount.toFixed(1) : '< 1') : '0'}
                  </span>
                  <span className="progress-stat-label">페이지</span>
                </div>
                <div className="progress-stat-divider"></div>
                <div className="progress-stat-item">
                  <span className="progress-stat-value">{confirmedChapters.length}개</span>
                  <span className="progress-stat-label">완성 챕터</span>
                </div>
                <div className="progress-stat-divider"></div>
                <div className="progress-stat-item">
                  <span className="progress-stat-value">
                    {totalChars > 0 ? totalChars.toLocaleString() : '0'}
                  </span>
                  <span className="progress-stat-label">글자수</span>
                </div>
              </div>

              {/* 챕터별 소요시간 & 다음 챕터 예상 */}
              {avgMinutesPerChapter !== null && (
                <div className="progress-next-chapter">
                  <span className="progress-next-label">챕터당 평균:</span>
                  <span className="progress-next-name">
                    {avgMinutesPerChapter >= 60
                      ? `약 ${Math.round(avgMinutesPerChapter / 60)}시간 ${avgMinutesPerChapter % 60}분`
                      : `약 ${avgMinutesPerChapter}분`}
                  </span>
                </div>
              )}

              {/* 현재 진행 중 챕터 안내 */}
              {hasPendingChapter ? (
                <div className="progress-next-chapter pending">
                  <span className="progress-next-label">새 챕터 대기중!</span>
                  <span className="progress-next-name">확인 후 다음으로 넘어가요</span>
                </div>
              ) : (
                <div className="progress-next-chapter">
                  <span className="progress-next-label">Chapter {currentChapter}</span>
                  <span className="progress-next-name">대화 중 자동으로 챕터가 만들어져요</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">📖</div>
            <p>안녕하세요!</p>
            <p>아래 칸에 글을 쓰고 보내기 버튼을 누르시면<br/>자서전 만들기가 시작됩니다.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble ${msg.role}`}>
            <div className="chat-bubble-avatar">
              {msg.role === 'user' ? '🙂' : '✍️'}
            </div>
            <div className="chat-bubble-content">
              {msg.imageData && (
                <img
                  src={msg.imageData}
                  alt="첨부 사진"
                  className="chat-image"
                />
              )}
              <div className="chat-bubble-text">{msg.content}</div>
              <div className="chat-bubble-time">
                {new Date(msg.timestamp).toLocaleTimeString('ko-KR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-bubble assistant">
            <div className="chat-bubble-avatar">✍️</div>
            <div className="chat-bubble-content">
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}

        {/* AI가 사진 요청 시 대화 흐름 안에 사진 첨부 카드 표시 */}
        {requestingPhoto && !previewImage && (
          <div className="photo-request-card">
            <div className="photo-request-icon">📸</div>
            <p className="photo-request-text">사진이 있으시면 보여주세요!</p>
            <button
              className="photo-request-select-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              사진 선택하기
            </button>
            <p className="photo-request-skip">사진이 없으시면 그냥 대화를 이어가셔도 돼요</p>
          </div>
        )}

        {/* 선택한 사진 미리보기 - 대화 흐름 안에 표시 */}
        {previewImage && (
          <div className="photo-preview-card">
            <img src={previewImage} alt="미리보기" className="photo-preview-img" />
            <div className="photo-preview-actions">
              <button
                className="photo-preview-cancel"
                onClick={() => setPreviewImage(null)}
              >
                다시 선택
              </button>
              <button
                className="photo-preview-send"
                onClick={() => {
                  onSendMessage('(사진을 보냈습니다)', previewImage);
                  setPreviewImage(null);
                }}
              >
                이 사진 보내기
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        capture="environment"
        onChange={handleImageSelect}
        style={{ display: 'none' }}
      />

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="여기에 글을 써주세요..."
          rows={1}
          disabled={isLoading}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={isLoading || (!input.trim() && !previewImage)}
        >
          ➤
        </button>
      </div>
    </div>
  );
};
