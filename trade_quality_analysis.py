"""
거래 퀄리티 분석 — 왜 지루한가?
1. 진입 후 변동성이 진짜 적은가?
2. 큰 움직임이 진입 '전'에 다 끝난건 아닌가?
3. 지루한 거래 vs 역동적 거래의 차이는?
"""

import hmac, hashlib, time, json, requests
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
    print("  거래 퀄리티 분석 — 왜 지루한가?")
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
    print(f"\nShort 거래: {len(shorts)}건 (W:{sum(1 for t in shorts if t['result']=='WIN')} L:{sum(1 for t in shorts if t['result']=='LOSS')})")

    # ===================================================
    # 1. 진입 전후 변동성 비교 — 움직임이 '전'에 끝난건 아닌가?
    # ===================================================
    print("\n" + "=" * 80)
    print("  1. 진입 전 vs 후 변동성 비교")
    print("     움직임이 진입 전에 다 끝났는가?")
    print("=" * 80)

    before_vols = []
    after_vols = []
    exhausted_entries = 0  # 전 > 후 (탈진 진입)
    fresh_entries = 0      # 후 > 전 (신선한 진입)

    for i, t in enumerate(shorts[:100]):  # 최근 100건
        symbol = t["symbol"]
        entry_ts = t["entry_ts"]
        entry_price = t["entry_price"]

        time.sleep(0.12)

        # 진입 30분 전 kline (5분봉 6개)
        before_start = entry_ts - 30 * 60 * 1000
        before_klines = fetch_klines(symbol, "5", before_start, 6)

        # 진입 30분 후 kline (5분봉 6개)
        after_klines = fetch_klines(symbol, "5", entry_ts, 6)

        if len(before_klines) < 3 or len(after_klines) < 3:
            continue

        # 변동성 = (high - low) / open * 100 평균
        before_vol = sum((k["high"] - k["low"]) / k["open"] * 100 for k in before_klines) / len(before_klines)
        after_vol = sum((k["high"] - k["low"]) / k["open"] * 100 for k in after_klines) / len(after_klines)

        # 진입 전 30분간 가격 방향
        before_move = ((before_klines[-1]["close"] - before_klines[0]["open"]) / before_klines[0]["open"]) * 100
        # 진입 후 30분간 가격 방향 (Short 기준)
        after_move = ((entry_price - after_klines[-1]["close"]) / entry_price) * 100  # Short유리 = +

        before_vols.append(before_vol)
        after_vols.append(after_vol)

        if before_vol > after_vol * 1.5:
            exhausted_entries += 1
        elif after_vol > before_vol * 1.5:
            fresh_entries += 1

        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/100 처리중")

    total_analyzed = len(before_vols)
    if total_analyzed > 0:
        avg_before = sum(before_vols) / total_analyzed
        avg_after = sum(after_vols) / total_analyzed
        ratio = avg_after / avg_before if avg_before > 0 else 0

        print(f"\n  분석: {total_analyzed}건")
        print(f"  진입 전 30분 평균 변동성: {avg_before:.3f}%")
        print(f"  진입 후 30분 평균 변동성: {avg_after:.3f}%")
        print(f"  비율 (후/전): {ratio:.2f}x")
        print(f"  탈진 진입 (전 > 후x1.5): {exhausted_entries}건 ({exhausted_entries/total_analyzed*100:.0f}%)")
        print(f"  신선한 진입 (후 > 전x1.5): {fresh_entries}건 ({fresh_entries/total_analyzed*100:.0f}%)")

        if ratio < 0.7:
            print(f"\n  *** 진입 후 변동성이 30%+ 감소 — 움직임이 끝난 후 진입하고 있음! ***")
        elif ratio > 1.2:
            print(f"\n  진입 후 변동성이 더 큼 — 타이밍은 나쁘지 않음")
        else:
            print(f"\n  진입 전후 변동성 비슷 — 타이밍은 중립")

    # ===================================================
    # 2. 진입 시점의 "레인지 위치" — 고점/저점 근처인가 중간인가?
    # ===================================================
    print("\n" + "=" * 80)
    print("  2. 진입 시점의 레인지 위치")
    print("     고점 근처 Short 진입? 중간에서 진입? (1시간 레인지 기준)")
    print("=" * 80)

    range_positions = {"top": [], "mid": [], "bottom": []}

    for i, t in enumerate(shorts[:100]):
        symbol = t["symbol"]
        entry_ts = t["entry_ts"]
        entry_price = t["entry_price"]

        # 진입 시점 1시간 전 kline (1분봉 60개)
        hr_start = entry_ts - 60 * 60 * 1000
        hr_klines = fetch_klines(symbol, "1", hr_start, 60)
        time.sleep(0.08)

        if len(hr_klines) < 30:
            continue

        hr_high = max(k["high"] for k in hr_klines)
        hr_low = min(k["low"] for k in hr_klines)
        hr_range = hr_high - hr_low

        if hr_range == 0:
            continue

        # 진입가의 레인지 위치 (0% = 저점, 100% = 고점)
        range_pos = ((entry_price - hr_low) / hr_range) * 100

        if range_pos >= 70:
            zone = "top"
        elif range_pos <= 30:
            zone = "bottom"
        else:
            zone = "mid"

        range_positions[zone].append({**t, "range_pos": range_pos, "hr_range_pct": hr_range / entry_price * 100})

    for zone, items in [("top (70-100%)", range_positions["top"]),
                        ("mid (30-70%)", range_positions["mid"]),
                        ("bottom (0-30%)", range_positions["bottom"])]:
        if items:
            wins = sum(1 for i in items if i["result"] == "WIN")
            avg_pnl = sum(i["pnl"] for i in items)
            avg_range = sum(i["hr_range_pct"] for i in items) / len(items)
            print(f"  {zone:20s}: {len(items):3d}건 | WR {wins/len(items)*100:.0f}% | PnL ${avg_pnl:.2f} | 1h 레인지 {avg_range:.2f}%")

    print(f"\n  Short는 고점(top) 근처에서 진입할수록 유리")
    print(f"  중간(mid)에서 진입 = 방향성 없는 구간 = 지루한 거래")

    # ===================================================
    # 3. 코인별 실적 — 어떤 코인이 역동적이고 어떤 코인이 지루한가?
    # ===================================================
    print("\n" + "=" * 80)
    print("  3. 코인별 실적 — 역동적 vs 지루한 코인")
    print("=" * 80)

    coin_stats = defaultdict(lambda: {"count": 0, "wins": 0, "pnl": 0, "avg_holding": [], "avg_vol": []})

    for t in shorts:
        s = coin_stats[t["symbol"]]
        s["count"] += 1
        if t["result"] == "WIN": s["wins"] += 1
        s["pnl"] += t["pnl"]
        s["avg_holding"].append(t["holding_sec"])

    # 빈도 상위 코인만 (3건 이상)
    top_coins = [(sym, s) for sym, s in coin_stats.items() if s["count"] >= 3]
    top_coins.sort(key=lambda x: x[1]["pnl"])

    print(f"\n  {'코인':15s} {'건수':>5s} {'승률':>6s} {'PnL':>8s} {'평균홀딩':>8s}")
    print("  " + "-" * 50)

    for sym, s in top_coins:
        wr = s["wins"] / s["count"] * 100
        avg_hold = sum(s["avg_holding"]) / len(s["avg_holding"]) / 60
        tag = "BAD" if s["pnl"] < -1 else "OK" if s["pnl"] < 0.5 else "GOOD"
        print(f"  {sym:15s} {s['count']:5d} {wr:5.0f}% ${s['pnl']:7.2f} {avg_hold:6.1f}m  {tag}")

    # ===================================================
    # 4. 홀딩 시간 분포 — 너무 짧은 거래가 많은가?
    # ===================================================
    print("\n" + "=" * 80)
    print("  4. 홀딩 시간 분포")
    print("=" * 80)

    buckets = [
        ("< 30초", 0, 30),
        ("30초-1분", 30, 60),
        ("1-3분", 60, 180),
        ("3-10분", 180, 600),
        ("10-30분", 600, 1800),
        ("30분-1시간", 1800, 3600),
        ("1시간+", 3600, 999999),
    ]

    for label, lo, hi in buckets:
        items = [t for t in shorts if lo <= t["holding_sec"] < hi]
        if items:
            wins = sum(1 for t in items if t["result"] == "WIN")
            pnl = sum(t["pnl"] for t in items)
            print(f"  {label:15s}: {len(items):4d}건 | WR {wins/len(items)*100:4.0f}% | PnL ${pnl:+8.2f}")

    # ===================================================
    # 5. 최대 유리 이동 — 수익 기회는 있었는데 못 잡은건가?
    # ===================================================
    print("\n" + "=" * 80)
    print("  5. 진입 후 최대 유리 이동 (MFE) — 기회는 있었나?")
    print("=" * 80)

    mfe_data = []

    for i, t in enumerate(shorts[:80]):
        entry_ts = t["entry_ts"]
        entry_price = t["entry_price"]

        time.sleep(0.1)
        klines = fetch_klines(t["symbol"], "1", entry_ts, 30)
        if len(klines) < 5: continue

        # Short MFE = 최대 하락 (유리)
        max_drop = max((entry_price - k["low"]) / entry_price * 100 for k in klines)
        # Short MAE = 최대 상승 (불리)
        max_rise = max((k["high"] - entry_price) / entry_price * 100 for k in klines)

        mfe_data.append({
            **t,
            "mfe": max_drop,
            "mae": max_rise,
            "mfe_vs_mae": max_drop - max_rise,
        })

        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/80 처리중")

    if mfe_data:
        wins_mfe = [d for d in mfe_data if d["result"] == "WIN"]
        loss_mfe = [d for d in mfe_data if d["result"] == "LOSS"]

        print(f"\n  WIN 거래 ({len(wins_mfe)}건):")
        if wins_mfe:
            avg_mfe_w = sum(d["mfe"] for d in wins_mfe) / len(wins_mfe)
            avg_mae_w = sum(d["mae"] for d in wins_mfe) / len(wins_mfe)
            print(f"    평균 MFE(최대유리): -{avg_mfe_w:.2f}%")
            print(f"    평균 MAE(최대불리): +{avg_mae_w:.2f}%")

        print(f"\n  LOSS 거래 ({len(loss_mfe)}건):")
        if loss_mfe:
            avg_mfe_l = sum(d["mfe"] for d in loss_mfe) / len(loss_mfe)
            avg_mae_l = sum(d["mae"] for d in loss_mfe) / len(loss_mfe)
            had_chance = sum(1 for d in loss_mfe if d["mfe"] >= 0.3)
            print(f"    평균 MFE(최대유리): -{avg_mfe_l:.2f}%")
            print(f"    평균 MAE(최대불리): +{avg_mae_l:.2f}%")
            print(f"    0.3% 이상 유리했던 적 있음: {had_chance}/{len(loss_mfe)} ({had_chance/len(loss_mfe)*100:.0f}%)")

        # MFE 분포
        print(f"\n  MFE 분포 (30분 내 최대 유리 이동):")
        for label, lo, hi in [
            ("< 0.1%", 0, 0.1),
            ("0.1-0.3%", 0.1, 0.3),
            ("0.3-0.5%", 0.3, 0.5),
            ("0.5-1.0%", 0.5, 1.0),
            ("1.0-2.0%", 1.0, 2.0),
            ("2.0%+", 2.0, 100),
        ]:
            items = [d for d in mfe_data if lo <= d["mfe"] < hi]
            if items:
                wins = sum(1 for d in items if d["result"] == "WIN")
                total_pnl = sum(d["pnl"] for d in items)
                print(f"    {label:10s}: {len(items):3d}건 | WR {wins/len(items)*100:4.0f}% | PnL ${total_pnl:+7.2f}")

    # ===================================================
    # 6. "지루한 거래" vs "역동적 거래" 비교
    # ===================================================
    print("\n" + "=" * 80)
    print("  6. 지루한 거래 vs 역동적 거래")
    print("     MFE < 0.2% = 지루, MFE > 0.5% = 역동적")
    print("=" * 80)

    if mfe_data:
        boring = [d for d in mfe_data if d["mfe"] < 0.2]
        dynamic = [d for d in mfe_data if d["mfe"] >= 0.5]

        if boring:
            b_wr = sum(1 for d in boring if d["result"] == "WIN") / len(boring) * 100
            b_pnl = sum(d["pnl"] for d in boring)
            b_hold = sum(d["holding_sec"] for d in boring) / len(boring) / 60
            print(f"\n  지루한 거래 (MFE<0.2%): {len(boring)}건")
            print(f"    WR: {b_wr:.0f}% | PnL: ${b_pnl:.2f} | 평균홀딩: {b_hold:.1f}분")
            # 지루한 거래의 코인 분포
            boring_coins = defaultdict(int)
            for d in boring:
                boring_coins[d["symbol"]] += 1
            top_boring = sorted(boring_coins.items(), key=lambda x: -x[1])[:5]
            print(f"    주요 코인: {', '.join(f'{c}({n})' for c, n in top_boring)}")

        if dynamic:
            d_wr = sum(1 for d in dynamic if d["result"] == "WIN") / len(dynamic) * 100
            d_pnl = sum(d["pnl"] for d in dynamic)
            d_hold = sum(d["holding_sec"] for d in dynamic) / len(dynamic) / 60
            print(f"\n  역동적 거래 (MFE>=0.5%): {len(dynamic)}건")
            print(f"    WR: {d_wr:.0f}% | PnL: ${d_pnl:.2f} | 평균홀딩: {d_hold:.1f}분")
            dynamic_coins = defaultdict(int)
            for d in dynamic:
                dynamic_coins[d["symbol"]] += 1
            top_dynamic = sorted(dynamic_coins.items(), key=lambda x: -x[1])[:5]
            print(f"    주요 코인: {', '.join(f'{c}({n})' for c, n in top_dynamic)}")

    print("\n" + "=" * 80)
    print("  분석 완료")
    print("=" * 80)

if __name__ == "__main__":
    main()
