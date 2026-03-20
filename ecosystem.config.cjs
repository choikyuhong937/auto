// ★ v35f: PM2 자동재시작 설정
// 사용법: pm2 start ecosystem.config.cjs
// 상태확인: pm2 status / pm2 logs trading-bot
module.exports = {
  apps: [{
    name: 'trading-bot',
    script: 'npx',
    args: 'vite',
    cwd: __dirname,
    // 자동 재시작
    autorestart: true,
    watch: false,
    max_restarts: 50,           // 최대 50회 재시작
    min_uptime: 5000,           // 5초 이상 생존해야 정상 시작으로 간주
    restart_delay: 3000,        // 재시작 간 3초 대기
    // 메모리 관리
    max_memory_restart: '2G',   // 2GB 초과 시 자동 재시작 (메모리 누수 방지)
    // 로그
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // 환경
    env: {
      NODE_ENV: 'production',
    },
  }],
};
