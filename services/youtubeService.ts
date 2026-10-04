// YouTube 계정 연결 (Google OAuth) + YouTube Data / Analytics API 호출
//
// 브라우저 전용 OAuth 토큰 흐름(Google Identity Services)을 사용하므로 서버가 필요 없습니다.
// Google Cloud Console 에서 "웹 애플리케이션" OAuth 클라이언트 ID 를 만들고
// 승인된 자바스크립트 원본에 배포 주소(예: https://내앱.vercel.app, http://localhost:3000)를 등록하세요.

declare global {
  interface Window {
    google?: any;
  }
}

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ');

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const CLIENT_ID_KEY = 'yt_client_id';
const TOKEN_KEY = 'yt_access_token';

export interface YouTubeToken {
  accessToken: string;
  expiresAt: number;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  description: string;
  customUrl?: string;
  thumbnail: string;
  publishedAt: string;
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
  uploadsPlaylistId: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
}

export interface DailyAnalytics {
  day: string;
  views: number;
  minutesWatched: number;
  avgViewDuration: number;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
}

export interface UploadOptions {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'private' | 'unlisted' | 'public';
  categoryId?: string;
  madeForKids?: boolean;
}

// ─── Client ID ───────────────────────────────────────────────

export function getClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
  } catch {
    // ignore
  }
  return process.env.GOOGLE_CLIENT_ID || '';
}

export function setClientId(clientId: string): void {
  try {
    localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
  } catch {
    // ignore
  }
}

// ─── Token ───────────────────────────────────────────────────

export function getStoredToken(): YouTubeToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const token: YouTubeToken = JSON.parse(raw);
    // 만료 1분 전이면 만료된 것으로 처리
    if (token.expiresAt - 60_000 < Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

function storeToken(token: YouTubeToken | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

let gsiPromise: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiPromise = null;
      reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다.'));
    };
    document.head.appendChild(script);
  });
  return gsiPromise;
}

/** Google 로그인 팝업을 띄워 YouTube 권한을 받아옵니다. */
export async function connectYouTube(clientId: string): Promise<YouTubeToken> {
  if (!clientId) throw new Error('Google OAuth 클라이언트 ID가 필요합니다.');
  await loadGsi();

  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: YOUTUBE_SCOPES,
      callback: (resp: any) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        const token: YouTubeToken = {
          accessToken: resp.access_token,
          expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000,
        };
        storeToken(token);
        resolve(token);
      },
      error_callback: (err: any) => {
        reject(new Error(err?.message || '로그인이 취소되었습니다.'));
      },
    });
    client.requestAccessToken();
  });
}

export async function disconnectYouTube(token: YouTubeToken | null): Promise<void> {
  storeToken(null);
  if (token && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(token.accessToken, () => {});
  }
}

// ─── API helpers ─────────────────────────────────────────────

async function apiGet<T = any>(token: YouTubeToken, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      // ignore
    }
    if (res.status === 401) {
      storeToken(null);
      message = '로그인이 만료되었습니다. 다시 연결해주세요.';
    }
    throw new Error(message);
  }
  return res.json();
}

const num = (v: any) => Number(v || 0);

export async function getMyChannel(token: YouTubeToken): Promise<YouTubeChannel> {
  const data = await apiGet(
    token,
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true'
  );
  const ch = data.items?.[0];
  if (!ch) throw new Error('이 Google 계정에 연결된 YouTube 채널이 없습니다.');
  return {
    id: ch.id,
    title: ch.snippet.title,
    description: ch.snippet.description,
    customUrl: ch.snippet.customUrl,
    thumbnail: ch.snippet.thumbnails?.default?.url || '',
    publishedAt: ch.snippet.publishedAt,
    subscriberCount: num(ch.statistics.subscriberCount),
    viewCount: num(ch.statistics.viewCount),
    videoCount: num(ch.statistics.videoCount),
    uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads,
  };
}

export async function getRecentVideos(
  token: YouTubeToken,
  uploadsPlaylistId: string,
  maxResults = 20
): Promise<YouTubeVideo[]> {
  const list = await apiGet(
    token,
    `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}`
  );
  const ids: string[] = (list.items || []).map((i: any) => i.contentDetails.videoId);
  if (ids.length === 0) return [];

  const videos = await apiGet(
    token,
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(',')}`
  );
  return (videos.items || []).map((v: any) => ({
    id: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
    viewCount: num(v.statistics.viewCount),
    likeCount: num(v.statistics.likeCount),
    commentCount: num(v.statistics.commentCount),
    duration: v.contentDetails.duration,
  }));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 최근 N일 일별 채널 지표 (YouTube Analytics API) */
export async function getChannelAnalytics(token: YouTubeToken, days = 28): Promise<DailyAnalytics[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const metrics = 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes';
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: ymd(start),
    endDate: ymd(end),
    metrics,
    dimensions: 'day',
    sort: 'day',
  });
  const data = await apiGet(token, `https://youtubeanalytics.googleapis.com/v2/reports?${params}`);
  return (data.rows || []).map((r: any[]) => ({
    day: r[0],
    views: num(r[1]),
    minutesWatched: num(r[2]),
    avgViewDuration: num(r[3]),
    subscribersGained: num(r[4]),
    subscribersLost: num(r[5]),
    likes: num(r[6]),
  }));
}

/** 재개 가능(resumable) 업로드로 영상을 내 채널에 올립니다. 업로드된 영상 ID 반환. */
export async function uploadVideo(
  token: YouTubeToken,
  file: Blob,
  options: UploadOptions,
  onProgress?: (percent: number) => void
): Promise<string> {
  const contentType = file.type || 'video/*';
  const metadata = {
    snippet: {
      title: options.title.slice(0, 100),
      description: options.description.slice(0, 5000),
      tags: options.tags,
      categoryId: options.categoryId || '22', // People & Blogs
    },
    status: {
      privacyStatus: options.privacyStatus,
      selfDeclaredMadeForKids: options.madeForKids ?? false,
    },
  };

  const init = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(file.size),
        'X-Upload-Content-Type': contentType,
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!init.ok) {
    let message = `업로드 시작 실패 (${init.status})`;
    try {
      const body = await init.json();
      message = body?.error?.message || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('업로드 주소를 받지 못했습니다.');

  // fetch 는 업로드 진행률을 알 수 없으므로 XHR 사용
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Authorization', `Bearer ${token.accessToken}`);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).id);
        } catch {
          reject(new Error('업로드 응답을 해석하지 못했습니다.'));
        }
      } else {
        let message = `업로드 실패 (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText)?.error?.message || message;
        } catch {
          // ignore
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드에 실패했습니다.'));
    xhr.send(file);
  });
}

/** ISO 8601 기간(PT1M30S) → "1:30" */
export function formatDuration(iso: string): string {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const h = num(m[1]);
  const min = num(m[2]);
  const s = num(m[3]);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}
