"""
Early Exit 분석 - Short 진입 직후 1~5분 가격 패턴
WIN vs LOSS가 초반에 구별 가능한가?
구별 가능하면 -> 조기 탈출로 손실 줄일 수 있음
"""

import hmac, hashlib, time, json, requests
from datetime import datetime, timedelta, timezone

API_KEY = "zSWjsmTPZPrE5ZBtDP"
API_SECRET = "nds8YctHzMTutjw6oOW8HZtZ0225mkNDXzK2"
BASE_URL = "https://api.bybit.com"
KST = timezone(timedelta(hours=9))

def get_signature(params_str, timestamp, api_secret, recv_window="5000"):
    param_str = f"{timestamp}{API_KEY}{recv_window}{params_str}"
    return hmac.new(api_secret.encode('utf-8'), param_str.encode('utf-8'), hashlib.sha256).hexdigest()

def bybit_get(endpoint, params=None):
    if params is None: params = {}
    timestamp = str(int(time.time() * 1000))
    recv_window = "5000"
    sorted_params = sorted(params.items())
    param_str = "&".join(f"{k}={v}" for k, v in sorted_params)
    sign = get_signature(param_str, timestamp, API_SECRET, recv_window)
    headers = {"X-BAPI-API-KEY": API_KEY, "X-BAPI-SIGN": sign, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recv_window}
    url = f"{BASE_URL}{endpoint}"
    if param_str: url += f"?{param_str}"
    resp = requests.get(url, headers=headers)
    data = resp.json()
    if data.get("retCode") != 0: return None
    return data.get("result", {})

def bybit_public_get(endpoint, params=None):
    if params is None: params = {}
    resp = requests.get(f"{BASE_URL}{endpoint}", params=params)
    data = resp.json()
    if data.get("retCode") != 0: return None
    return data.get("result", {})

def fetch_closed_pnl(start_ts_ms):
    all_trades = []
    cursor = ""
    while True:
        params = {"category": "linear", "startTime": str(start_ts_ms), "limit": "100"}
        if cursor: params["cursor"] = cursor
        result = bybit_get("/v5/position/closed-pnl", params)
        if not result: break
        trades = result.get("list", [])
        all_trades.extend(trades)
        cursor = result.get("nextPageCursor", "")
        if not cursor or len(trades) == 0: break
        time.sleep(0.1)
    return all_trades

def fetch_klines(symbol, interval, start_ms, limit=200):
    result = bybit_public_get("/v5/market/kline", {
        "category": "linear", "symbol": symbol, "interval": str(interval),
        "start": str(start_ms), "limit": str(limit)
    })
    if not result: return []
    klines = result.get("list", [])
    parsed = []
    for k in reversed(klines):
        parsed.append({"ts": int(k[0]), "open": float(k[1]), "high": float(k[2]),
                       "low": float(k[3]), "close": float(k[4]), "volume": float(k[5])})
    return parsed

def main():
    print("=" * 80)
    print("  Early Exit 분석 - Short WIN vs LOSS 초반 가격 패턴")
    print("=" * 80)

    now_kst = datetime.now(KST)
    start_ms = int((now_kst - timedelta(days=7)).timestamp() * 1000)
    raw_trades = fetch_closed_pnl(start_ms)
    if not raw_trades:
        print("거래 데이터 없음!")
        return

    trades = []
    for t in raw_trades:
        side = t.get("side", "")
        direction = "Short" if side == "Buy" else "Long"
        if direction != "Short": continue
        pnl = float(t.get("closedPnl", 0))
        entry = float(t.get("avgEntryPrice", 0))
        created = int(t.get("createdTime", 0))
        updated = int(t.get("updatedTime", 0))
        holding_sec = (updated - created) / 1000
        result = "WIN" if pnl > 0 else "LOSS"
        trades.append({
            "symbol": t.get("symbol", ""), "pnl": pnl, "entry_price": entry,
            "entry_ts": created, "exit_ts": updated, "holding_sec": holding_sec,
            "leverage": float(t.get("leverage", 0)), "result": result,
            "entry_dt": datetime.fromtimestamp(created/1000, KST),
        })

    trades.sort(key=lambda x: x["entry_ts"])
    wins = [t for t in trades if t["result"] == "WIN"]
    losses = [t for t in trades if t["result"] == "LOSS"]
    print(f"\nShort 거래: {len(trades)}건 (W:{len(wins)} L:{len(losses)})")

    # ===================================================
    # 진입 직후 1분봉 분석 (1분/2분/3분/5분 시점)
    # ===================================================
    print("\n" + "=" * 80)
    print("  진입 직후 가격 역행 패턴 (Short 기준: 가격 상승 = 역행)")
    print("=" * 80)

    win_patterns = []
    loss_patterns = []

    for i, t in enumerate(trades):
        time.sleep(0.12)
        # 진입 시점부터 10분봉 가져오기
        klines = fetch_klines(t["symbol"], "1", t["entry_ts"], 10)
        if len(klines) < 3:
            continue

        entry_price = t["entry_price"]
        pattern = {"trade": t, "candles": []}

        for j, k in enumerate(klines[:5]):  # 5분까지
            # Short 기준: 가격 상승 = 역행 (나쁜것)
            max_adverse = ((k["high"] - entry_price) / entry_price) * 100  # 최대 역행 (상승)
            max_favor = ((entry_price - k["low"]) / entry_price) * 100    # 최대 유리 (하락)
            close_move = ((k["close"] - entry_price) / entry_price) * 100  # 종가 변화

            pattern["candles"].append({
                "min": j + 1,
                "max_adverse": max_adverse,  # + = 역행(상승)
                "max_favor": max_favor,      # + = 유리(하락)
                "close_move": close_move,    # + = 역행, - = 유리
            })

        if t["result"] == "WIN":
            win_patterns.append(pattern)
        else:
            loss_patterns.append(pattern)

        if (i + 1) % 50 == 0:
            print(f"  ... {i+1}/{len(trades)} 처리중")

    print(f"\n분석 완료: WIN {len(win_patterns)}건, LOSS {len(loss_patterns)}건")

    # ===================================================
    # 분단위 평균 비교
    # ===================================================
    print("\n" + "=" * 80)
    print("  분단위 평균 역행/유리 비교 (Short 기준)")
    print("  역행 = 가격 상승(나쁨), 유리 = 가격 하락(좋음)")
    print("=" * 80)

    for minute in range(5):
        win_adverse = [p["candles"][minute]["max_adverse"] for p in win_patterns if len(p["candles"]) > minute]
        win_favor = [p["candles"][minute]["max_favor"] for p in win_patterns if len(p["candles"]) > minute]
        win_close = [p["candles"][minute]["close_move"] for p in win_patterns if len(p["candles"]) > minute]
        loss_adverse = [p["candles"][minute]["max_adverse"] for p in loss_patterns if len(p["candles"]) > minute]
        loss_favor = [p["candles"][minute]["max_favor"] for p in loss_patterns if len(p["candles"]) > minute]
        loss_close = [p["candles"][minute]["close_move"] for p in loss_patterns if len(p["candles"]) > minute]

        if not win_adverse or not loss_adverse:
            continue

        print(f"\n  {minute+1}분 시점:")
        print(f"    WIN  ({len(win_adverse):3d}건): 역행 +{sum(win_adverse)/len(win_adverse):.3f}% | 유리 -{sum(win_favor)/len(win_favor):.3f}% | 종가 {sum(win_close)/len(win_close):+.3f}%")
        print(f"    LOSS ({len(loss_adverse):3d}건): 역행 +{sum(loss_adverse)/len(loss_adverse):.3f}% | 유리 -{sum(loss_favor)/len(loss_favor):.3f}% | 종가 {sum(loss_close)/len(loss_close):+.3f}%")
        diff = sum(loss_adverse)/len(loss_adverse) - sum(win_adverse)/len(win_adverse)
        print(f"    차이: LOSS가 +{diff:.3f}% 더 역행")

    # ===================================================
    # 역행 임계값별 분석 — 어디서 자르면 가장 효과적?
    # ===================================================
    print("\n" + "=" * 80)
    print("  역행 임계값 시뮬레이션 — N분 내 X% 역행 시 손절하면?")
    print("=" * 80)

    for check_min in [1, 2, 3]:
        print(f"\n  --- {check_min}분 내 역행 체크 ---")

        for threshold in [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]:
            # 각 거래가 check_min분 내에 threshold% 이상 역행했는지
            win_triggered = 0
            loss_triggered = 0
            loss_saved_pnl = 0  # 조기 탈출로 절약한 손실
            win_killed_pnl = 0  # 조기 탈출로 잃은 수익

            for p in win_patterns:
                if len(p["candles"]) < check_min:
                    continue
                max_adv = max(c["max_adverse"] for c in p["candles"][:check_min])
                if max_adv >= threshold:
                    win_triggered += 1
                    win_killed_pnl += p["trade"]["pnl"]  # 이 수익을 놓침

            for p in loss_patterns:
                if len(p["candles"]) < check_min:
                    continue
                max_adv = max(c["max_adverse"] for c in p["candles"][:check_min])
                if max_adv >= threshold:
                    loss_triggered += 1
                    # 조기 탈출 시 원래 손실(큼) 대신 threshold% 정도의 손실만
                    original_loss = abs(p["trade"]["pnl"])
                    # 역행 threshold%에서 탈출 → 손실 = qty * entry * threshold/100
                    # 간이 계산: 원래 손실 대비 절약
                    estimated_early_loss = original_loss * (threshold / 2)  # 대충 절반 정도에서 탈출
                    loss_saved_pnl += (original_loss - estimated_early_loss)

            total_win = len(win_patterns)
            total_loss = len(loss_patterns)

            # 효과 계산
            loss_catch_rate = loss_triggered / total_loss * 100 if total_loss > 0 else 0
            win_false_alarm = win_triggered / total_win * 100 if total_win > 0 else 0
            net_benefit = loss_saved_pnl - win_killed_pnl

            tag = "***" if loss_catch_rate > 50 and win_false_alarm < 30 else ""
            print(f"    {threshold:.2f}%: LOSS {loss_triggered:3d}/{total_loss}({loss_catch_rate:4.0f}%) 감지 | "
                  f"WIN {win_triggered:3d}/{total_win}({win_false_alarm:4.0f}%) 오탐 | "
                  f"절약 ${loss_saved_pnl:.2f} - 손실 ${win_killed_pnl:.2f} = ${net_benefit:+.2f} {tag}")

    # ===================================================
    # 2분 연속 역행 패턴
    # ===================================================
    print("\n" + "=" * 80)
    print("  연속 역행 패턴 — 1분봉 2개 연속 역행이면?")
    print("=" * 80)

    for threshold in [0.05, 0.1, 0.15, 0.2]:
        win_consec = 0
        loss_consec = 0

        for p in win_patterns:
            if len(p["candles"]) >= 2:
                c1 = p["candles"][0]["close_move"]
                c2 = p["candles"][1]["close_move"]
                if c1 > threshold and c2 > threshold:  # 2봉 연속 역행
                    win_consec += 1

        for p in loss_patterns:
            if len(p["candles"]) >= 2:
                c1 = p["candles"][0]["close_move"]
                c2 = p["candles"][1]["close_move"]
                if c1 > threshold and c2 > threshold:
                    loss_consec += 1

        total_w = len([p for p in win_patterns if len(p["candles"]) >= 2])
        total_l = len([p for p in loss_patterns if len(p["candles"]) >= 2])

        print(f"  +{threshold:.2f}% x 2봉 연속: LOSS {loss_consec}/{total_l}({loss_consec/total_l*100:.0f}%) | "
              f"WIN {win_consec}/{total_w}({win_consec/total_w*100:.0f}%)")

    # ===================================================
    # 1분봉 종가 방향으로 판단
    # ===================================================
    print("\n" + "=" * 80)
    print("  1분봉 종가 방향 — 첫 1분봉이 양봉이면 즉시 탈출?")
    print("=" * 80)

    # 첫 1분봉 종가 > 시가 (양봉 = Short에 불리)
    win_bullish_1 = sum(1 for p in win_patterns if len(p["candles"]) >= 1 and p["candles"][0]["close_move"] > 0)
    loss_bullish_1 = sum(1 for p in loss_patterns if len(p["candles"]) >= 1 and p["candles"][0]["close_move"] > 0)
    total_w1 = len([p for p in win_patterns if len(p["candles"]) >= 1])
    total_l1 = len([p for p in loss_patterns if len(p["candles"]) >= 1])

    print(f"  첫 1분봉 양봉(역행): LOSS {loss_bullish_1}/{total_l1}({loss_bullish_1/total_l1*100:.0f}%) | "
          f"WIN {win_bullish_1}/{total_w1}({win_bullish_1/total_w1*100:.0f}%)")

    win_bullish_2 = sum(1 for p in win_patterns if len(p["candles"]) >= 2 and
                        p["candles"][0]["close_move"] > 0 and p["candles"][1]["close_move"] > 0)
    loss_bullish_2 = sum(1 for p in loss_patterns if len(p["candles"]) >= 2 and
                         p["candles"][0]["close_move"] > 0 and p["candles"][1]["close_move"] > 0)

    print(f"  첫 2분봉 모두 양봉:  LOSS {loss_bullish_2}/{total_l1}({loss_bullish_2/total_l1*100:.0f}%) | "
          f"WIN {win_bullish_2}/{total_w1}({win_bullish_2/total_w1*100:.0f}%)")

    # ===================================================
    # 최적 전략 요약
    # ===================================================
    print("\n" + "=" * 80)
    print("  최적 Early Exit 전략 추천")
    print("=" * 80)

    # 가장 좋은 임계값 찾기 (loss catch rate - win false alarm 최대화)
    best_score = -999
    best_config = None

    for check_min in [1, 2, 3]:
        for threshold in [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]:
            loss_t = sum(1 for p in loss_patterns if len(p["candles"]) >= check_min and
                        max(c["max_adverse"] for c in p["candles"][:check_min]) >= threshold)
            win_t = sum(1 for p in win_patterns if len(p["candles"]) >= check_min and
                       max(c["max_adverse"] for c in p["candles"][:check_min]) >= threshold)
            total_l = len([p for p in loss_patterns if len(p["candles"]) >= check_min])
            total_w = len([p for p in win_patterns if len(p["candles"]) >= check_min])

            if total_l == 0 or total_w == 0: continue

            catch = loss_t / total_l * 100
            false_alarm = win_t / total_w * 100
            # 점수: LOSS 감지율 - 2 * WIN 오탐율 (오탐 페널티 2배)
            score = catch - 2 * false_alarm

            if score > best_score:
                best_score = score
                best_config = {
                    "check_min": check_min, "threshold": threshold,
                    "catch": catch, "false_alarm": false_alarm,
                    "loss_caught": loss_t, "win_killed": win_t,
                    "total_loss": total_l, "total_win": total_w,
                }

    if best_config:
        c = best_config
        print(f"\n  추천: {c['check_min']}분 내 +{c['threshold']:.2f}% 역행 시 탈출")
        print(f"    LOSS 감지: {c['loss_caught']}/{c['total_loss']} ({c['catch']:.0f}%)")
        print(f"    WIN 오탐:  {c['win_killed']}/{c['total_win']} ({c['false_alarm']:.0f}%)")
        print(f"    Score: {best_score:.1f}")

    print("\n분석 완료!")

if __name__ == "__main__":
    main()
