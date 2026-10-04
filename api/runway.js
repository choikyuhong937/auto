// Runway API 중계 (Vercel 서버리스 함수)
// Runway API 는 브라우저(CORS)에서 직접 호출할 수 없어 이 함수를 거칩니다.
// API 키는 환경변수 RUNWAY_API_KEY 또는 요청 헤더 x-runway-key 로 전달합니다.

const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const RUNWAY_VERSION = '2024-11-06';
const ALLOWED = [/^\/v1\/image_to_video$/, /^\/v1\/text_to_image$/, /^\/v1\/text_to_video$/, /^\/v1\/tasks\/[\w-]+$/, /^\/v1\/organization$/];

export async function forwardToRunway({ method, path, key, body }) {
  if (!path || !ALLOWED.some((re) => re.test(path))) {
    return { status: 400, data: { error: '허용되지 않은 Runway 경로입니다.' } };
  }
  if (!key) {
    return { status: 401, data: { error: 'Runway API 키가 없습니다.' } };
  }
  const res = await fetch(RUNWAY_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'X-Runway-Version': RUNWAY_VERSION,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method !== 'GET' && body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  return { status: res.status, data };
}

export default async function handler(req, res) {
  const { status, data } = await forwardToRunway({
    method: req.method,
    path: String(req.query.path || ''),
    key: req.headers['x-runway-key'] || process.env.RUNWAY_API_KEY,
    body: req.body,
  });
  res.status(status).json(data);
}
