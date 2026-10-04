// 유튜브 영상 기획(Gemini) + 브라우저 안에서 슬라이드 영상 렌더링 + 채널 분석 리포트
import { GoogleGenAI } from '@google/genai';
import type { Chapter } from './storageService';
import type { YouTubeChannel, YouTubeVideo, DailyAnalytics } from './youtubeService';

export type VideoFormat = 'landscape' | 'shorts';

export interface VideoScene {
  text: string;
  durationSec: number;
  imageData?: string; // base64 data URL (선택)
}

export interface VideoPlan {
  title: string;
  description: string;
  tags: string[];
  scenes: VideoScene[];
}

function parseJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

/** 주제나 자서전 챕터로부터 영상 제목/설명/태그/장면 대본을 만듭니다. */
export async function generateVideoPlan(
  apiKey: string,
  source: { topic?: string; chapter?: Chapter; userName?: string },
  format: VideoFormat
): Promise<VideoPlan> {
  const ai = new GoogleGenAI({ apiKey });

  const material = source.chapter
    ? `다음은 ${source.userName || '사용자'}님의 자서전 챕터입니다.\n제목: ${source.chapter.title}\n\n${source.chapter.content}`
    : `영상 주제: ${source.topic}`;

  const length = format === 'shorts'
    ? '세로형 YouTube Shorts(총 30~55초, 장면 5~8개, 장면당 한두 문장)'
    : '가로형 일반 영상(총 60~120초, 장면 8~14개, 장면당 한두 문장)';

  const prompt = `당신은 유튜브 영상 기획자입니다. 아래 자료로 ${length}을 기획하세요.
화면에 자막처럼 표시될 짧고 감성적인 문장으로 장면을 구성하세요.

${material}

다음 JSON 형식으로만 답하세요:
{
  "title": "클릭하고 싶은 영상 제목 (60자 이내)",
  "description": "영상 설명 (3~5문단, 해시태그 3개 포함)",
  "tags": ["태그1", "태그2", "... 최대 12개"],
  "scenes": [{ "text": "화면 문장", "durationSec": 4 }]
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 4096,
      temperature: 0.8,
    },
  });

  const plan = parseJson<VideoPlan>(response.text || '{}');
  return {
    title: plan.title || '',
    description: plan.description || '',
    tags: Array.isArray(plan.tags) ? plan.tags.slice(0, 12) : [],
    scenes: (plan.scenes || []).map((s) => ({
      text: String(s.text || ''),
      durationSec: Math.min(10, Math.max(2, Number(s.durationSec) || 4)),
    })),
  };
}

/** 채널 데이터를 Gemini 에게 보내 성과 분석 + 개선 제안을 받습니다. */
export async function analyzeChannel(
  apiKey: string,
  channel: YouTubeChannel,
  videos: YouTubeVideo[],
  analytics: DailyAnalytics[]
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const totals = analytics.reduce(
    (acc, d) => ({
      views: acc.views + d.views,
      minutes: acc.minutes + d.minutesWatched,
      gained: acc.gained + d.subscribersGained,
      lost: acc.lost + d.subscribersLost,
    }),
    { views: 0, minutes: 0, gained: 0, lost: 0 }
  );

  const videoLines = videos
    .map((v) => `- ${v.publishedAt.slice(0, 10)} | ${v.title} | 조회 ${v.viewCount} | 좋아요 ${v.likeCount} | 댓글 ${v.commentCount}`)
    .join('\n');

  const prompt = `당신은 유튜브 채널 성장 컨설턴트입니다. 아래 데이터를 분석해 한국어로 리포트를 써주세요.

채널: ${channel.title}
구독자 ${channel.subscriberCount} / 총 조회수 ${channel.viewCount} / 영상 ${channel.videoCount}개

최근 ${analytics.length}일: 조회 ${totals.views}, 시청 ${Math.round(totals.minutes)}분, 구독 +${totals.gained} / -${totals.lost}

최근 영상:
${videoLines || '(없음)'}

리포트 구성:
1. 한 줄 요약
2. 잘 되고 있는 점 (어떤 영상/주제가 반응이 좋은지)
3. 아쉬운 점
4. 다음에 만들 영상 아이디어 3개 (제목 예시 포함)
5. 업로드 빈도·제목·썸네일 개선 팁

마크다운 기호(#, *) 없이 번호와 줄바꿈만 사용하세요.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { maxOutputTokens: 4096, temperature: 0.6 },
  });
  return response.text || '';
}

// ─── 렌더링 ──────────────────────────────────────────────────

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    // 한글은 공백이 적어 글자 단위로 줄바꿈
    for (const ch of paragraph) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch.trimStart();
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: VideoScene,
  image: HTMLImageElement | null,
  progress: number // 0~1 장면 내 진행률
) {
  // 배경
  if (image) {
    const zoom = 1 + progress * 0.08; // 켄 번즈 효과
    const scale = Math.max(w / image.width, h / image.height) * zoom;
    const iw = image.width * scale;
    const ih = image.height * scale;
    ctx.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#FF6B35');
    grad.addColorStop(1, '#2D2D2D');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  // 페이드 인/아웃
  const fade = Math.min(1, progress / 0.15, (1 - progress) / 0.15);
  ctx.globalAlpha = Math.max(0, fade);

  const fontSize = Math.round(Math.min(w, h) * 0.065);
  ctx.font = `bold ${fontSize}px 'Noto Sans KR', sans-serif`;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 12;

  const lines = wrapText(ctx, scene.text, w * 0.82);
  const lineHeight = fontSize * 1.45;
  const startY = h / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * lineHeight));

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/**
 * 장면 목록을 캔버스에 그려 실시간으로 녹화합니다 (영상 길이만큼 시간이 걸림).
 * 결과는 webm(또는 Safari 의 경우 mp4) Blob 이며 YouTube 에 그대로 업로드할 수 있습니다.
 */
export async function renderVideo(
  scenes: VideoScene[],
  format: VideoFormat,
  onProgress?: (percent: number) => void,
  previewCanvas?: HTMLCanvasElement | null
): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다. Chrome 을 사용해주세요.');
  }
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('지원되는 영상 형식이 없습니다.');

  const [w, h] = format === 'shorts' ? [1080, 1920] : [1280, 720];
  const canvas = previewCanvas || document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const images = await Promise.all(
    scenes.map((s) => (s.imageData ? loadImage(s.imageData).catch(() => null) : Promise.resolve(null)))
  );

  const totalMs = scenes.reduce((sum, s) => sum + s.durationSec * 1000, 0);
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
  });

  drawScene(ctx, w, h, scenes[0], images[0], 0);
  recorder.start(1000);
  const startedAt = performance.now();

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= totalMs) {
        resolve();
        return;
      }
      let acc = 0;
      for (let i = 0; i < scenes.length; i++) {
        const dur = scenes[i].durationSec * 1000;
        if (elapsed < acc + dur) {
          drawScene(ctx, w, h, scenes[i], images[i], (elapsed - acc) / dur);
          break;
        }
        acc += dur;
      }
      onProgress?.(Math.round((elapsed / totalMs) * 100));
      // 백그라운드 탭에서도 진행되도록 rAF 대신 타이머 사용
      setTimeout(tick, 1000 / 30);
    };
    tick();
  });

  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());
  onProgress?.(100);
  return done;
}
