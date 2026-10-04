import React, { useEffect, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { Chapter } from '../services/storageService';
import {
  connectYouTube,
  disconnectYouTube,
  getStoredToken,
  getClientId,
  setClientId,
  getMyChannel,
  getRecentVideos,
  getChannelAnalytics,
  uploadVideo,
  formatDuration,
  type YouTubeToken,
  type YouTubeChannel,
  type YouTubeVideo,
  type DailyAnalytics,
  type UploadOptions,
} from '../services/youtubeService';
import {
  generateVideoPlan,
  analyzeChannel,
  renderVideo,
  type VideoPlan,
  type VideoFormat,
} from '../services/videoProductionService';
import {
  getRunwayKey,
  setRunwayKey,
  checkRunwayKey,
  startTextToImage,
  startImageToVideo,
  waitForTask,
} from '../services/runwayService';

interface YouTubePanelProps {
  geminiApiKey: string;
  userName: string;
  chapters: Chapter[];
  onClose: () => void;
}

type SubTab = 'analytics' | 'create' | 'upload';

interface UploadDraft {
  file: Blob | null;
  fileName: string;
  title: string;
  description: string;
  tags: string;
  privacyStatus: UploadOptions['privacyStatus'];
}

const emptyDraft: UploadDraft = {
  file: null,
  fileName: '',
  title: '',
  description: '',
  tags: '',
  privacyStatus: 'private',
};

const fmt = (n: number) => n.toLocaleString('ko-KR');

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const YouTubePanel: React.FC<YouTubePanelProps> = ({ geminiApiKey, userName, chapters, onClose }) => {
  const [token, setToken] = useState<YouTubeToken | null>(getStoredToken());
  const [clientIdInput, setClientIdInput] = useState(getClientId());
  const [runwayKeyInput, setRunwayKeyInput] = useState(getRunwayKey());
  const [runwayCredits, setRunwayCredits] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(!getClientId());
  const [subTab, setSubTab] = useState<SubTab>('analytics');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // 분석
  const [channel, setChannel] = useState<YouTubeChannel | null>(null);
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [analytics, setAnalytics] = useState<DailyAnalytics[]>([]);
  const [report, setReport] = useState('');

  // 제작
  const confirmedChapters = chapters.filter((c) => c.confirmed);
  const [sourceType, setSourceType] = useState<'chapter' | 'topic'>(confirmedChapters.length ? 'chapter' : 'topic');
  const [chapterId, setChapterId] = useState<number>(confirmedChapters[0]?.id ?? 0);
  const [topic, setTopic] = useState('');
  const [format, setFormat] = useState<VideoFormat>('landscape');
  const [plan, setPlan] = useState<VideoPlan | null>(null);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // 런웨이
  const [runwayPrompt, setRunwayPrompt] = useState('');
  const [runwayImage, setRunwayImage] = useState('');
  const [runwayDuration, setRunwayDuration] = useState<5 | 10>(5);
  const [runwayProgress, setRunwayProgress] = useState<number | null>(null);
  const [runwayResult, setRunwayResult] = useState('');

  // 업로드
  const [draft, setDraft] = useState<UploadDraft>(emptyDraft);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadedId, setUploadedId] = useState('');

  useEffect(() => {
    if (token && !channel) loadChannel(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setError('');
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || '알 수 없는 오류');
      if (!getStoredToken()) setToken(null);
    } finally {
      setBusy('');
    }
  };

  const loadChannel = (t: YouTubeToken) =>
    run('채널 정보를 불러오는 중...', async () => {
      const ch = await getMyChannel(t);
      setChannel(ch);
      const [vids, stats] = await Promise.all([
        getRecentVideos(t, ch.uploadsPlaylistId),
        getChannelAnalytics(t).catch(() => [] as DailyAnalytics[]),
      ]);
      setVideos(vids);
      setAnalytics(stats);
    });

  const handleConnect = () =>
    run('Google 로그인 중...', async () => {
      const id = clientIdInput.trim();
      setClientId(id);
      const t = await connectYouTube(id);
      setToken(t);
      setShowSettings(false);
    });

  const handleDisconnect = async () => {
    await disconnectYouTube(token);
    setToken(null);
    setChannel(null);
    setVideos([]);
    setAnalytics([]);
    setReport('');
  };

  const handleSaveRunway = () =>
    run('Runway 키 확인 중...', async () => {
      setRunwayKey(runwayKeyInput);
      setRunwayCredits(runwayKeyInput ? await checkRunwayKey() : null);
    });

  // ─── 분석 ─────────────────────────
  const handleAnalyze = () =>
    run('AI가 채널을 분석하는 중...', async () => {
      if (!channel) return;
      setReport(await analyzeChannel(geminiApiKey, channel, videos, analytics));
    });

  // ─── 제작 ─────────────────────────
  const handlePlan = () =>
    run('AI가 영상을 기획하는 중...', async () => {
      const chapter = confirmedChapters.find((c) => c.id === chapterId);
      const p = await generateVideoPlan(
        geminiApiKey,
        sourceType === 'chapter' ? { chapter, userName } : { topic },
        format
      );
      // 챕터 사진이 있으면 장면 배경으로 순서대로 배치
      const photos = sourceType === 'chapter' ? chapter?.photos || [] : [];
      if (photos.length) {
        p.scenes = p.scenes.map((s, i) => ({ ...s, imageData: photos[i % photos.length] }));
      }
      setPlan(p);
      setRunwayPrompt(p.title);
      setVideoBlob(null);
      setVideoUrl('');
    });

  const updateScene = (i: number, patch: Partial<VideoPlan['scenes'][number]>) =>
    setPlan((prev) => prev && { ...prev, scenes: prev.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const handleRender = () =>
    run('영상을 만드는 중... (영상 길이만큼 걸려요)', async () => {
      if (!plan || plan.scenes.length === 0) return;
      setRenderProgress(0);
      const blob = await renderVideo(plan.scenes, format, setRenderProgress, previewCanvasRef.current);
      setRenderProgress(null);
      setVideoBlob(blob);
      setVideoUrl(URL.createObjectURL(blob));
    });

  const sendToUpload = (file: Blob, name: string) => {
    setDraft({
      file,
      fileName: name,
      title: plan?.title || '',
      description: plan?.description || '',
      tags: plan?.tags.join(', ') || '',
      privacyStatus: 'private',
    });
    setUploadedId('');
    setSubTab('upload');
  };

  // ─── 런웨이 ───────────────────────
  const runwayRatio = format === 'shorts' ? '720:1280' : '1280:720';

  const handleRunwayImage = () =>
    run('Runway가 이미지를 그리는 중...', async () => {
      setRunwayProgress(0);
      const id = await startTextToImage(runwayPrompt, runwayRatio);
      const [url] = await waitForTask(id, setRunwayProgress);
      setRunwayImage(url);
      setRunwayProgress(null);
    });

  const handleRunwayVideo = () =>
    run('Runway가 영상을 만드는 중... (1~3분)', async () => {
      if (!runwayImage) throw new Error('먼저 시작 이미지를 올리거나 생성해주세요.');
      setRunwayProgress(0);
      const id = await startImageToVideo(runwayImage, runwayPrompt, runwayRatio, runwayDuration);
      const [url] = await waitForTask(id, setRunwayProgress);
      setRunwayResult(url);
      setRunwayProgress(null);
    });

  const handleRunwayToUpload = () =>
    run('Runway 영상을 가져오는 중...', async () => {
      try {
        const res = await fetch(runwayResult);
        sendToUpload(await res.blob(), 'runway.mp4');
      } catch {
        throw new Error('브라우저에서 영상을 바로 가져올 수 없어요. "다운로드"로 저장한 뒤 업로드 탭에서 파일을 선택해주세요.');
      }
    });

  // ─── 업로드 ───────────────────────
  const handleUpload = () =>
    run('YouTube에 업로드 중...', async () => {
      if (!token || !draft.file) return;
      setUploadProgress(0);
      const id = await uploadVideo(
        token,
        draft.file,
        {
          title: draft.title || draft.fileName || '새 영상',
          description: draft.description,
          tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
          privacyStatus: draft.privacyStatus,
        },
        setUploadProgress
      );
      setUploadedId(id);
      setUploadProgress(null);
      loadChannel(token);
    });

  // ─── 렌더 ─────────────────────────
  const totals = analytics.reduce(
    (a, d) => ({ views: a.views + d.views, minutes: a.minutes + d.minutesWatched, subs: a.subs + d.subscribersGained - d.subscribersLost }),
    { views: 0, minutes: 0, subs: 0 }
  );

  const settingsSection = (
    <div className="yt-card">
      <h3>연결 설정</h3>
      <label className="yt-label">Google OAuth 클라이언트 ID</label>
      <input
        className="yt-input"
        value={clientIdInput}
        onChange={(e) => setClientIdInput(e.target.value)}
        placeholder="xxxxxxxx.apps.googleusercontent.com"
      />
      <p className="yt-hint">
        Google Cloud Console → API 및 서비스 → 사용자 인증 정보에서 "웹 애플리케이션" OAuth 클라이언트를 만들고,
        승인된 자바스크립트 원본에 <b>{window.location.origin}</b> 를 추가하세요.
        YouTube Data API v3 와 YouTube Analytics API 를 사용 설정해야 합니다.
      </p>
      <label className="yt-label">Runway API 키 (선택)</label>
      <div className="yt-row">
        <input
          className="yt-input"
          type="password"
          value={runwayKeyInput}
          onChange={(e) => setRunwayKeyInput(e.target.value)}
          placeholder="key_..."
        />
        <button className="yt-btn secondary" onClick={handleSaveRunway} disabled={!!busy}>저장</button>
      </div>
      <p className="yt-hint">
        dev.runwayml.com 에서 발급한 API 키 (일반 Runway 앱 크레딧과 별도로 API 크레딧 충전 필요).
        {runwayCredits !== null && <> 남은 크레딧: <b>{fmt(runwayCredits)}</b></>}
      </p>
    </div>
  );

  return (
    <div className="yt-overlay">
      <div className="yt-panel">
        <div className="yt-header">
          <h2>📺 내 유튜브</h2>
          <div className="yt-header-actions">
            {token && channel && (
              <span className="yt-channel-chip">
                {channel.thumbnail && <img src={channel.thumbnail} alt="" />}
                {channel.title}
              </span>
            )}
            <button className="yt-icon-btn" onClick={() => setShowSettings((s) => !s)} title="연결 설정">⚙️</button>
            <button className="yt-icon-btn" onClick={onClose} title="닫기">✕</button>
          </div>
        </div>

        {error && <div className="yt-error">{error}</div>}
        {busy && <div className="yt-busy"><span className="loading-spinner small" /> {busy}</div>}

        <div className="yt-body">
          {showSettings && settingsSection}

          {!token ? (
            <div className="yt-card yt-connect">
              <p>YouTube 계정을 연결하면 채널 분석, 영상 제작, 업로드를 할 수 있어요.</p>
              <button className="yt-btn primary" onClick={handleConnect} disabled={!clientIdInput.trim() || !!busy}>
                Google 계정으로 YouTube 연결
              </button>
              {!clientIdInput.trim() && <p className="yt-hint">먼저 ⚙️ 설정에서 클라이언트 ID를 입력해주세요.</p>}
            </div>
          ) : (
            <>
              <div className="yt-tabs">
                <button className={subTab === 'analytics' ? 'active' : ''} onClick={() => setSubTab('analytics')}>📊 채널 분석</button>
                <button className={subTab === 'create' ? 'active' : ''} onClick={() => setSubTab('create')}>🎬 영상 제작</button>
                <button className={subTab === 'upload' ? 'active' : ''} onClick={() => setSubTab('upload')}>⬆️ 업로드</button>
              </div>

              {subTab === 'analytics' && channel && (
                <>
                  <div className="yt-stats">
                    <div><span>구독자</span><b>{fmt(channel.subscriberCount)}</b></div>
                    <div><span>총 조회수</span><b>{fmt(channel.viewCount)}</b></div>
                    <div><span>영상</span><b>{fmt(channel.videoCount)}</b></div>
                    <div><span>28일 조회</span><b>{fmt(totals.views)}</b></div>
                    <div><span>28일 시청(시간)</span><b>{fmt(Math.round(totals.minutes / 60))}</b></div>
                    <div><span>28일 구독 증감</span><b>{totals.subs >= 0 ? '+' : ''}{fmt(totals.subs)}</b></div>
                  </div>

                  {analytics.length > 0 && (
                    <div className="yt-card">
                      <h3>최근 28일 일별 조회수</h3>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={analytics}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#F0E6DC" />
                          <XAxis dataKey="day" tickFormatter={(d) => d.slice(5)} fontSize={12} />
                          <YAxis fontSize={12} width={40} />
                          <Tooltip />
                          <Line type="monotone" dataKey="views" name="조회수" stroke="#FF6B35" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  <div className="yt-card">
                    <div className="yt-row space">
                      <h3>AI 채널 분석</h3>
                      <button className="yt-btn primary" onClick={handleAnalyze} disabled={!!busy}>분석 받기</button>
                    </div>
                    {report && <div className="yt-report">{report}</div>}
                  </div>

                  <div className="yt-card">
                    <h3>최근 영상</h3>
                    {videos.length === 0 && <p className="yt-hint">아직 업로드한 영상이 없어요.</p>}
                    <ul className="yt-video-list">
                      {videos.map((v) => (
                        <li key={v.id}>
                          <a href={`https://youtu.be/${v.id}`} target="_blank" rel="noopener noreferrer">
                            <img src={v.thumbnail} alt="" />
                          </a>
                          <div>
                            <div className="yt-video-title">{v.title}</div>
                            <div className="yt-video-meta">
                              {v.publishedAt.slice(0, 10)} · {formatDuration(v.duration)} · 조회 {fmt(v.viewCount)} · 👍 {fmt(v.likeCount)} · 💬 {fmt(v.commentCount)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <button className="yt-btn secondary" onClick={handleDisconnect}>YouTube 연결 해제</button>
                </>
              )}

              {subTab === 'create' && (
                <>
                  <div className="yt-card">
                    <h3>1. 무엇으로 만들까요?</h3>
                    <div className="yt-row">
                      <select className="yt-input" value={sourceType} onChange={(e) => setSourceType(e.target.value as any)}>
                        <option value="chapter" disabled={!confirmedChapters.length}>자서전 챕터</option>
                        <option value="topic">직접 주제 입력</option>
                      </select>
                      <select className="yt-input" value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
                        <option value="landscape">가로 영상 (16:9)</option>
                        <option value="shorts">쇼츠 (9:16)</option>
                      </select>
                    </div>
                    {sourceType === 'chapter' ? (
                      <select className="yt-input" value={chapterId} onChange={(e) => setChapterId(Number(e.target.value))}>
                        {confirmedChapters.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                      </select>
                    ) : (
                      <textarea className="yt-input" rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="예: 우리 부모님이 처음 만난 이야기" />
                    )}
                    <button className="yt-btn primary" onClick={handlePlan} disabled={!!busy || (sourceType === 'topic' && !topic.trim())}>
                      AI로 영상 기획하기
                    </button>
                  </div>

                  {plan && (
                    <div className="yt-card">
                      <h3>2. 기획안 다듬기</h3>
                      <label className="yt-label">제목</label>
                      <input className="yt-input" value={plan.title} onChange={(e) => setPlan({ ...plan, title: e.target.value })} />
                      <label className="yt-label">설명</label>
                      <textarea className="yt-input" rows={4} value={plan.description} onChange={(e) => setPlan({ ...plan, description: e.target.value })} />
                      <label className="yt-label">장면 ({plan.scenes.reduce((s, x) => s + x.durationSec, 0)}초)</label>
                      {plan.scenes.map((s, i) => (
                        <div className="yt-scene" key={i}>
                          <span className="yt-scene-no">{i + 1}</span>
                          <textarea className="yt-input" rows={2} value={s.text} onChange={(e) => updateScene(i, { text: e.target.value })} />
                          <input className="yt-input yt-sec" type="number" min={2} max={10} value={s.durationSec} onChange={(e) => updateScene(i, { durationSec: Number(e.target.value) || 4 })} />
                          <label className="yt-photo-btn" title="배경 사진">
                            {s.imageData ? <img src={s.imageData} alt="" /> : '🖼️'}
                            <input type="file" accept="image/*" hidden onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) updateScene(i, { imageData: await readFileAsDataUrl(f) });
                            }} />
                          </label>
                          <button className="yt-icon-btn" onClick={() => setPlan({ ...plan, scenes: plan.scenes.filter((_, j) => j !== i) })} title="삭제">🗑️</button>
                        </div>
                      ))}
                      <button className="yt-btn secondary" onClick={() => setPlan({ ...plan, scenes: [...plan.scenes, { text: '', durationSec: 4 }] })}>+ 장면 추가</button>
                    </div>
                  )}

                  {plan && (
                    <div className="yt-card">
                      <h3>3-A. 자막 슬라이드 영상 만들기 (무료)</h3>
                      <p className="yt-hint">사진 + 문장으로 된 영상을 브라우저에서 바로 만들어요.</p>
                      <canvas ref={previewCanvasRef} className={`yt-preview ${format}`} style={{ display: renderProgress !== null ? 'block' : 'none' }} />
                      {renderProgress !== null && <div className="yt-progress"><div style={{ width: `${renderProgress}%` }} /></div>}
                      {videoUrl && <video className={`yt-preview ${format}`} src={videoUrl} controls />}
                      <div className="yt-row">
                        <button className="yt-btn primary" onClick={handleRender} disabled={!!busy}>영상 만들기</button>
                        {videoBlob && (
                          <>
                            <a className="yt-btn secondary" href={videoUrl} download={`${plan.title || 'video'}.webm`}>다운로드</a>
                            <button className="yt-btn primary" onClick={() => sendToUpload(videoBlob, `${plan.title}.webm`)}>업로드하러 가기 →</button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="yt-card">
                    <h3>3-B. Runway AI 영상 클립</h3>
                    {!getRunwayKey() ? (
                      <p className="yt-hint">⚙️ 설정에서 Runway API 키를 넣으면 AI가 움직이는 영상을 만들어줘요.</p>
                    ) : (
                      <>
                        <label className="yt-label">장면 설명 (영어로 쓰면 결과가 더 좋아요)</label>
                        <textarea className="yt-input" rows={3} value={runwayPrompt} onChange={(e) => setRunwayPrompt(e.target.value)} placeholder="예: A warm 1970s Korean village at sunset, cinematic, slow camera push in" />
                        <label className="yt-label">시작 이미지</label>
                        <div className="yt-row">
                          <label className="yt-btn secondary">
                            사진 올리기
                            <input type="file" accept="image/*" hidden onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) setRunwayImage(await readFileAsDataUrl(f));
                            }} />
                          </label>
                          <button className="yt-btn secondary" onClick={handleRunwayImage} disabled={!!busy || !runwayPrompt.trim()}>AI로 이미지 생성</button>
                          <select className="yt-input yt-sec" value={runwayDuration} onChange={(e) => setRunwayDuration(Number(e.target.value) as 5 | 10)}>
                            <option value={5}>5초</option>
                            <option value={10}>10초</option>
                          </select>
                        </div>
                        {runwayImage && <img className={`yt-preview ${format}`} src={runwayImage} alt="시작 이미지" />}
                        {runwayProgress !== null && <div className="yt-progress"><div style={{ width: `${runwayProgress}%` }} /></div>}
                        <button className="yt-btn primary" onClick={handleRunwayVideo} disabled={!!busy || !runwayImage}>Runway로 영상 만들기</button>
                        {runwayResult && (
                          <>
                            <video className={`yt-preview ${format}`} src={runwayResult} controls />
                            <div className="yt-row">
                              <a className="yt-btn secondary" href={runwayResult} target="_blank" rel="noopener noreferrer" download>다운로드</a>
                              <button className="yt-btn primary" onClick={handleRunwayToUpload} disabled={!!busy}>업로드하러 가기 →</button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}

              {subTab === 'upload' && (
                <div className="yt-card">
                  <h3>새 영상 업로드</h3>
                  <label className="yt-label">영상 파일</label>
                  <div className="yt-row">
                    <label className="yt-btn secondary">
                      파일 선택
                      <input type="file" accept="video/*" hidden onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setDraft((d) => ({ ...d, file: f, fileName: f.name, title: d.title || f.name.replace(/\.[^.]+$/, '') }));
                      }} />
                    </label>
                    <span className="yt-hint">{draft.file ? `${draft.fileName} (${(draft.file.size / 1048576).toFixed(1)}MB)` : '선택된 파일 없음'}</span>
                  </div>
                  <label className="yt-label">제목</label>
                  <input className="yt-input" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  <label className="yt-label">설명</label>
                  <textarea className="yt-input" rows={5} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  <label className="yt-label">태그 (쉼표로 구분)</label>
                  <input className="yt-input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
                  <label className="yt-label">공개 범위</label>
                  <select className="yt-input" value={draft.privacyStatus} onChange={(e) => setDraft({ ...draft, privacyStatus: e.target.value as any })}>
                    <option value="private">비공개</option>
                    <option value="unlisted">일부 공개 (링크가 있는 사람만)</option>
                    <option value="public">공개</option>
                  </select>
                  <p className="yt-hint">
                    Google 앱 검수를 받지 않은 OAuth 프로젝트로 올린 영상은 YouTube 정책상 비공개로 고정될 수 있어요.
                  </p>
                  {uploadProgress !== null && <div className="yt-progress"><div style={{ width: `${uploadProgress}%` }} /></div>}
                  <button className="yt-btn primary" onClick={handleUpload} disabled={!!busy || !draft.file}>YouTube에 업로드</button>
                  {uploadedId && (
                    <p className="yt-success">
                      업로드 완료! <a href={`https://youtu.be/${uploadedId}`} target="_blank" rel="noopener noreferrer">youtu.be/{uploadedId}</a>
                      {' '}(YouTube 처리에 몇 분 걸릴 수 있어요)
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
