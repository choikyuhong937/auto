"""
Long 기회 분석 — Short 진입 시점에서 실제로는 반등(Long) 자리였던 케이스 발굴
Bybit V5 API로 최근 거래 + 시장 데이터(klines) 비교
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
    param_str = f"{timestamp}{API_KEY}{recv_window}{params_str}"
    return hmac.new(
        api_secret.encode('utf-8'),
        param_str.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

def bybit_get(endpoint, params=None):
    if params is None:
        params = {}
    timestamp = str(int(time.time() * 1000))
    recv_window = "5000"
    sorted_params = sorted(params.items())
    param_str = "&".join(f"{k}={v}" for k, v in sorted_params)
    sign = get_signature(param_str, timestamp, API_SECRET, recv_window)
    headers = {
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
    }
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
    if params is None:
        params = {}
    resp = requests.get(f"{BASE_URL}{endpoint}", params=params)
    data = resp.json()
    if data.get("retCode") != 0:
        return None
    return data.get("result", {})

def fetch_closed_pnl(start_ts_ms, end_ts_ms=None):
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
        time.sleep(0.1)
    return all_trades

def fetch_klines(symbol, interval, start_ms, limit=200):
    """Bybit V5 kline 데이터"""
    result = bybit_public_get("/v5/market/kline", {
        "category": "linear",
        "symbol": symbol,
        "interval": str(interval),
        "start": str(start_ms),
        "limit": str(limit),
    })
    if not result:
        return []
    klines = result.get("list", [])
    # Bybit klines: [timestamp, open, high, low, close, volume, turnover]
    # 역순으로 반환되므로 정렬
    parsed = []
    for k in reversed(klines):
        parsed.append({
            "ts": int(k[0]),
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
        })
    return parsed

def get_session(hour_kst):
    """KST 시간 기준 세션"""
    if 0 <= hour_kst < 2: return "ASIA_LATE"
    if 2 <= hour_kst < 4: return "OVERLAP_ASIA_EU"
    if 4 <= hour_kst < 9: return "ASIA"
    if 9 <= hour_kst < 16: return "EUROPE"
    if 16 <= hour_kst < 18: return "OVERLAP_EU_US"
    if 18 <= hour_kst < 24: return "US"
    return "UNKNOWN"

# ===================================================
# 메인 분석
# ===================================================
def main():
    print("=" * 80)
    print("  Long 기회 분석 — Short 진입이 실제로는 반등 자리였던 케이스")
    print("=" * 80)

    # 최근 7일 데이터 (넉넉히)
    now_kst = datetime.now(KST)
    start_time = now_kst - timedelta(days=7)
    start_ms = int(start_time.timestamp() * 1000)

    print(f"\n조회 기간: {start_time.strftime('%m/%d %H:%M')} ~ {now_kst.strftime('%m/%d %H:%M')} KST")
    print("거래내역 로딩...")

    raw_trades = fetch_closed_pnl(start_ms)
    if not raw_trades:
        print("거래 데이터 없음!")
        return

    # 파싱
    trades = []
    for t in raw_trades:
        side = t.get("side", "")
        # Bybit closed-pnl side = 청산 방향 (Buy = Short포지션 청산, Sell = Long포지션 청산)
        direction = "Short" if side == "Buy" else "Long"
        pnl = float(t.get("closedPnl", 0))
        entry = float(t.get("avgEntryPrice", 0))
        exit_p = float(t.get("avgExitPrice", 0))
        qty = float(t.get("qty", 0))
        created = int(t.get("createdTime", 0))
        updated = int(t.get("updatedTime", 0))

        dt_entry = datetime.fromtimestamp(created / 1000, KST)
        dt_exit = datetime.fromtimestamp(updated / 1000, KST)
        holding_sec = (updated - created) / 1000

        trades.append({
            "symbol": t.get("symbol", ""),
            "direction": direction,
            "pnl": pnl,
            "entry_price": entry,
            "exit_price": exit_p,
            "qty": qty,
            "entry_ts": created,
            "exit_ts": updated,
            "entry_dt": dt_entry,
            "exit_dt": dt_exit,
            "holding_sec": holding_sec,
            "leverage": float(t.get("leverage", 0)),
            "session": get_session(dt_entry.hour),
            "result": "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "BE",
        })

    # 시간순 정렬
    trades.sort(key=lambda x: x["entry_ts"])

    total = len(trades)
    shorts = [t for t in trades if t["direction"] == "Short"]
    short_losses = [t for t in shorts if t["result"] == "LOSS"]
    short_wins = [t for t in shorts if t["result"] == "WIN"]

    print(f"\n총 {total}건 거래 | Short {len(shorts)}건 (W:{len(short_wins)} L:{len(short_losses)})")
    print(f"Short 승률: {len(short_wins)/len(shorts)*100:.1f}%" if shorts else "")

    # ===================================================
    # 핵심 분석: Short LOSS 각각에 대해 "Long이었으면 어땠나?"
    # ===================================================
    print("\n" + "=" * 80)
    print("  Short LOSS 거래별 — Long이었으면? (진입 후 가격 움직임)")
    print("=" * 80)

    long_opp = []  # Long 기회였던 케이스

    for i, t in enumerate(short_losses):
        symbol = t["symbol"]
        entry_price = t["entry_price"]
        entry_ts = t["entry_ts"]

        # 진입 시점부터 1시간 후까지 1분봉 가져오기
        time.sleep(0.15)  # rate limit
        klines = fetch_klines(symbol, "1", entry_ts, 60)

        if len(klines) < 5:
            print(f"  [{i+1}] {symbol} {t['entry_dt'].strftime('%m/%d %H:%M')} — kline 부족")
            continue

        # 진입 후 가격 추적
        # 5분(5봉), 15분(15봉), 30분(30봉), 60분(60봉)
        max_up_5 = 0
        max_down_5 = 0
        max_up_15 = 0
        max_down_15 = 0
        max_up_30 = 0
        max_down_30 = 0
        max_up_60 = 0
        max_down_60 = 0
        close_5 = None
        close_15 = None
        close_30 = None
        close_60 = None

        for j, k in enumerate(klines):
            change_pct = ((k["high"] - entry_price) / entry_price) * 100
            drop_pct = ((entry_price - k["low"]) / entry_price) * 100
            close_chg = ((k["close"] - entry_price) / entry_price) * 100

            if j < 5:
                max_up_5 = max(max_up_5, change_pct)
                max_down_5 = max(max_down_5, drop_pct)
                if j == 4:
                    close_5 = close_chg
            if j < 15:
                max_up_15 = max(max_up_15, change_pct)
                max_down_15 = max(max_down_15, drop_pct)
                if j == 14:
                    close_15 = close_chg
            if j < 30:
                max_up_30 = max(max_up_30, change_pct)
                max_down_30 = max(max_down_30, drop_pct)
                if j == 29:
                    close_30 = close_chg
            if j < 60:
                max_up_60 = max(max_up_60, change_pct)
                max_down_60 = max(max_down_60, drop_pct)
                if j == 59:
                    close_60 = close_chg

        # Long이었으면 수익이었나?
        # 기준: 5분 이내 +0.3% 이상 상승했다면 Long 기회
        would_long_win_5 = max_up_5 >= 0.3
        would_long_win_15 = max_up_15 >= 0.5
        would_long_win_30 = max_up_30 >= 0.8

        # 실제 Short 손실 vs Long 가능 수익
        short_pnl = t["pnl"]

        # 결과 저장
        opp = {
            **t,
            "max_up_5": max_up_5,
            "max_down_5": max_down_5,
            "max_up_15": max_up_15,
            "max_down_15": max_down_15,
            "max_up_30": max_up_30,
            "max_down_30": max_down_30,
            "max_up_60": max_up_60,
            "max_down_60": max_down_60,
            "close_5": close_5,
            "close_15": close_15,
            "close_30": close_30,
            "close_60": close_60,
            "would_long_win_5": would_long_win_5,
            "would_long_win_15": would_long_win_15,
            "would_long_win_30": would_long_win_30,
        }
        long_opp.append(opp)

        # 출력
        tag_5 = "LONG OK" if would_long_win_5 else "---"
        tag_15 = "LONG OK" if would_long_win_15 else "---"

        print(f"\n  [{i+1}/{len(short_losses)}] {symbol} @ {t['entry_dt'].strftime('%m/%d %H:%M')} | "
              f"Short Loss ${short_pnl:.3f} | Lev={t['leverage']:.0f}x | {t['session']}")
        print(f"    Entry: ${entry_price:.4f}")
        print(f"    5분:  UP +{max_up_5:.2f}% / DOWN -{max_down_5:.2f}% | Close {close_5:+.2f}% | {tag_5}" if close_5 is not None else f"    5분:  UP +{max_up_5:.2f}% / DOWN -{max_down_5:.2f}% | {tag_5}")
        print(f"    15분: UP +{max_up_15:.2f}% / DOWN -{max_down_15:.2f}% | Close {close_15:+.2f}% | {tag_15}" if close_15 is not None else f"    15분: UP +{max_up_15:.2f}% / DOWN -{max_down_15:.2f}% | {tag_15}")
        print(f"    30분: UP +{max_up_30:.2f}% / DOWN -{max_down_30:.2f}%" + (f" | Close {close_30:+.2f}%" if close_30 is not None else ""))
        print(f"    60분: UP +{max_up_60:.2f}% / DOWN -{max_down_60:.2f}%" + (f" | Close {close_60:+.2f}%" if close_60 is not None else ""))

    # ===================================================
    # Short WIN도 분석 — Long이었어도 수익이었나?
    # ===================================================
    print("\n" + "=" * 80)
    print("  Short WIN 거래별 — Long이었으면 손실이었나?")
    print("=" * 80)

    short_win_would_long = []

    for i, t in enumerate(short_wins):
        symbol = t["symbol"]
        entry_price = t["entry_price"]
        entry_ts = t["entry_ts"]

        time.sleep(0.15)
        klines = fetch_klines(symbol, "1", entry_ts, 60)

        if len(klines) < 5:
            continue

        max_up_15 = 0
        max_down_15 = 0
        for j, k in enumerate(klines[:15]):
            change_pct = ((k["high"] - entry_price) / entry_price) * 100
            drop_pct = ((entry_price - k["low"]) / entry_price) * 100
            max_up_15 = max(max_up_15, change_pct)
            max_down_15 = max(max_down_15, drop_pct)

        would_long_also_win = max_up_15 >= 0.3
        short_win_would_long.append({
            **t,
            "max_up_15": max_up_15,
            "max_down_15": max_down_15,
            "would_long_also_win": would_long_also_win,
        })

        tag = "BOTH WIN" if would_long_also_win else "SHORT ONLY"
        print(f"  [{i+1}] {symbol} {t['entry_dt'].strftime('%m/%d %H:%M')} | "
              f"Short Win ${t['pnl']:.3f} | 15분 UP +{max_up_15:.2f}% DOWN -{max_down_15:.2f}% | {tag}")

    # ===================================================
    # 집계 분석
    # ===================================================
    print("\n" + "=" * 80)
    print("  집계 분석")
    print("=" * 80)

    if long_opp:
        # Short LOSS 중 Long이었으면 수익이었던 비율
        would_long_5 = sum(1 for o in long_opp if o["would_long_win_5"])
        would_long_15 = sum(1 for o in long_opp if o["would_long_win_15"])
        would_long_30 = sum(1 for o in long_opp if o["would_long_win_30"])

        print(f"\n  Short LOSS {len(long_opp)}건 중:")
        print(f"    5분 내 Long +0.3% 도달: {would_long_5}건 ({would_long_5/len(long_opp)*100:.0f}%)")
        print(f"    15분 내 Long +0.5% 도달: {would_long_15}건 ({would_long_15/len(long_opp)*100:.0f}%)")
        print(f"    30분 내 Long +0.8% 도달: {would_long_30}건 ({would_long_30/len(long_opp)*100:.0f}%)")

        # 5분 내 평균 상승/하락
        avg_up_5 = sum(o["max_up_5"] for o in long_opp) / len(long_opp)
        avg_down_5 = sum(o["max_down_5"] for o in long_opp) / len(long_opp)
        avg_up_15 = sum(o["max_up_15"] for o in long_opp) / len(long_opp)
        avg_down_15 = sum(o["max_down_15"] for o in long_opp) / len(long_opp)

        print(f"\n  Short LOSS 후 평균 가격 움직임:")
        print(f"    5분:  UP +{avg_up_5:.2f}% / DOWN -{avg_down_5:.2f}%")
        print(f"    15분: UP +{avg_up_15:.2f}% / DOWN -{avg_down_15:.2f}%")

        total_short_loss_pnl = sum(o["pnl"] for o in long_opp)
        print(f"\n  Short LOSS 총 손실: ${total_short_loss_pnl:.3f}")

        # 세션별 Long 기회 분석
        print(f"\n  세션별 Long 기회 (Short LOSS 중 15분 내 반등 비율):")
        session_stats = {}
        for o in long_opp:
            s = o["session"]
            if s not in session_stats:
                session_stats[s] = {"total": 0, "long_opp": 0, "loss_pnl": 0, "avg_up_15": []}
            session_stats[s]["total"] += 1
            if o["would_long_win_15"]:
                session_stats[s]["long_opp"] += 1
            session_stats[s]["loss_pnl"] += o["pnl"]
            session_stats[s]["avg_up_15"].append(o["max_up_15"])

        for s, stats in sorted(session_stats.items()):
            pct = stats["long_opp"] / stats["total"] * 100 if stats["total"] > 0 else 0
            avg = sum(stats["avg_up_15"]) / len(stats["avg_up_15"]) if stats["avg_up_15"] else 0
            print(f"    {s:20s}: {stats['total']}건 LOSS | {stats['long_opp']}건 Long OK ({pct:.0f}%) | "
                  f"Short Loss ${stats['loss_pnl']:.3f} | 15분 평균 반등 +{avg:.2f}%")

    # Short WIN 중 Long도 수익이었던 비율
    if short_win_would_long:
        both_win = sum(1 for o in short_win_would_long if o["would_long_also_win"])
        print(f"\n  Short WIN {len(short_win_would_long)}건 중 Long도 수익 가능:")
        print(f"    {both_win}건 ({both_win/len(short_win_would_long)*100:.0f}%)")
        print(f"    -> 이 시점은 방향 무관 (양방향 수익 가능 = 변동성 큰 구간)")

    # ===================================================
    # 핵심 결론
    # ===================================================
    print("\n" + "=" * 80)
    print("  핵심 결론 — Short를 Long으로 뒤집었다면?")
    print("=" * 80)

    if long_opp:
        # 가상 시나리오: Short LOSS 시점에 Long 진입했다면
        # 레버리지 동일, TP = max_up_15의 50% (현실적 수익)
        estimated_long_profit = 0
        convertible = 0

        for o in long_opp:
            if o["would_long_win_15"]:
                # 가정: Long 진입, 15분 최대 상승의 40%를 TP로 잡음
                realistic_gain_pct = o["max_up_15"] * 0.4
                lev = o["leverage"]
                # qty * entry_price 기준 수익 계산 (간이)
                est_gain = o["qty"] * o["entry_price"] * (realistic_gain_pct / 100)
                estimated_long_profit += est_gain
                convertible += 1

        print(f"\n  Short LOSS {len(long_opp)}건 중 Long 전환 가능: {convertible}건")
        print(f"  실제 Short 손실 합계: ${total_short_loss_pnl:.3f}")
        print(f"  가상 Long 수익 추정 (15분 최고 상승의 40%): ${estimated_long_profit:.3f}")
        print(f"  차이: ${estimated_long_profit - abs(total_short_loss_pnl):.3f}")

    # ===================================================
    # 구체적 Long 패턴 식별
    # ===================================================
    if long_opp:
        print("\n" + "=" * 80)
        print("  Long 기회 패턴 분석 — 어떤 조건에서 반등이 큰가?")
        print("=" * 80)

        # 레버리지별
        print(f"\n  레버리지별 반등 크기:")
        lev_groups = {}
        for o in long_opp:
            lev = int(o["leverage"])
            if lev not in lev_groups:
                lev_groups[lev] = []
            lev_groups[lev].append(o)

        for lev in sorted(lev_groups.keys()):
            items = lev_groups[lev]
            avg_up = sum(i["max_up_15"] for i in items) / len(items)
            long_rate = sum(1 for i in items if i["would_long_win_15"]) / len(items) * 100
            print(f"    {lev}x: {len(items)}건 | 15분 평균 반등 +{avg_up:.2f}% | Long 성공률 {long_rate:.0f}%")

        # 홀딩 시간별 (Short이 얼마나 빨리 SL 당했나)
        print(f"\n  Short 홀딩 시간별 Long 기회:")
        for label, min_sec, max_sec in [
            ("< 1분", 0, 60),
            ("1-5분", 60, 300),
            ("5-15분", 300, 900),
            ("15분+", 900, 999999),
        ]:
            items = [o for o in long_opp if min_sec <= o["holding_sec"] < max_sec]
            if items:
                avg_up = sum(i["max_up_15"] for i in items) / len(items)
                long_rate = sum(1 for i in items if i["would_long_win_15"]) / len(items) * 100
                print(f"    {label:10s}: {len(items)}건 | 15분 평균 반등 +{avg_up:.2f}% | Long 성공률 {long_rate:.0f}%")

        # 시간대별
        print(f"\n  시간대별(KST) 반등 크기:")
        hour_groups = {}
        for o in long_opp:
            h = o["entry_dt"].hour
            if h not in hour_groups:
                hour_groups[h] = []
            hour_groups[h].append(o)

        for h in sorted(hour_groups.keys()):
            items = hour_groups[h]
            avg_up = sum(i["max_up_15"] for i in items) / len(items)
            long_rate = sum(1 for i in items if i["would_long_win_15"]) / len(items) * 100
            print(f"    {h:02d}시: {len(items)}건 | 15분 평균 반등 +{avg_up:.2f}% | Long 성공률 {long_rate:.0f}%")

    print("\n" + "=" * 80)
    print("  분석 완료")
    print("=" * 80)

if __name__ == "__main__":
    main()
