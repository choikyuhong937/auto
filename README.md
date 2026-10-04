<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1R6SmVjy08FsG7hwNQOi19OnCNDnqkMab

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## YouTube / Runway 연결 (📺 버튼)

앱 우측 상단 📺 버튼 → 채널 분석 · 영상 제작 · 업로드.

**YouTube (Google OAuth)**
1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. `YouTube Data API v3`, `YouTube Analytics API` 사용 설정
3. OAuth 동의 화면 구성 (테스트 사용자에 내 Google 계정 추가)
4. 사용자 인증 정보 → OAuth 클라이언트 ID → "웹 애플리케이션"
   - 승인된 자바스크립트 원본: 배포 주소(예: `https://내앱.vercel.app`), `http://localhost:3000`
5. 클라이언트 ID를 앱의 ⚙️ 설정에 입력하거나 환경변수 `GOOGLE_CLIENT_ID`로 지정

> 검수받지 않은 OAuth 프로젝트로 업로드한 영상은 YouTube 정책상 비공개로 고정될 수 있습니다.

**Runway (AI 영상 클립)**
- [dev.runwayml.com](https://dev.runwayml.com)에서 API 키 발급 + API 크레딧 충전 (runwayml.com 앱 구독과 별도)
- 앱 ⚙️ 설정에 키 입력, 또는 Vercel 환경변수 `RUNWAY_API_KEY`
- 호출은 `api/runway.js` (Vercel 함수, 로컬 `npm run dev`에서도 동작)를 거칩니다.
