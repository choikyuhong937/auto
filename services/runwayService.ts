// Runway AI 영상 생성 (api/runway.js 중계 함수를 통해 호출)
// Runway 개발자 API 키: https://dev.runwayml.com 에서 발급 (일반 runwayml.com 크레딧과 별도)

const KEY_STORAGE = 'runway_api_key';

export type RunwayRatio = '1280:720' | '720:1280';

export interface RunwayTask {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  progress?: number;
  output?: string[];
  failure?: string;
}

export function getRunwayKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setRunwayKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // ignore
  }
}

async function call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = getRunwayKey();
  const res = await fetch(`/api/runway?path=${encodeURIComponent(path)}`, {
    method,
    headers: {
      ...(key ? { 'x-runway-key': key } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || data?.message || `Runway 오류 (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/** 키가 유효한지 확인하고 남은 크레딧을 돌려줍니다. */
export async function checkRunwayKey(): Promise<number> {
  const org = await call<{ creditBalance: number }>('GET', '/v1/organization');
  return org.creditBalance;
}

/** 텍스트 → 이미지 (gen4_image). 작업 ID 반환 */
export async function startTextToImage(promptText: string, ratio: RunwayRatio): Promise<string> {
  const task = await call<{ id: string }>('POST', '/v1/text_to_image', {
    model: 'gen4_image',
    promptText: promptText.slice(0, 1000),
    ratio: ratio === '1280:720' ? '1920:1080' : '1080:1920',
  });
  return task.id;
}

/** 이미지(+프롬프트) → 영상 (gen4_turbo). 이미지는 https URL 또는 data URL. 작업 ID 반환 */
export async function startImageToVideo(
  promptImage: string,
  promptText: string,
  ratio: RunwayRatio,
  duration: 5 | 10
): Promise<string> {
  const task = await call<{ id: string }>('POST', '/v1/image_to_video', {
    model: 'gen4_turbo',
    promptImage,
    promptText: promptText.slice(0, 1000),
    ratio,
    duration,
  });
  return task.id;
}

export function getTask(id: string): Promise<RunwayTask> {
  return call<RunwayTask>('GET', `/v1/tasks/${id}`);
}

/** 작업이 끝날 때까지 기다린 뒤 결과 URL 목록을 돌려줍니다. */
export async function waitForTask(id: string, onProgress?: (percent: number) => void): Promise<string[]> {
  for (;;) {
    const task = await getTask(id);
    if (task.status === 'SUCCEEDED') {
      onProgress?.(100);
      return task.output || [];
    }
    if (task.status === 'FAILED' || task.status === 'CANCELLED') {
      throw new Error(task.failure || 'Runway 생성에 실패했습니다.');
    }
    if (typeof task.progress === 'number') onProgress?.(Math.round(task.progress * 100));
    await new Promise((r) => setTimeout(r, 5000));
  }
}
