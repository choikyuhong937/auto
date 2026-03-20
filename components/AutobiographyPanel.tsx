import React, { useState } from 'react';
import type { Chapter } from '../services/storageService';
import { exportToPdf } from '../services/pdfService';

interface AutobiographyPanelProps {
  chapters: Chapter[];
  pendingChapter: Chapter | null;
  onConfirmChapter: () => void;
  onEditChapter: (content: string) => void;
  onEditTitle: (title: string) => void;
  userName: string;
  onShareKakao?: (chapter: Chapter) => void;
  onCopyChapter?: (chapter: Chapter) => void;
  progress: number;
}

export const AutobiographyPanel: React.FC<AutobiographyPanelProps> = ({
  chapters,
  pendingChapter,
  onConfirmChapter,
  onEditChapter,
  onEditTitle,
  userName,
  onShareKakao,
  onCopyChapter,
  progress,
}) => {
  const [editingContent, setEditingContent] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [expandedChapter, setExpandedChapter] = useState<number | null>(null);

  const confirmedChapters = chapters.filter((c) => c.confirmed);

  return (
    <div className="autobiography-panel">
      <div className="autobiography-header">
        <h2>{userName ? `${userName}의 자서전` : '나의 자서전'}</h2>
        <div className="autobiography-header-actions">
          <span className="chapter-count">
            {confirmedChapters.length}개 챕터 완성
          </span>
          {confirmedChapters.length > 0 && (
            <button
              className="pdf-export-btn"
              onClick={() => exportToPdf(chapters, userName)}
              title="PDF로 저장"
            >
              PDF 저장
            </button>
          )}
        </div>
      </div>

      {/* 진행률 바 */}
      <div className="autobiography-progress">
          <div className="autobiography-progress-header">
            <span className="autobiography-progress-label">자서전 진행률</span>
            <span className="autobiography-progress-percent">{progress}%</span>
          </div>
          <div className="autobiography-progress-track">
            <div
              className="autobiography-progress-fill"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <span className="autobiography-progress-hint">
            {progress === 0 ? '대화를 시작하면 진행률이 올라가요' :
             progress < 30 ? '아직 이야기의 시작이에요' :
             progress < 60 ? '이야기가 점점 풍성해지고 있어요' :
             progress < 90 ? '자서전이 거의 완성되어 가요!' :
             '마무리 단계예요!'}
          </span>
        </div>

      <div className="autobiography-content">
        {confirmedChapters.length === 0 && !pendingChapter && (
          <div className="autobiography-empty">
            <div className="autobiography-empty-icon">📚</div>
            <p>아직 작성된 내용이 없습니다</p>
            <p className="autobiography-empty-sub">
              대화를 하시면<br />
              자서전이 자동으로 만들어집니다
            </p>
          </div>
        )}

        {confirmedChapters.map((chapter) => (
          <div key={chapter.id} className="chapter-card confirmed">
            <div
              className="chapter-card-header"
              onClick={() =>
                setExpandedChapter(
                  expandedChapter === chapter.id ? null : chapter.id
                )
              }
            >
              <div className="chapter-number">Chapter {chapter.id}</div>
              <h3 className="chapter-title">{chapter.title}</h3>
              <span className="chapter-toggle">
                {expandedChapter === chapter.id ? '▲' : '▼'}
              </span>
            </div>
            {expandedChapter === chapter.id && (
              <>
                <div className="chapter-body">
                  {chapter.content.split('\n').map((paragraph, i) => (
                    <p key={i}>{paragraph}</p>
                  ))}
                </div>
                <div className="kakao-share-section">
                  <button
                    className="kakao-share-btn"
                    onClick={() => onShareKakao?.(chapter)}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <path d="M12 3C6.48 3 2 6.58 2 10.94c0 2.82 1.87 5.3 4.69 6.7-.21.76-.75 2.75-.86 3.18-.14.54.2.53.42.39.17-.11 2.76-1.88 3.87-2.64.6.09 1.23.13 1.88.13 5.52 0 10-3.58 10-7.76C22 6.58 17.52 3 12 3z" fill="#191919"/>
                    </svg>
                    카카오톡으로 공유하기
                  </button>
                  <div className="share-actions">
                    <button
                      className="share-btn-copy"
                      onClick={() => onCopyChapter?.(chapter)}
                    >
                      📋 텍스트 복사
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}

        {pendingChapter && (
          <div className="chapter-card pending">
            <div className="pending-badge">새 챕터가 완성되었습니다! 확인해주세요.</div>
            <div className="chapter-card-header">
              <div className="chapter-number">
                Chapter {pendingChapter.id}
              </div>
              {editingTitle ? (
                <input
                  className="chapter-title-input"
                  value={pendingChapter.title}
                  onChange={(e) => onEditTitle(e.target.value)}
                  onBlur={() => setEditingTitle(false)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && setEditingTitle(false)
                  }
                  autoFocus
                />
              ) : (
                <h3
                  className="chapter-title editable"
                  onClick={() => setEditingTitle(true)}
                >
                  {pendingChapter.title}
                  <span className="edit-hint">누르면 수정할 수 있어요</span>
                </h3>
              )}
            </div>

            <div className="chapter-body">
              {editingContent ? (
                <textarea
                  className="chapter-edit-textarea"
                  value={pendingChapter.content}
                  onChange={(e) => onEditChapter(e.target.value)}
                  onBlur={() => setEditingContent(false)}
                  autoFocus
                />
              ) : (
                <div
                  className="chapter-text editable"
                  onClick={() => setEditingContent(true)}
                >
                  {pendingChapter.content.split('\n').map((paragraph, i) => (
                    <p key={i}>{paragraph}</p>
                  ))}
                  <div className="edit-overlay">내용을 누르면 수정할 수 있어요</div>
                </div>
              )}
            </div>

            <div className="chapter-actions">
              <button
                className="btn-edit"
                onClick={() => setEditingContent(true)}
              >
                ✏️ 내용 수정하기
              </button>
              <button className="btn-confirm" onClick={onConfirmChapter}>
                ✅ 좋아요! 다음으로
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
