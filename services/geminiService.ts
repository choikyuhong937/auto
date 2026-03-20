import { GoogleGenAI } from '@google/genai';
import type { ChatMessage, Chapter } from './storageService';

const SYSTEM_PROMPT = `당신은 사용자의 자서전을 작성하는 베테랑 전문 작가이자 적극적인 인터뷰어입니다.
당신은 수동적으로 기다리지 않고, 적극적으로 대화를 주도하는 스타일입니다.

## 대화 스타일 (매우 중요):
- **적극적이고 주도적으로 질문하세요.** 사용자가 말한 내용에서 흥미로운 포인트를 잡아 질문하세요.
- **구체적으로 물어보세요.** "어린 시절에 대해 말해주세요" 같은 막연한 질문 대신 "초등학교 때 제일 친했던 친구가 누구였어요? 그 친구랑 뭐 하고 놀았어요?" 같은 구체적 질문을 하세요.
- **감탄, 공감, 리액션을 적극적으로 하세요.** "와, 그건 정말 대단한 경험이네요!", "아, 그때 많이 힘드셨겠다..."
- **한 답변에서 여러 포인트가 나오면 가장 흥미로운 것을 골라 후속 질문하세요.**

## 대화 진행 속도 (매우 중요):
- **하나의 주제에 대해 3~5번 정도 주고받으면 충분합니다.** 핵심적인 감정과 에피소드를 파악했으면 과감하게 다음 시기/주제로 넘어가세요.
- **같은 주제에서 너무 오래 머물지 마세요.** 사용자가 짧게 답하거나 더 이상 새로운 이야기가 나오지 않으면 바로 다음으로 전환하세요.
- **전환할 때는 자연스럽게 연결하세요.** "그 시절 이야기 정말 좋았어요! 그러면 그 이후에는 어떤 일이 있었어요?" 처럼 자연스럽게 넘어가세요.
- **챕터를 빨리 완성하는 것도 중요합니다.** 하나의 주제에 대해 충분한 이야기(핵심 에피소드 2~3개 + 감정/교훈)가 모이면 바로 챕터로 정리하고 다음으로 넘어가세요.
- **사용자가 다른 시기의 이야기를 꺼내면 즉시 그쪽으로 따라가세요.** 이전 주제로 돌아가지 마세요.

## 첫 대화 규칙 (매우 중요):
- 첫 대화에서는 반드시 **사용자의 이름의 뜻이나 유래**부터 물어보세요.
- 예시: "OO님, 혹시 이름에 어떤 뜻이 담겨 있는지 아세요? 누가 지어주셨어요?"
- 이름 이야기에서 자연스럽게 가족, 출생 이야기로 넘어가세요.

## 규칙:
1. 시간순서대로 진행하되, 사용자가 꺼낸 화제가 있으면 그쪽으로 따라가세요.
2. 한 번에 하나의 질문만 하되, 날카롭고 구체적인 질문을 하세요.
3. 감정, 느낌, 교훈 등을 함께 물어보세요.
4. 사진이 도움이 될 것 같으면 적극적으로 요청하세요. "혹시 그때 사진 있으면 보여주실 수 있어요? 너무 보고 싶어요!"
5. 한 주제에 대해 핵심 에피소드 2~3개와 감정이 나왔으면 바로 챕터를 완성하고 다음 시기로 넘어가세요.
6. 사용자가 짧게 답하거나 "네", "그랬어요" 같은 단답을 하면 해당 주제를 마무리하고 다음으로 넘어가세요.

## 챕터 구성 방식:
- 챕터 수나 제목은 미리 정해져 있지 않습니다. 사용자의 이야기에 맞춰 자연스럽게 챕터를 구성하세요.
- 대화 흐름에서 하나의 주제/시기에 대한 이야기가 충분히 모이면 그에 맞는 챕터 제목을 직접 만들어 완성하세요.
- 사용자마다 인생 경험이 다르므로 챕터 수도, 주제도, 순서도 달라야 합니다.
- 대체로 시간순으로 진행하되, 사용자가 꺼낸 이야기를 우선하세요.

## 응답 형식:
일반 대화일 때는 자연스럽게 대화하세요.

사진을 요청할 때는 메시지 끝에 다음을 추가하세요:
[PHOTO_REQUEST]

**매 응답마다** 메시지 끝에 자서전 전체 진행률을 추가하세요:
[PROGRESS:숫자]
- 숫자는 0~100 사이의 정수입니다.
- 사용자의 인생 이야기를 탄생부터 현재/미래까지 전체로 봤을 때, 지금까지 다룬 범위가 몇 %인지 판단하세요.
- 사용자의 출생연도와 현재 나이를 고려하여, 지금까지 다룬 시기가 전체 인생의 몇 %인지 판단하세요.
- 예: 60세인 사람이 30대 이야기까지 왔으면 약 50%, 20대인 사람이 고등학교 이야기까지 왔으면 약 70%
- 대화 초반(이름, 인사)에는 0~5% 정도로 시작하세요.

한 챕터가 완성되었다고 판단되면, 대화 메시지 뒤에 다음 형식으로 챕터 내용을 추가하세요:
[CHAPTER_COMPLETE]
제목: (챕터 제목)
---
(아름다운 문학적 문체로 작성된 자서전 챕터 내용. 사용자가 공유한 이야기를 바탕으로 감동적이고 생생하게 작성하세요. 최소 3문단 이상.)
[/CHAPTER_COMPLETE]

중요: 챕터를 작성할 때는 사용자가 공유한 내용을 바탕으로 3인칭이 아닌 1인칭(나)으로 작성하세요.
`;

export interface GeminiResponse {
  message: string;
  requestPhoto: boolean;
  chapterComplete: boolean;
  chapter?: {
    title: string;
    content: string;
  };
  progress?: number; // 0~100, AI가 판단한 자서전 전체 진행률
}

function parseResponse(text: string): GeminiResponse {
  let message = text;
  let requestPhoto = false;
  let chapterComplete = false;
  let chapter: { title: string; content: string } | undefined;
  let progress: number | undefined;

  // Check for photo request
  if (message.includes('[PHOTO_REQUEST]')) {
    requestPhoto = true;
    message = message.replace('[PHOTO_REQUEST]', '').trim();
  }

  // Check for progress
  const progressMatch = message.match(/\[PROGRESS:(\d+)\]/);
  if (progressMatch) {
    progress = Math.min(100, Math.max(0, parseInt(progressMatch[1], 10)));
    message = message.replace(progressMatch[0], '').trim();
  }

  // Check for chapter completion
  const chapterMatch = message.match(
    /\[CHAPTER_COMPLETE\]\s*제목:\s*(.+?)\s*---\s*([\s\S]+?)\s*\[\/CHAPTER_COMPLETE\]/
  );
  if (chapterMatch) {
    chapterComplete = true;
    chapter = {
      title: chapterMatch[1].trim(),
      content: chapterMatch[2].trim(),
    };
    message = message.replace(chapterMatch[0], '').trim();
  }

  return { message, requestPhoto, chapterComplete, chapter, progress };
}

export async function generateGreeting(
  apiKey: string,
  userName: string,
  birthYear?: number
): Promise<GeminiResponse> {
  const ai = new GoogleGenAI({ apiKey });

  const currentYear = new Date().getFullYear();
  const age = birthYear ? currentYear - birthYear : null;

  const systemContext = [
    SYSTEM_PROMPT,
    userName ? `\n사용자 이름: ${userName}` : '',
    birthYear ? `출생연도: ${birthYear}년 (현재 ${age}세)` : '',
    '\n현재 챕터: 1',
    '완성된 챕터 수: 0',
  ].join('\n');

  const prompt = userName
    ? `사용자가 "${userName}"이라는 이름으로 자서전 만들기에 들어왔습니다.${birthYear ? ` ${birthYear}년생(${age}세)입니다.` : ''} 당신이 먼저 인사하고 이름의 뜻이나 유래에 대해 적극적으로 물어보세요. 사용자가 아직 아무 말도 하지 않은 상태입니다. 따뜻하고 적극적으로 먼저 대화를 시작하세요.`
    : `사용자가 자서전 만들기에 들어왔습니다. 이름을 아직 모릅니다. 당신이 먼저 인사하고 이름을 물어보세요.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: systemContext,
      maxOutputTokens: 2048,
      temperature: 0.8,
    },
  });

  const text = response.text || '';
  return parseResponse(text);
}

export async function sendMessage(
  apiKey: string,
  chatHistory: ChatMessage[],
  userMessage: string,
  currentChapter: number,
  chapters: Chapter[],
  imageData?: string,
  userName?: string,
  birthYear?: number
): Promise<GeminiResponse> {
  const ai = new GoogleGenAI({ apiKey });

  const currentYear = new Date().getFullYear();
  const age = birthYear ? currentYear - birthYear : null;

  const contextParts: string[] = [
    SYSTEM_PROMPT,
    userName ? `\n사용자 이름: ${userName}` : '',
    birthYear ? `출생연도: ${birthYear}년 (현재 ${age}세)` : '',
    `\n현재 챕터: ${currentChapter}`,
    `완성된 챕터 수: ${chapters.filter(c => c.confirmed).length}`,
  ];

  if (chapters.length > 0) {
    contextParts.push('\n이전에 완성된 챕터들:');
    chapters.filter(c => c.confirmed).forEach(ch => {
      contextParts.push(`- ${ch.title}`);
    });
  }

  const systemContext = contextParts.join('\n');

  const contents: Array<{
    role: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }> = [];

  // Add chat history (last 20 messages for context)
  const recentHistory = chatHistory.slice(-20);
  for (const msg of recentHistory) {
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (msg.content) {
      parts.push({ text: msg.content });
    }
    if (msg.imageData) {
      const base64 = msg.imageData.replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inlineData: { mimeType: 'image/jpeg', data: base64 },
      });
    }
    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts,
      });
    }
  }

  // Add current user message
  const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: userMessage },
  ];
  if (imageData) {
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    userParts.push({
      inlineData: { mimeType: 'image/jpeg', data: base64 },
    });
  }
  contents.push({ role: 'user', parts: userParts });

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents,
    config: {
      systemInstruction: systemContext,
      maxOutputTokens: 4096,
      temperature: 0.8,
    },
  });

  const text = response.text || '';
  return parseResponse(text);
}
