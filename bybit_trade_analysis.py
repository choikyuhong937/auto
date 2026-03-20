"""
Bybit V5 API — 거래내역 조회 + 시장데이터 비교 분석
새벽 1시(KST) 이후 모든 closed PnL 가져와서 진입 품질 평가
"""

import hmac
import hashlib
import time
import json
import requests
from datetime import datetime, timedelta, timezone
import sys

# ===== API 설정 =====
API_KEY = "zSWjsmTPZPrE5ZBtDP"
API_SECRET = "nds8YctHzMTutjw6oOW8HZtZ0225mkNDXzK2"
BASE_URL = "https://api.bybit.com"

KST = timezone(timedelta(hours=9))

def get_signature(params_str, timestamp, api_secret, recv_window="5000"):
    """Bybit V5 HMAC-SHA256 서명 생성"""
    param_str = f"{timestamp}{API_KEY}{recv_window}{params_str}"
    return hmac.new(
        api_secret.encode('utf-8'),
        param_str.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

def bybit_get(endpoint, params=None):
    """Bybit V5 GET 요청"""
    if params is None:
        params = {}

    timestamp = str(int(time.time() * 1000))
    recv_window = "5000"

    # 파라미터 → 정렬된 쿼리 스트링 (서명과 요청에 동일한 순서 사용!)
    sorted_params = sorted(params.items())
    param_str = "&".join(f"{k}={v}" for k, v in sorted_params)

    sign = get_signature(param_str, timestamp, API_SECRET, recv_window)

    headers = {
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
    }

    # 정렬된 쿼리 스트링을 직접 URL에 붙여서 전송 (requests가 순서 바꾸는 것 방지)
    url = f"{BASE_URL}{endpoint}"
    if param_str:
        url += f"?{param_str}"
    resp = requests.get(url, headers=headers)
    data = resp.json()

    if data.get("retCode") != 0:
        print(f"API Error: {data.get('retMsg')} (code: {data.get('retCode')})")
        return None
    return data.get("result", {})

def bybit_public_get(endpoint, params=None):
    """Bybit V5 Public GET (서명 불필요)"""
    if params is None:
        params = {}
    resp = requests.get(f"{BASE_URL}{endpoint}", params=params)
    data = resp.json()
    if data.get("retCode") != 0:
        print(f"Public API Error: {data.get('retMsg')}")
        return None
    return data.get("result", {})

# ===== 1. Closed PnL 가져오기 =====
def fetch_closed_pnl(start_ts_ms, end_ts_ms=None):
    """새벽 1시부터 현재까지 모든 closed PnL"""
    all_trades = []
    cursor = ""

    while True:
        params = {
            "category": "linear",
            "startTime": str(start_ts_ms),
            "limit": "100",
        }
        if end_ts_ms:
            params["endTime"] = str(end_ts_ms)
        if cursor:
            params["cursor"] = cursor

        result = bybit_get("/v5/position/closed-pnl", params)
        if not result:
            break

        trades = result.get("list", [])
        all_trades.extend(trades)

        cursor = result.get("nextPageCursor", "")
        if not cursor or len(trades) == 0:
            break

        time.sleep(0.1)  # Rate limit

    return all_trades

# ===== 2. 현재 오픈 포지션 =====
def fetch_open_positions():
    """현재 오픈 포지션"""
    params = {
        "category": "linear",
        "settleCoin": "USDT",
    }
    result = bybit_get("/v5/position/list", params)
    if not result:
        return []
    return [p for p in result.get("list", []) if float(p.get("size", "0")) > 0]

# ===== 3. 주문 내역 =====
def fetch_order_history(start_ts_ms, end_ts_ms=None):
    """주문 내역"""
    all_orders = []
    cursor = ""

    while True:
        params = {
            "category": "linear",
            "startTime": str(start_ts_ms),
            "limit": "50",
        }
        if end_ts_ms:
            params["endTime"] = str(end_ts_ms)
        if cursor:
            params["cursor"] = cursor

        result = bybit_get("/v5/order/history", params)
        if not result:
            break

        orders = result.get("list", [])
        all_orders.extend(orders)

        cursor = result.get("nextPageCursor", "")
        if not cursor or len(orders) == 0:
            break

        time.sleep(0.1)

    return all_orders

# ===== 4. Kline 데이터 (시장 분석용) =====
def fetch_klines(symbol, interval="15", start_ts_ms=None, limit=200):
    """캔들 데이터 조회"""
    params = {
        "category": "linear",
        "symbol": symbol,
        "interval": interval,
        "limit": str(limit),
    }
    if start_ts_ms:
        params["start"] = str(start_ts_ms)

    result = bybit_public_get("/v5/market/kline", params)
    if not result:
        return []

    klines = []
    for k in result.get("list", []):
        klines.append({
            "timestamp": int(k[0]),
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
        })

    klines.sort(key=lambda x: x["timestamp"])
    return klines

# ===== 5. 진입 품질 분석 =====
def analyze_entry_quality(trade, klines_5m):
    """
    진입 시점의 시장 상황 분석:
    - 진입가 대비 직전 5분간 고저 위치
    - 진입 후 최대 유리/불리 움직임
    - RSI/볼륨 상태
    """
    entry_price = float(trade["avgEntryPrice"])
    exit_price = float(trade["avgExitPrice"])
    entry_ts = int(trade["createdTime"])
    close_ts = int(trade["updatedTime"])
    side = trade["side"]  # Buy = Short 청산, Sell = Long 청산
    direction = "Short" if side == "Buy" else "Long"

    # 진입 시점 전후 캔들 찾기
    entry_candles_before = [k for k in klines_5m if k["timestamp"] <= entry_ts]
    entry_candles_after = [k for k in klines_5m if k["timestamp"] > entry_ts]

    analysis = {
        "direction": direction,
        "entry_price": entry_price,
        "exit_price": exit_price,
    }

    # 진입 전 5개 캔들 분석 (25분)
    if len(entry_candles_before) >= 5:
        recent = entry_candles_before[-5:]
        high_5 = max(k["high"] for k in recent)
        low_5 = min(k["low"] for k in recent)
        range_5 = high_5 - low_5 if high_5 != low_5 else 0.0001

        # 진입가의 직전 레인지 내 위치 (0=저점, 100=고점)
        position_in_range = ((entry_price - low_5) / range_5) * 100
        analysis["range_position"] = round(position_in_range, 1)

        # Short이면 고점 근처(80+)가 좋고, Long이면 저점 근처(20-)가 좋음
        if direction == "Short":
            analysis["entry_quality"] = "GOOD" if position_in_range >= 70 else "OK" if position_in_range >= 50 else "BAD"
        else:
            analysis["entry_quality"] = "GOOD" if position_in_range <= 30 else "OK" if position_in_range <= 50 else "BAD"

        # 볼륨 트렌드
        vols = [k["volume"] for k in recent]
        avg_vol = sum(vols) / len(vols)
        last_vol = vols[-1]
        analysis["volume_vs_avg"] = round(last_vol / avg_vol, 2) if avg_vol > 0 else 1.0

        # 가격 모멘텀 (5캔들 변화율)
        momentum = ((recent[-1]["close"] - recent[0]["open"]) / recent[0]["open"]) * 100
        analysis["momentum_5candles"] = round(momentum, 3)

        # Short인데 가격이 이미 떨어지고 있었다면 → 추격 진입
        if direction == "Short" and momentum < -0.3:
            analysis["is_chasing"] = True
        elif direction == "Long" and momentum > 0.3:
            analysis["is_chasing"] = True
        else:
            analysis["is_chasing"] = False

    # 진입 후 가격 움직임 (MFE/MAE)
    if len(entry_candles_after) > 0:
        after_candles = entry_candles_after[:12]  # 최대 1시간

        if direction == "Short":
            mfe = max((entry_price - k["low"]) / entry_price * 100 for k in after_candles) if after_candles else 0
            mae = max((k["high"] - entry_price) / entry_price * 100 for k in after_candles) if after_candles else 0
        else:
            mfe = max((k["high"] - entry_price) / entry_price * 100 for k in after_candles) if after_candles else 0
            mae = max((entry_price - k["low"]) / entry_price * 100 for k in after_candles) if after_candles else 0

        analysis["mfe_1hr"] = round(mfe, 3)
        analysis["mae_1hr"] = round(mae, 3)

        # 5분 후 움직임
        if len(after_candles) >= 1:
            price_5m = after_candles[0]["close"]
            move_5m = ((price_5m - entry_price) / entry_price) * 100
            dir_move_5m = move_5m if direction == "Long" else -move_5m
            analysis["move_after_5min"] = round(dir_move_5m, 3)

        # 15분 후 움직임
        if len(after_candles) >= 3:
            price_15m = after_candles[2]["close"]
            move_15m = ((price_15m - entry_price) / entry_price) * 100
            dir_move_15m = move_15m if direction == "Long" else -move_15m
            analysis["move_after_15min"] = round(dir_move_15m, 3)

    return analysis

def calculate_rsi(closes, period=14):
    """RSI 계산"""
    if len(closes) < period + 1:
        return 50

    gains = []
    losses = []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i-1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)

# ===== 메인 실행 =====
def main():
    print("=" * 70)
    print("  Bybit 거래내역 분석 — 새벽 1시(KST) 이후")
    print("=" * 70)

    now = datetime.now(KST)

    # 오늘 새벽 1시 KST
    start_1am = now.replace(hour=1, minute=0, second=0, microsecond=0)
    if now.hour < 1:
        start_1am -= timedelta(days=1)

    start_ts_ms = int(start_1am.timestamp() * 1000)
    end_ts_ms = int(now.timestamp() * 1000)

    print(f"\n조회 기간: {start_1am.strftime('%Y-%m-%d %H:%M')} ~ {now.strftime('%Y-%m-%d %H:%M')} (KST)")
    print(f"Timestamp: {start_ts_ms} ~ {end_ts_ms}")

    # === 계정 정보 ===
    print("\n" + "=" * 50)
    print("📊 계정 정보")
    print("=" * 50)
    wallet = bybit_get("/v5/account/wallet-balance", {"accountType": "UNIFIED"})
    if wallet and wallet.get("list"):
        acct = wallet["list"][0]
        print(f"  Total Equity: ${float(acct.get('totalEquity', 0)):.2f}")
        print(f"  Available:    ${float(acct.get('totalAvailableBalance', 0)):.2f}")
        print(f"  Unrealized PnL: ${float(acct.get('totalPerpUPL', 0)):.4f}")

    # === 현재 오픈 포지션 ===
    print("\n" + "=" * 50)
    print("📈 현재 오픈 포지션")
    print("=" * 50)
    positions = fetch_open_positions()
    if positions:
        for p in positions:
            sym = p["symbol"]
            side = p["side"]
            size = float(p["size"])
            entry = float(p.get("avgPrice", 0))
            mark = float(p.get("markPrice", 0))
            upnl = float(p.get("unrealisedPnl", 0))
            lev = p.get("leverage", "?")
            print(f"  {sym} {side} x{lev} | Size={size} | Entry={entry} | Mark={mark} | UPnL=${upnl:.4f}")
    else:
        print("  오픈 포지션 없음")

    # === Closed PnL ===
    print("\n" + "=" * 50)
    print("📋 Closed PnL (새벽 1시 이후)")
    print("=" * 50)

    trades = fetch_closed_pnl(start_ts_ms, end_ts_ms)

    if not trades:
        print("  거래 내역 없음!")

        # 더 넓은 범위로 시도 — 24시간 전부터
        print("\n  → 24시간 전부터 다시 조회...")
        start_24h = int((now - timedelta(hours=24)).timestamp() * 1000)
        trades = fetch_closed_pnl(start_24h, end_ts_ms)

        if not trades:
            print("  24시간 내 거래도 없음!")

            # 7일 전부터 시도
            print("\n  → 7일 전부터 다시 조회...")
            start_7d = int((now - timedelta(days=7)).timestamp() * 1000)
            trades = fetch_closed_pnl(start_7d, end_ts_ms)

    if not trades:
        print("\n  ❌ 거래 내역을 찾을 수 없습니다.")
        print("  → API 키가 올바른지, 해당 계정에서 거래가 있었는지 확인하세요.")
        return

    # 시간순 정렬
    trades.sort(key=lambda t: int(t.get("createdTime", 0)))

    print(f"\n  총 {len(trades)}건 발견")
    print("-" * 120)
    print(f"  {'#':>3} | {'시간(KST)':>18} | {'종목':>14} | {'방향':>6} | {'레버리지':>4} | {'진입가':>12} | {'청산가':>12} | {'PnL':>10} | {'홀딩(분)':>8}")
    print("-" * 120)

    total_pnl = 0
    wins = 0
    losses = 0
    breakeven = 0

    trade_details = []

    for i, t in enumerate(trades):
        sym = t["symbol"]
        side = t["side"]
        # Bybit closed-pnl의 side = 클로징 사이드
        # "Buy" = Short 포지션을 Buy로 청산 → Short
        # "Sell" = Long 포지션을 Sell로 청산 → Long
        direction = "Short" if side == "Buy" else "Long"

        entry_price = float(t.get("avgEntryPrice", 0))
        exit_price = float(t.get("avgExitPrice", 0))
        pnl = float(t.get("closedPnl", 0))
        qty = float(t.get("qty", 0))
        leverage = t.get("leverage", "?")

        created_ts = int(t.get("createdTime", 0))
        updated_ts = int(t.get("updatedTime", 0))

        created_dt = datetime.fromtimestamp(created_ts / 1000, KST)
        updated_dt = datetime.fromtimestamp(updated_ts / 1000, KST)
        holding_min = (updated_ts - created_ts) / 60000

        total_pnl += pnl
        if pnl > 0.001:
            wins += 1
            result_str = "WIN"
        elif pnl < -0.001:
            losses += 1
            result_str = "LOSS"
        else:
            breakeven += 1
            result_str = "BE"

        # 레버리지 결정 (order_type 없으면 계산)
        if leverage == "?" and entry_price > 0 and qty > 0:
            notional = entry_price * qty
            # 대략적 추정
            leverage = "~"

        print(f"  {i+1:>3} | {created_dt.strftime('%m/%d %H:%M:%S'):>18} | {sym:>14} | {direction:>6} | {leverage:>4}x | {entry_price:>12.4f} | {exit_price:>12.4f} | ${pnl:>+9.4f} | {holding_min:>7.1f}")

        trade_details.append({
            "symbol": sym,
            "direction": direction,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "pnl": pnl,
            "result": result_str,
            "created_ts": created_ts,
            "updated_ts": updated_ts,
            "holding_min": holding_min,
            "leverage": leverage,
            "qty": qty,
        })

    print("-" * 120)

    total_trades = wins + losses + breakeven
    wr = (wins / total_trades * 100) if total_trades > 0 else 0

    print(f"\n  📊 요약:")
    print(f"     총 거래: {total_trades}건")
    print(f"     승/패/BE: {wins}W / {losses}L / {breakeven}BE")
    print(f"     승률: {wr:.1f}%")
    print(f"     총 PnL: ${total_pnl:+.4f}")
    if wins > 0:
        avg_win = sum(t["pnl"] for t in trade_details if t["pnl"] > 0.001) / wins
        print(f"     평균 수익: ${avg_win:+.4f}")
    if losses > 0:
        avg_loss = sum(t["pnl"] for t in trade_details if t["pnl"] < -0.001) / losses
        print(f"     평균 손실: ${avg_loss:+.4f}")

    # === 시장 데이터 비교 분석 ===
    print("\n" + "=" * 50)
    print("🔍 진입 품질 분석 (시장 데이터 비교)")
    print("=" * 50)

    # 각 거래별 5분봉 데이터 가져와서 분석
    symbols_analyzed = set()

    for i, td in enumerate(trade_details):
        sym = td["symbol"]
        entry_ts = td["created_ts"]

        # 진입 30분 전 ~ 1시간 후 5분봉
        kline_start = entry_ts - 30 * 60 * 1000
        kline_end = entry_ts + 60 * 60 * 1000

        print(f"\n  [{i+1}] {sym} {td['direction']} @ {td['entry_price']}")

        klines = fetch_klines(sym, "5", kline_start, 100)
        time.sleep(0.15)  # Rate limit

        if not klines:
            print(f"      ⚠️ 캔들 데이터 없음")
            continue

        # 진입 전 캔들
        before = [k for k in klines if k["timestamp"] <= entry_ts]
        after = [k for k in klines if k["timestamp"] > entry_ts]

        if len(before) >= 5:
            recent5 = before[-5:]
            high5 = max(k["high"] for k in recent5)
            low5 = min(k["low"] for k in recent5)
            rng = high5 - low5 if high5 != low5 else 0.0001
            pos = ((td["entry_price"] - low5) / rng) * 100

            closes = [k["close"] for k in before[-20:]]
            rsi = calculate_rsi(closes)

            # 모멘텀 (5캔들)
            mom = ((recent5[-1]["close"] - recent5[0]["open"]) / recent5[0]["open"]) * 100

            # 볼륨
            vols = [k["volume"] for k in recent5]
            avg_v = sum(vols) / len(vols) if vols else 1
            last_v = vols[-1] if vols else 1
            vol_ratio = last_v / avg_v if avg_v > 0 else 1

            print(f"      📊 레인지 위치: {pos:.1f}% (0=저점, 100=고점)")
            print(f"      📊 RSI(14): {rsi}")
            print(f"      📊 모멘텀(25분): {mom:+.3f}%")
            print(f"      📊 볼륨비: {vol_ratio:.2f}x")

            # 진입 품질 판정
            if td["direction"] == "Short":
                if pos >= 70:
                    quality = "✅ GOOD (고점 근처 Short)"
                elif pos >= 50:
                    quality = "⚠️ OK (중간 위치)"
                else:
                    quality = "❌ BAD (저점 근처에서 Short)"

                if mom < -0.3:
                    print(f"      ⚠️ 추격 진입! (이미 {mom:.3f}% 하락 중에 Short)")

                if rsi < 30:
                    print(f"      ⚠️ RSI 과매도({rsi}) — Short 위험 구간")
                elif rsi > 70:
                    print(f"      ✅ RSI 과매수({rsi}) — Short 유리")
            else:
                if pos <= 30:
                    quality = "✅ GOOD (저점 근처 Long)"
                elif pos <= 50:
                    quality = "⚠️ OK (중간 위치)"
                else:
                    quality = "❌ BAD (고점 근처에서 Long)"

                if mom > 0.3:
                    print(f"      ⚠️ 추격 진입! (이미 {mom:.3f}% 상승 중에 Long)")

                if rsi > 70:
                    print(f"      ⚠️ RSI 과매수({rsi}) — Long 위험 구간")
                elif rsi < 30:
                    print(f"      ✅ RSI 과매도({rsi}) — Long 유리")

            print(f"      진입 품질: {quality}")

        # 진입 후 가격 움직임
        if len(after) > 0:
            if td["direction"] == "Short":
                mfe = max((td["entry_price"] - k["low"]) / td["entry_price"] * 100 for k in after[:12])
                mae = max((k["high"] - td["entry_price"]) / td["entry_price"] * 100 for k in after[:12])
            else:
                mfe = max((k["high"] - td["entry_price"]) / td["entry_price"] * 100 for k in after[:12])
                mae = max((td["entry_price"] - k["low"]) / td["entry_price"] * 100 for k in after[:12])

            print(f"      📈 MFE(1hr): +{mfe:.3f}% | MAE(1hr): -{mae:.3f}%")

            # 5분/15분 후 움직임
            if len(after) >= 1:
                p5 = after[0]["close"]
                m5 = ((p5 - td["entry_price"]) / td["entry_price"]) * 100
                dm5 = m5 if td["direction"] == "Long" else -m5
                print(f"      📈 5분 후: {dm5:+.3f}%")

            if len(after) >= 3:
                p15 = after[2]["close"]
                m15 = ((p15 - td["entry_price"]) / td["entry_price"]) * 100
                dm15 = m15 if td["direction"] == "Long" else -m15
                print(f"      📈 15분 후: {dm15:+.3f}%")

            # TP/SL 도달 가능성
            actual_pnl_pct = ((td["exit_price"] - td["entry_price"]) / td["entry_price"]) * 100
            if td["direction"] == "Short":
                actual_pnl_pct = -actual_pnl_pct

            print(f"      📈 실제 PnL%: {actual_pnl_pct:+.3f}% | MFE/|PnL|: {mfe/abs(actual_pnl_pct):.2f}x" if abs(actual_pnl_pct) > 0.001 else f"      📈 실제 PnL%: {actual_pnl_pct:+.3f}%")

        print(f"      💰 결과: {td['result']} (${td['pnl']:+.4f}), 홀딩 {td['holding_min']:.1f}분")

    # === 종합 평가 ===
    print("\n" + "=" * 50)
    print("🎯 종합 진입 품질 평가")
    print("=" * 50)

    # 종목별 집계
    by_symbol = {}
    for td in trade_details:
        sym = td["symbol"]
        if sym not in by_symbol:
            by_symbol[sym] = {"count": 0, "pnl": 0, "wins": 0}
        by_symbol[sym]["count"] += 1
        by_symbol[sym]["pnl"] += td["pnl"]
        if td["pnl"] > 0.001:
            by_symbol[sym]["wins"] += 1

    print(f"\n  종목별 성과:")
    for sym, stats in sorted(by_symbol.items(), key=lambda x: x[1]["pnl"], reverse=True):
        wr_sym = (stats["wins"] / stats["count"] * 100) if stats["count"] > 0 else 0
        print(f"    {sym:>14}: {stats['count']:>2}건, WR={wr_sym:.0f}%, PnL=${stats['pnl']:+.4f}")

    # 홀딩 시간 분석
    holding_times = [td["holding_min"] for td in trade_details]
    if holding_times:
        avg_hold = sum(holding_times) / len(holding_times)
        min_hold = min(holding_times)
        max_hold = max(holding_times)
        print(f"\n  홀딩 시간: 평균 {avg_hold:.1f}분 (최소 {min_hold:.1f}분, 최대 {max_hold:.1f}분)")

    # 시간대별 분석
    by_hour = {}
    for td in trade_details:
        hour = datetime.fromtimestamp(td["created_ts"] / 1000, KST).hour
        if hour not in by_hour:
            by_hour[hour] = {"count": 0, "pnl": 0, "wins": 0}
        by_hour[hour]["count"] += 1
        by_hour[hour]["pnl"] += td["pnl"]
        if td["pnl"] > 0.001:
            by_hour[hour]["wins"] += 1

    print(f"\n  시간대별:")
    for hour in sorted(by_hour.keys()):
        stats = by_hour[hour]
        wr_h = (stats["wins"] / stats["count"] * 100) if stats["count"] > 0 else 0
        print(f"    {hour:02d}시: {stats['count']:>2}건, WR={wr_h:.0f}%, PnL=${stats['pnl']:+.4f}")


if __name__ == "__main__":
    main()
