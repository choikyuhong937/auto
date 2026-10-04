import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore - plain JS serverless function shared with Vercel
import { forwardToRunway } from './api/runway.js';

// 로컬 개발(npm run dev)에서도 /api/runway 가 동작하도록 Vercel 함수와 같은 로직을 연결
const runwayDevProxy = (env: Record<string, string>): Plugin => ({
  name: 'runway-dev-proxy',
  configureServer(server) {
    server.middlewares.use('/api/runway', async (req, res) => {
      const url = new URL(req.url || '', 'http://localhost');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { status, data } = await forwardToRunway({
        method: req.method,
        path: url.searchParams.get('path') || '',
        key: (req.headers['x-runway-key'] as string) || env.RUNWAY_API_KEY,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    });
  },
});

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), runwayDevProxy(env)],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GOOGLE_SHEETS_SCRIPT_URL': JSON.stringify(env.GOOGLE_SHEETS_SCRIPT_URL || ''),
        'process.env.GOOGLE_CLIENT_ID': JSON.stringify(env.GOOGLE_CLIENT_ID || '')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
