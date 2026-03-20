import type { Chapter } from './storageService';

export function exportToPdf(chapters: Chapter[], userName: string) {
  const confirmedChapters = chapters.filter(c => c.confirmed);
  if (confirmedChapters.length === 0) return;

  const title = userName ? `${userName}의 자서전` : '나의 자서전';
  const now = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const chaptersHtml = confirmedChapters
    .map(
      (ch) => `
      <div class="chapter">
        <div class="chapter-number">Chapter ${ch.id}</div>
        <h2 class="chapter-title">${escapeHtml(ch.title)}</h2>
        <div class="chapter-content">
          ${ch.content
            .split('\n')
            .filter(p => p.trim())
            .map(p => `<p>${escapeHtml(p)}</p>`)
            .join('')}
        </div>
      </div>
    `
    )
    .join('<div class="page-break"></div>');

  const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      size: A4;
      margin: 2.5cm 2cm;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
      color: #2D2D2D;
      line-height: 1.8;
      font-size: 12pt;
      background: white;
    }

    .cover {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 90vh;
      text-align: center;
      page-break-after: always;
    }

    .cover-decoration {
      font-size: 48pt;
      margin-bottom: 40px;
    }

    .cover-title {
      font-size: 28pt;
      font-weight: 700;
      color: #2D2D2D;
      margin-bottom: 16px;
      letter-spacing: 2px;
    }

    .cover-line {
      width: 60px;
      height: 3px;
      background: #FF6B35;
      margin: 24px auto;
    }

    .cover-author {
      font-size: 14pt;
      color: #5A5A5A;
      margin-top: 8px;
    }

    .cover-date {
      font-size: 11pt;
      color: #9E9E9E;
      margin-top: 40px;
    }

    .toc {
      page-break-after: always;
      padding-top: 60px;
    }

    .toc h2 {
      font-size: 18pt;
      text-align: center;
      margin-bottom: 40px;
      color: #2D2D2D;
    }

    .toc-item {
      display: flex;
      align-items: baseline;
      padding: 12px 0;
      border-bottom: 1px dotted #ddd;
      font-size: 12pt;
    }

    .toc-number {
      color: #FF6B35;
      font-weight: 700;
      margin-right: 16px;
      font-size: 10pt;
      min-width: 70px;
    }

    .toc-title {
      flex: 1;
      color: #2D2D2D;
    }

    .chapter {
      padding-top: 40px;
    }

    .chapter-number {
      font-size: 10pt;
      font-weight: 700;
      color: #FF6B35;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 8px;
    }

    .chapter-title {
      font-size: 20pt;
      font-weight: 700;
      color: #2D2D2D;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .chapter-content {
      margin-top: 24px;
    }

    .chapter-content p {
      text-indent: 1em;
      margin-bottom: 12px;
      font-size: 12pt;
      line-height: 2;
      color: #333;
    }

    .page-break {
      page-break-before: always;
    }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="cover">
    <div class="cover-decoration">&#x1F4D6;</div>
    <h1 class="cover-title">${escapeHtml(title)}</h1>
    <div class="cover-line"></div>
    <div class="cover-author">${escapeHtml(userName || '작성자')}</div>
    <div class="cover-date">${now}</div>
  </div>

  <div class="toc">
    <h2>목차</h2>
    ${confirmedChapters
      .map(
        (ch) => `
        <div class="toc-item">
          <span class="toc-number">Chapter ${ch.id}</span>
          <span class="toc-title">${escapeHtml(ch.title)}</span>
        </div>
      `
      )
      .join('')}
  </div>

  ${chaptersHtml}
</body>
</html>
  `;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('팝업이 차단되었습니다. 팝업을 허용해주세요.');
    return;
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Wait for content to render then trigger print
  printWindow.onload = () => {
    setTimeout(() => {
      printWindow.print();
    }, 500);
  };
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
