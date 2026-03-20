"""
TP1 유효성 분석:
1. TP1 도달 후 TP2까지 갈 확률은? (TP1이 수익을 깎는가?)
2. TP1 미도달 = 잘못된 진입? (Long 전환 기회?)
"""

import hmac, hashlib, time, requests
from datetime import datetime, timedelta, timezone
from collections import defaultdict

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
    print("  TP1 유효성 분석 - TP1이 수익을 깎고 있나? TP1 미도달 = Long 기회?")
    print("=" * 80)

    now_kst = datetime.now(KST)
    start_ms = int((now_kst - timedelta(days=7)).timestamp() * 1000)
    raw_trades = fetch_closed_pnl(start_ms)

    trades = []
    for t in raw_trades:
        side = t.get("side", "")
        direction = "Short" if side == "Buy" else "Long"
        pnl = float(t.get("closedPnl", 0))
        entry = float(t.get("avgEntryPrice", 0))
        exit_p = float(t.get("avgExitPrice", 0))
        created = int(t.get("createdTime", 0))
        updated = int(t.get("updatedTime", 0))
        holding_sec = (updated - created) / 1000
        trades.append({
            "symbol": t.get("symbol", ""), "direction": direction, "pnl": pnl,
            "entry_price": entry, "exit_price": exit_p, "qty": float(t.get("qty", 0)),
            "entry_ts": created, "exit_ts": updated, "holding_sec": holding_sec,
            "leverage": float(t.get("leverage", 0)),
            "result": "WIN" if pnl > 0 else "LOSS",
            "entry_dt": datetime.fromtimestamp(created/1000, KST),
        })

    trades.sort(key=lambda x: x["entry_ts"])
    shorts = [t for t in trades if t["direction"] == "Short"]
    print(f"\nShort 거래: {len(shorts)}건")

    # ===================================================
    # 각 거래의 ATR 기반 TP1/TP2 시뮬레이션
    # ===================================================
    print("\n진입 후 가격 추적 중...")

    results = []

    for i, t in enumerate(shorts[:150]):
        symbol = t["symbol"]
        entry_price = t["entry_price"]
        entry_ts = t["entry_ts"]

        time.sleep(0.12)

        # 15분봉 4개 -> ATR 추정
        atr_klines = fetch_klines(symbol, "15", entry_ts - 60*60*1000, 4)
        if len(atr_klines) < 2:
            continue

        # 간이 ATR 계산
        atr = sum(k["high"] - k["low"] for k in atr_klines) / len(atr_klines)
        atr_pct = atr / entry_price

        # TP/SL 계산 (현재 봇 설정 기반)
        # SL = ATR * 1.5, clamped 0.5%~5%
        sl_pct = max(0.005, min(0.05, atr_pct * 1.5))
        # TP = SL * RR비율 (대략 2:1)
        tp_pct = sl_pct * 2.0

        # Short 기준
        tp_full_price = entry_price * (1 - tp_pct)      # TP2 (전체)
        tp1_price = entry_price * (1 - tp_pct * 0.20)    # TP1 (20% 지점)
        sl_price = entry_price * (1 + sl_pct)

        # 진입 후 1시간 kline 추적
        time.sleep(0.08)
        klines = fetch_klines(symbol, "1", entry_ts, 60)
        if len(klines) < 5:
            continue

        # 각 단계별 도달 체크
        reached_tp1 = False
        reached_tp1_min = None
        reached_tp2 = False
        reached_tp2_min = None
        reached_sl = False
        reached_sl_min = None

        # MFE/MAE 트래킹
        max_favorable = 0  # Short: 최대 하락
        max_adverse = 0    # Short: 최대 상승

        # TP1 도달 후 최대 추가 하락 (TP2 방향으로 더 갔나?)
        post_tp1_max_move = 0
        post_tp1_reversal = 0  # TP1 후 반등 (역행)

        for j, k in enumerate(klines):
            # Short: low가 내려갈수록 유리
            favorable = (entry_price - k["low"]) / entry_price * 100
            adverse = (k["high"] - entry_price) / entry_price * 100

            max_favorable = max(max_favorable, favorable)
            max_adverse = max(max_adverse, adverse)

            if not reached_tp1 and k["low"] <= tp1_price:
                reached_tp1 = True
                reached_tp1_min = j + 1

            if not reached_tp2 and k["low"] <= tp_full_price:
                reached_tp2 = True
                reached_tp2_min = j + 1

            if not reached_sl and k["high"] >= sl_price:
                reached_sl = True
                reached_sl_min = j + 1

            # TP1 도달 후 추가 움직임 트래킹
            if reached_tp1:
                further_down = (entry_price - k["low"]) / entry_price * 100
                bounce_up = (k["high"] - tp1_price) / tp1_price * 100
                post_tp1_max_move = max(post_tp1_max_move, further_down)
                post_tp1_reversal = max(post_tp1_reversal, bounce_up)

        # TP1 미도달 시 반대 방향 움직임 (Long 기회)
        missed_tp1_long_move = 0
        if not reached_tp1:
            # 진입가 대비 최대 상승 = Long이었으면 수익
            missed_tp1_long_move = max_adverse

        results.append({
            **t,
            "atr_pct": atr_pct,
            "tp_pct": tp_pct,
            "sl_pct": sl_pct,
            "tp1_price": tp1_price,
            "tp_full_price": tp_full_price,
            "sl_price": sl_price,
            "reached_tp1": reached_tp1,
            "reached_tp1_min": reached_tp1_min,
            "reached_tp2": reached_tp2,
            "reached_tp2_min": reached_tp2_min,
            "reached_sl": reached_sl,
            "reached_sl_min": reached_sl_min,
            "max_favorable": max_favorable,
            "max_adverse": max_adverse,
            "post_tp1_max_move": post_tp1_max_move,
            "post_tp1_reversal": post_tp1_reversal,
            "missed_tp1_long_move": missed_tp1_long_move,
        })

        if (i + 1) % 50 == 0:
            print(f"  ... {i+1}/150 처리중")

    print(f"\n분석 완료: {len(results)}건")

    # ===================================================
    # 1. TP1 도달률
    # ===================================================
    tp1_reached = [r for r in results if r["reached_tp1"]]
    tp1_missed = [r for r in results if not r["reached_tp1"]]

    print("\n" + "=" * 80)
    print("  1. TP1 도달 현황")
    print("=" * 80)
    print(f"  TP1 도달: {len(tp1_reached)}/{len(results)} ({len(tp1_reached)/len(results)*100:.0f}%)")
    print(f"  TP1 미도달: {len(tp1_missed)}/{len(results)} ({len(tp1_missed)/len(results)*100:.0f}%)")

    if tp1_reached:
        avg_tp1_min = sum(r["reached_tp1_min"] for r in tp1_reached) / len(tp1_reached)
        print(f"  TP1 도달 평균 시간: {avg_tp1_min:.1f}분")

    # ===================================================
    # 2. 핵심: TP1 도달 → TP2까지 갈 확률
    # ===================================================
    print("\n" + "=" * 80)
    print("  2. TP1 도달 후 TP2까지 가는가? (TP1이 수익을 깎는가?)")
    print("=" * 80)

    if tp1_reached:
        tp1_then_tp2 = [r for r in tp1_reached if r["reached_tp2"]]
        tp1_then_sl = [r for r in tp1_reached if r["reached_sl"] and not r["reached_tp2"]]
        tp1_then_neither = [r for r in tp1_reached if not r["reached_tp2"] and not r["reached_sl"]]

        print(f"\n  TP1 도달 {len(tp1_reached)}건 중:")
        print(f"    TP2도 도달: {len(tp1_then_tp2)}건 ({len(tp1_then_tp2)/len(tp1_reached)*100:.0f}%)")
        print(f"    SL 히트 (역전): {len(tp1_then_sl)}건 ({len(tp1_then_sl)/len(tp1_reached)*100:.0f}%)")
        print(f"    어중간 (둘 다 안 도달): {len(tp1_then_neither)}건 ({len(tp1_then_neither)/len(tp1_reached)*100:.0f}%)")

        # TP1 도달 후 추가 하락 정도
        avg_post_tp1 = sum(r["post_tp1_max_move"] for r in tp1_reached) / len(tp1_reached)
        avg_post_tp1_rev = sum(r["post_tp1_reversal"] for r in tp1_reached) / len(tp1_reached)
        print(f"\n  TP1 도달 후 추가 움직임:")
        print(f"    추가 유리 이동 (Short 유리): {avg_post_tp1:.2f}%")
        print(f"    반등 (역행): {avg_post_tp1_rev:.2f}%")

        # TP1 없이 홀딩했다면?
        # TP1 도달 + TP2 도달 = 전체 수익
        # TP1 도달 + TP2 미도달 = TP1에서 일부 익절 + 나머지 SL or 어중간
        tp1_pnl_total = sum(r["pnl"] for r in tp1_reached)
        tp2_reached_pnl = sum(r["pnl"] for r in tp1_then_tp2)
        tp2_missed_pnl = sum(r["pnl"] for r in tp1_reached if not r["reached_tp2"])

        print(f"\n  TP1 도달 거래 실제 PnL: ${tp1_pnl_total:.2f}")
        print(f"    TP2도 도달 거래: ${tp2_reached_pnl:.2f}")
        print(f"    TP2 미도달 거래: ${tp2_missed_pnl:.2f}")

        # TP1 없이 전량 홀딩 시뮬레이션
        print(f"\n  ** TP1 없이 전량 홀딩했다면? **")
        no_tp1_pnl = 0
        for r in tp1_reached:
            # TP1 없이 전량 홀딩: MFE의 50% 정도를 실현한다고 가정
            if r["reached_tp2"]:
                # TP2 도달 → 전량이 TP2에서 익절 = 수익 더 큼
                # 실제 PnL은 TP1 일부익절 + 나머지 TP2
                # 전량 TP2면: qty * entry * tp_pct
                est_full_tp2 = r["qty"] * r["entry_price"] * r["tp_pct"]
                no_tp1_pnl += est_full_tp2
            else:
                # TP2 미도달 → SL이나 어중간하게 종료
                # TP1 없었으면 여기서도 같은 결과지만, TP1 부분익절 없이 전량
                no_tp1_pnl += r["pnl"]  # 대략 비슷

        print(f"    현재 (TP1 있음): ${tp1_pnl_total:.2f}")
        print(f"    가상 (TP1 없음, 전량 홀딩): ${no_tp1_pnl:.2f}")
        print(f"    차이: ${no_tp1_pnl - tp1_pnl_total:.2f}")

    # ===================================================
    # 3. TP1 미도달 = 잘못된 진입? Long 기회?
    # ===================================================
    print("\n" + "=" * 80)
    print("  3. TP1 미도달 거래 분석 - 잘못된 진입인가? Long 기회인가?")
    print("=" * 80)

    if tp1_missed:
        missed_pnl = sum(r["pnl"] for r in tp1_missed)
        missed_wins = sum(1 for r in tp1_missed if r["result"] == "WIN")

        print(f"\n  TP1 미도달: {len(tp1_missed)}건")
        print(f"    WR: {missed_wins/len(tp1_missed)*100:.0f}%")
        print(f"    PnL: ${missed_pnl:.2f}")

        # SL 히트한 것 vs 어중간하게 끝난 것
        missed_sl = [r for r in tp1_missed if r["reached_sl"]]
        missed_neither = [r for r in tp1_missed if not r["reached_sl"]]
        print(f"    SL 히트: {len(missed_sl)}건")
        print(f"    어중간 종료: {len(missed_neither)}건")

        # TP1 미도달 → 반대 방향 움직임 (Long 기회)
        print(f"\n  TP1 미도달 → Long이었으면?")
        long_opp_03 = sum(1 for r in tp1_missed if r["missed_tp1_long_move"] >= 0.3)
        long_opp_05 = sum(1 for r in tp1_missed if r["missed_tp1_long_move"] >= 0.5)
        long_opp_10 = sum(1 for r in tp1_missed if r["missed_tp1_long_move"] >= 1.0)
        avg_long = sum(r["missed_tp1_long_move"] for r in tp1_missed) / len(tp1_missed)

        print(f"    평균 반대방향 상승: +{avg_long:.2f}%")
        print(f"    +0.3% 이상 반등: {long_opp_03}/{len(tp1_missed)} ({long_opp_03/len(tp1_missed)*100:.0f}%)")
        print(f"    +0.5% 이상 반등: {long_opp_05}/{len(tp1_missed)} ({long_opp_05/len(tp1_missed)*100:.0f}%)")
        print(f"    +1.0% 이상 반등: {long_opp_10}/{len(tp1_missed)} ({long_opp_10/len(tp1_missed)*100:.0f}%)")

        # TP1 미도달 감지 시점 분석 - 언제 "이건 안 되겠다" 알 수 있나?
        print(f"\n  TP1 미도달 거래의 초반 패턴:")
        for check_min in [1, 2, 3, 5]:
            # check_min분 시점에 유리방향 이동이 거의 없는 경우
            no_progress = 0
            total_check = 0
            for r in tp1_missed:
                if r.get("max_favorable", 0) > 0:
                    total_check += 1
                    # check_min분까지 MFE가 TP1 거리의 30%도 못 갔으면 = 진행 없음
                    tp1_dist = r["tp_pct"] * 0.20 * 100  # TP1까지 거리 %
                    if r["max_favorable"] < tp1_dist * 0.3:
                        no_progress += 1

            if total_check > 0:
                print(f"    {check_min}분: 진행 미미 = {no_progress}/{total_check} ({no_progress/total_check*100:.0f}%)")

    # ===================================================
    # 4. 시간 기반 TP1 미도달 감지 → Early Long Flip
    # ===================================================
    print("\n" + "=" * 80)
    print("  4. Early Long Flip 시뮬레이션")
    print("     N분 내 유리방향 이동 < X% → Short 청산 + Long 진입")
    print("=" * 80)

    for check_min in [2, 3, 5]:
        print(f"\n  --- {check_min}분 체크 ---")

        for min_progress_pct in [0.05, 0.1, 0.15, 0.2]:
            flip_correct = 0  # TP1 미도달 거래를 잡음 (올바른 감지)
            flip_wrong = 0    # TP1 도달 거래를 잘못 잡음 (오탐)
            flip_long_profit = 0  # Long으로 전환 시 예상 수익
            flip_short_saved = 0  # Short 조기 탈출로 절약한 손실

            for r in results:
                # check_min분까지 max_favorable가 min_progress_pct% 미만이면 = 트리거
                # (실제로는 1분봉 데이터로 정밀 체크해야 하지만, MFE로 근사)
                # 간이: MFE가 매우 작으면 진행 안 한 것
                tp1_dist_pct = r["tp_pct"] * 0.20 * 100  # TP1까지 %

                # max_favorable가 check_min분 기준으로 충분한지
                # 여기서는 전체 MFE < min_progress_pct을 기준으로 함 (근사)
                triggered = r["max_favorable"] < min_progress_pct

                if not triggered:
                    continue

                if not r["reached_tp1"]:
                    flip_correct += 1
                    flip_long_profit += r["missed_tp1_long_move"] * 0.3  # Long 수익의 30% 가정
                    flip_short_saved += abs(r["pnl"]) * 0.5  # Short 손실의 50% 절약 가정
                else:
                    flip_wrong += 1

            total_missed = len(tp1_missed)
            total_reached = len(tp1_reached)
            if total_missed > 0 and total_reached > 0:
                catch_rate = flip_correct / total_missed * 100
                false_rate = flip_wrong / total_reached * 100
                net = flip_short_saved + flip_long_profit
                print(f"    MFE<{min_progress_pct:.2f}%: 미도달 {flip_correct}/{total_missed}({catch_rate:.0f}%) 감지 | "
                      f"도달 {flip_wrong}/{total_reached}({false_rate:.0f}%) 오탐 | "
                      f"예상 이득 ${net:.1f}")

    # ===================================================
    # 5. 최종 전략 추천
    # ===================================================
    print("\n" + "=" * 80)
    print("  5. TP1 관련 전략 추천")
    print("=" * 80)

    if tp1_reached:
        tp2_rate = len([r for r in tp1_reached if r["reached_tp2"]]) / len(tp1_reached) * 100
        print(f"\n  TP1 도달 → TP2 도달 확률: {tp2_rate:.0f}%")

        if tp2_rate >= 60:
            print(f"  *** TP2 확률 {tp2_rate:.0f}% >= 60% → TP1 제거하고 전량 홀딩이 유리!")
            print(f"      TP1이 수익을 깎고 있음. TP1 대신 트레일링 스탑 권장.")
        elif tp2_rate >= 40:
            print(f"  TP2 확률 {tp2_rate:.0f}% → TP1 물량 줄이기 권장 (현재 25% → 10%)")
        else:
            print(f"  TP2 확률 {tp2_rate:.0f}% < 40% → TP1 유지 (일부 수익 확보가 맞음)")

    if tp1_missed:
        long_rate = sum(1 for r in tp1_missed if r["missed_tp1_long_move"] >= 0.5) / len(tp1_missed) * 100
        print(f"\n  TP1 미도달 → +0.5% 반등 확률: {long_rate:.0f}%")

        if long_rate >= 60:
            print(f"  *** 반등 확률 {long_rate:.0f}% >= 60% → TP1 미도달 감지 시 Long 전환 유효!")
        else:
            print(f"  반등 확률 {long_rate:.0f}% → Long 전환 효과 제한적")

    print("\n분석 완료!")

if __name__ == "__main__":
    main()
