"""
추격 진입 vs 비추격 진입 성과 비교
+ SL 여유폭 시뮬레이션
+ 타점 개선 방안 데이터 분석
"""

# 실제 Bybit API에서 가져온 43건 데이터 (수동 입력)
trades = [
    # (symbol, direction, entry_price, pnl, range_pos, momentum, mfe_1hr, mae_1hr, holding_min, result, is_chasing)
    ("HYPE", "Short", 28.419, -0.0429, 68.7, +0.959, 1.094, 0.662, 2.5, "LOSS", False),
    ("ICP", "Short", 2.404, +0.0409, 12.5, -1.877, 3.494, 0.250, 12.0, "WIN", True),
    ("ICP", "Short", 2.404, +0.1264, 12.5, -1.877, 3.494, 0.250, 40.4, "WIN", True),
    ("DOT", "Short", 1.5886, +0.0731, 24.0, -2.484, 3.538, 0.0, 7.7, "WIN", True),
    ("DOT", "Short", 1.5886, +0.2153, 24.0, -2.484, 3.538, 0.0, 104.5, "WIN", True),
    ("FOGO", "Short", 0.0299, -0.1337, 34.3, -0.600, 2.210, 1.172, 0.5, "LOSS", True),
    ("CLO", "Short", 0.0945, -0.2006, 98.7, +0.911, 5.474, 0.413, 6.6, "LOSS", False),
    ("LYN", "Short", 0.3319, -0.0794, 51.0, -1.708, 0.391, 1.791, 6.5, "LOSS", True),
    ("JELLY", "Short", 0.0628, -0.2491, 90.6, +1.259, 2.484, 0.462, 6.7, "LOSS", False),
    ("SOMI", "Short", 0.2239, -0.1698, 75.9, +1.460, 1.406, 1.516, 0.3, "LOSS", False),
    ("RPL", "Short", 2.0044, +0.1085, 81.4, +2.244, 4.369, 0.027, 5.0, "WIN", False),
    ("RPL", "Short", 2.0044, +0.3105, 81.4, +2.244, 4.369, 0.027, 25.3, "WIN", False),
    ("ELSA", "Short", 0.0878, -0.0297, 80.7, +1.435, 3.062, 0.216, 155.8, "LOSS", False),
    ("ELSA", "Short", 0.0878, +0.0636, 80.7, +1.435, 3.062, 0.216, 5.8, "WIN", False),
    ("BREV", "Short", 0.1393, -0.0683, 76.3, +0.542, 2.300, 0.600, 1.9, "LOSS", False),
    ("ARC", "Short", 0.0348, -0.0580, 81.7, +2.387, 2.734, 1.525, 34.3, "LOSS", False),
    ("ARC", "Short", 0.0348, +0.0985, 81.7, +2.387, 2.734, 1.525, 11.3, "WIN", False),
    ("PIVERSE", "Short", 0.5319, +0.1561, 33.1, -2.275, 3.422, 0.0, 8.4, "WIN", True),
    ("PIVERSE", "Short", 0.5319, +0.4869, 33.1, -2.275, 3.422, 0.0, 273.1, "WIN", True),
    ("FHE", "Short", 0.0282, -0.2563, 45.7, -0.810, 0.641, 0.886, 0.2, "LOSS", True),
    ("SXP", "Short", 0.0225, -0.1876, 50.0, -0.971, 1.377, 0.0, 2.0, "LOSS", True),
    ("GRASS", "Short", 0.2279, -0.4033, 72.6, +2.854, 2.695, 0.907, 3.0, "LOSS", False),
    ("AXS", "Short", 1.3296, -0.1643, 75.6, +0.705, 0.782, 0.233, 73.5, "LOSS", False),
    ("AXS", "Short", 1.3296, +0.3167, 75.6, +0.705, 0.782, 0.233, 29.3, "WIN", False),
    ("GPS", "Short", 0.00974, -0.4308, 66.0, +0.865, 1.171, 1.294, 0.6, "LOSS", False),
    ("DEXE", "Short", 3.3113, -0.4539, 58.7, +0.045, 0.061, 2.041, 1.0, "LOSS", False),
    ("SPACE", "Short", 0.00916, -0.1339, 56.2, +0.087, 2.228, 1.529, 0.7, "LOSS", False),
    ("GPS", "Short", 0.00975, +0.2931, 70.2, -0.277, 1.752, 0.094, 4.2, "WIN", False),
    ("SPORTFUN", "Short", 0.0455, -0.2651, 80.7, +0.929, 0.0, 1.570, 4.2, "LOSS", False),
    ("SENT", "Short", 0.0236, -0.1900, 65.8, +1.299, 0.0, 4.703, 2.7, "LOSS", False),
    ("MAVIA", "Short", 0.0362, -0.1140, 4.9, -0.083, 0.415, 3.761, 2.3, "LOSS", False),
    ("PTB", "Short", 0.00117, -0.4903, 87.6, +0.999, 2.227, 1.557, 3.9, "LOSS", False),
    ("VIRTUAL", "Short", 0.6679, -0.2096, 84.3, +1.458, 0.286, 0.702, 9.3, "LOSS", False),
    ("ESP", "Short", 0.1421, -0.2097, 86.0, +1.134, 0.865, 1.168, 7.0, "LOSS", False),
    ("FOGO2", "Short", 0.0301, +0.2534, 3.4, +0.364, 0.995, 1.593, 149.8, "WIN", True),
    ("ZBCN", "Short", 0.00207, +0.2065, 67.5, +0.154, 0.793, 0.272, 96.2, "WIN", False),
    ("ARC2", "Short", 0.0335, +0.1281, 23.9, -0.030, 4.302, 1.464, 38.5, "WIN", False),
    ("ARC2", "Short", 0.0335, +0.3598, 23.9, -0.030, 4.302, 1.464, 59.9, "WIN", False),
    ("FOGO3", "Short", 0.0301, -0.0386, 69.6, 0.0, 0.299, 0.531, 0.0, "LOSS", False),
    ("GPS3", "Short", 0.00975, +0.5349, 100.0, -0.192, 3.987, 0.0, 0.0, "WIN", False),
    ("ZBCN2", "Short", 0.00207, +0.1504, 100.0, +0.364, 0.552, 0.0, 0.0, "WIN", False),
    ("ELSA3", "Short", 0.0861, -0.1322, 1.1, -3.372, 0.0, 1.162, 0.0, "LOSS", True),
    ("CTC", "Short", 0.1658, +0.0725, 8.2, -1.016, 0.792, 0.0, 6.1, "WIN", True),
]

print("=" * 70)
print("  추격 진입 vs 비추격 진입 비교 분석")
print("=" * 70)

# 분류
chasing = [t for t in trades if t[10]]  # is_chasing = True
non_chasing = [t for t in trades if not t[10]]

def analyze_group(name, group):
    total = len(group)
    wins = sum(1 for t in group if t[9] == "WIN")
    losses = sum(1 for t in group if t[9] == "LOSS")
    wr = wins / total * 100 if total > 0 else 0
    total_pnl = sum(t[3] for t in group)
    avg_pnl = total_pnl / total if total > 0 else 0
    avg_mfe = sum(t[6] for t in group) / total if total > 0 else 0
    avg_mae = sum(t[7] for t in group) / total if total > 0 else 0
    avg_hold = sum(t[8] for t in group) / total if total > 0 else 0
    avg_range = sum(t[4] for t in group) / total if total > 0 else 0
    avg_mom = sum(t[5] for t in group) / total if total > 0 else 0

    print(f"\n  [{name}] {total}건")
    print(f"    승률: {wr:.1f}% ({wins}W / {losses}L)")
    print(f"    총 PnL: ${total_pnl:+.4f}")
    print(f"    평균 PnL: ${avg_pnl:+.4f}")
    print(f"    평균 MFE(1hr): {avg_mfe:.3f}%")
    print(f"    평균 MAE(1hr): {avg_mae:.3f}%")
    print(f"    평균 홀딩: {avg_hold:.1f}분")
    print(f"    평균 레인지위치: {avg_range:.1f}%")
    print(f"    평균 모멘텀: {avg_mom:+.3f}%")

    return {"total": total, "wins": wins, "wr": wr, "pnl": total_pnl, "avg_mfe": avg_mfe, "avg_mae": avg_mae}

print("\n" + "=" * 50)
ch_stats = analyze_group("추격 진입 (모멘텀 < -0.3%)", chasing)
nc_stats = analyze_group("비추격 진입", non_chasing)

# 추격 진입 상세
print("\n" + "=" * 70)
print("  추격 진입 상세 (이미 하락 중에 Short)")
print("=" * 70)
for t in chasing:
    result_emoji = "W" if t[9] == "WIN" else "L"
    print(f"    {result_emoji} {t[0]:>10} | range={t[4]:>5.1f}% | mom={t[5]:+.3f}% | MFE={t[6]:.3f}% | MAE={t[7]:.3f}% | ${t[3]:+.4f} | {t[8]:.1f}분")

# === 레인지 위치별 분석 ===
print("\n" + "=" * 70)
print("  레인지 위치별 분석 (Short 진입)")
print("=" * 70)

ranges = [
    ("0-20% (바닥)", lambda t: t[4] < 20),
    ("20-40% (저점)", lambda t: 20 <= t[4] < 40),
    ("40-60% (중간)", lambda t: 40 <= t[4] < 60),
    ("60-80% (고점)", lambda t: 60 <= t[4] < 80),
    ("80-100% (천장)", lambda t: t[4] >= 80),
]

for name, cond in ranges:
    group = [t for t in trades if cond(t)]
    if not group:
        print(f"\n  {name}: 0건")
        continue
    total = len(group)
    wins = sum(1 for t in group if t[9] == "WIN")
    wr = wins / total * 100
    pnl = sum(t[3] for t in group)
    avg_mfe = sum(t[6] for t in group) / total
    avg_mae = sum(t[7] for t in group) / total

    print(f"\n  {name}: {total}건")
    print(f"    승률={wr:.0f}% | PnL=${pnl:+.4f} | MFE={avg_mfe:.3f}% | MAE={avg_mae:.3f}%")

# === SL 여유폭 시뮬레이션 ===
print("\n" + "=" * 70)
print("  SL 여유폭 시뮬레이션")
print("  (MAE가 X% 이하인 거래만 살아남았다면?)")
print("=" * 70)

for sl_pct in [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]:
    # MAE가 sl_pct 이하 = SL 안 터짐 → 최종적으로 MFE 만큼 이동
    surviving = [t for t in trades if t[7] <= sl_pct]
    stopped = [t for t in trades if t[7] > sl_pct]

    # 살아남은 것 중 실제 결과
    surv_wins = sum(1 for t in surviving if t[9] == "WIN")
    surv_losses = sum(1 for t in surviving if t[9] == "LOSS")
    surv_pnl = sum(t[3] for t in surviving)

    # 스탑된 것은 -sl_pct * notional (대략)
    # 실제 PnL에서 더 정확하게: 스탑된 것의 PnL은 이미 LOSS
    stop_pnl = sum(t[3] for t in stopped if t[9] == "LOSS")
    stop_wins_missed = sum(1 for t in stopped if t[9] == "WIN")

    total_pnl_sim = surv_pnl + stop_pnl
    total_surv = len(surviving)

    print(f"\n  SL={sl_pct:.1f}% → 살아남음 {total_surv}건 ({surv_wins}W/{surv_losses}L), 스탑 {len(stopped)}건")
    print(f"    살아남은 PnL: ${surv_pnl:+.4f}")
    if stop_wins_missed > 0:
        print(f"    ⚠️ 스탑된 것 중 {stop_wins_missed}건은 실제로 WIN이었음 (놓친 수익)")

# === 핵심: "좋은 자리에 들어갔는데 진 것" 분석 ===
print("\n" + "=" * 70)
print("  핵심 분석: 좋은 자리(70%+) + LOSS → 왜 졌는가?")
print("=" * 70)

good_entry_losses = [t for t in trades if t[4] >= 70 and t[9] == "LOSS"]
good_entry_wins = [t for t in trades if t[4] >= 70 and t[9] == "WIN"]

print(f"\n  70%+ 진입: {len(good_entry_wins) + len(good_entry_losses)}건 중 {len(good_entry_wins)}W / {len(good_entry_losses)}L")
print(f"\n  LOSS 케이스:")
for t in good_entry_losses:
    print(f"    {t[0]:>10} range={t[4]:.1f}% | MFE={t[6]:.3f}% vs MAE={t[7]:.3f}% | 홀딩={t[8]:.1f}분 | ${t[3]:+.4f}")
    if t[6] > t[7]:
        print(f"      → MFE > MAE = 유리하게 갔다가 역전당함 (TP 못잡고 반전)")
    else:
        print(f"      → MAE > MFE = 진입 직후 역방향으로 이동 (타이밍 문제)")

# === 모멘텀 방향별 상세 ===
print("\n" + "=" * 70)
print("  모멘텀 방향 vs 결과 (Short 기준)")
print("  양수 모멘텀 = 가격 상승 중 Short (역추세) = 좋은 타이밍")
print("  음수 모멘텀 = 가격 하락 중 Short (추격) = 위험")
print("=" * 70)

mom_bins = [
    ("모멘텀 < -1% (강한 하락 추격)", lambda t: t[5] < -1.0),
    ("-1% ~ -0.3% (약한 추격)", lambda t: -1.0 <= t[5] < -0.3),
    ("-0.3% ~ +0.3% (중립)", lambda t: -0.3 <= t[5] <= 0.3),
    ("+0.3% ~ +1% (약한 상승 역추세)", lambda t: 0.3 < t[5] <= 1.0),
    ("모멘텀 > +1% (강한 상승 역추세)", lambda t: t[5] > 1.0),
]

for name, cond in mom_bins:
    group = [t for t in trades if cond(t)]
    if not group:
        print(f"\n  {name}: 0건")
        continue
    total = len(group)
    wins = sum(1 for t in group if t[9] == "WIN")
    wr = wins / total * 100
    pnl = sum(t[3] for t in group)
    avg_mfe = sum(t[6] for t in group) / total
    avg_mae = sum(t[7] for t in group) / total

    emoji = "✅" if wr >= 50 else "⚠️" if wr >= 30 else "❌"
    print(f"\n  {emoji} {name}: {total}건")
    print(f"    승률={wr:.0f}% | PnL=${pnl:+.4f} | MFE={avg_mfe:.3f}% | MAE={avg_mae:.3f}%")

# === 타점 개선 제안 ===
print("\n" + "=" * 70)
print("  타점 개선 전략 시뮬레이션")
print("=" * 70)

# 전략 1: 레인지 50%+ 에서만 Short
strat1 = [t for t in trades if t[4] >= 50]
s1_wins = sum(1 for t in strat1 if t[9] == "WIN")
s1_pnl = sum(t[3] for t in strat1)
print(f"\n  전략1: 레인지 50%+ 에서만 Short")
print(f"    {len(strat1)}건 → {s1_wins}W/{len(strat1)-s1_wins}L ({s1_wins/len(strat1)*100:.0f}%) PnL=${s1_pnl:+.4f}")

# 전략 2: 레인지 70%+ 에서만 Short
strat2 = [t for t in trades if t[4] >= 70]
s2_wins = sum(1 for t in strat2 if t[9] == "WIN")
s2_pnl = sum(t[3] for t in strat2)
print(f"\n  전략2: 레인지 70%+ 에서만 Short")
print(f"    {len(strat2)}건 → {s2_wins}W/{len(strat2)-s2_wins}L ({s2_wins/len(strat2)*100:.0f}%) PnL=${s2_pnl:+.4f}")

# 전략 3: 모멘텀 > 0 (상승 중에 Short = 역추세)
strat3 = [t for t in trades if t[5] > 0]
s3_wins = sum(1 for t in strat3 if t[9] == "WIN")
s3_pnl = sum(t[3] for t in strat3)
print(f"\n  전략3: 양수 모멘텀에서만 Short (역추세)")
print(f"    {len(strat3)}건 → {s3_wins}W/{len(strat3)-s3_wins}L ({s3_wins/len(strat3)*100:.0f}%) PnL=${s3_pnl:+.4f}")

# 전략 4: 레인지 50%+ AND 모멘텀 > 0
strat4 = [t for t in trades if t[4] >= 50 and t[5] > 0]
s4_wins = sum(1 for t in strat4 if t[9] == "WIN")
s4_pnl = sum(t[3] for t in strat4)
print(f"\n  전략4: 레인지 50%+ AND 양수 모멘텀")
print(f"    {len(strat4)}건 → {s4_wins}W/{len(strat4)-s4_wins}L ({s4_wins/len(strat4)*100:.0f}%) PnL=${s4_pnl:+.4f}")

# 전략 5: 레인지 70%+ AND 모멘텀 > +0.5%
strat5 = [t for t in trades if t[4] >= 70 and t[5] > 0.5]
s5_wins = sum(1 for t in strat5 if t[9] == "WIN")
s5_pnl = sum(t[3] for t in strat5)
print(f"\n  전략5: 레인지 70%+ AND 모멘텀 > +0.5%")
print(f"    {len(strat5)}건 → {s5_wins}W/{len(strat5)-s5_wins}L ({s5_wins/len(strat5)*100:.0f}%) PnL=${s5_pnl:+.4f}")

# 전략 6: 추격 제외 + MFE > MAE인 것의 SL만 넓힘 (hybrid)
strat6_base = [t for t in trades if t[5] >= -0.3]  # 강한 추격 제외
s6_wins = sum(1 for t in strat6_base if t[9] == "WIN")
s6_pnl = sum(t[3] for t in strat6_base)
print(f"\n  전략6: 강한 추격(mom < -0.3%) 제외")
print(f"    {len(strat6_base)}건 → {s6_wins}W/{len(strat6_base)-s6_wins}L ({s6_wins/len(strat6_base)*100:.0f}%) PnL=${s6_pnl:+.4f}")
removed = [t for t in trades if t[5] < -0.3]
r_wins = sum(1 for t in removed if t[9] == "WIN")
r_pnl = sum(t[3] for t in removed)
print(f"    제거된 {len(removed)}건: {r_wins}W → 놓친 PnL=${r_pnl:+.4f}")

# 전략 7: 강한 추격(mom < -1%) 만 제외
strat7 = [t for t in trades if t[5] >= -1.0]
s7_wins = sum(1 for t in strat7 if t[9] == "WIN")
s7_pnl = sum(t[3] for t in strat7)
print(f"\n  전략7: 초강한 추격(mom < -1%) 만 제외")
print(f"    {len(strat7)}건 → {s7_wins}W/{len(strat7)-s7_wins}L ({s7_wins/len(strat7)*100:.0f}%) PnL=${s7_pnl:+.4f}")
removed7 = [t for t in trades if t[5] < -1.0]
r7_wins = sum(1 for t in removed7 if t[9] == "WIN")
r7_pnl = sum(t[3] for t in removed7)
print(f"    제거된 {len(removed7)}건: {r7_wins}W → 놓친 PnL=${r7_pnl:+.4f}")

# === MFE 캡처율 분석 ===
print("\n" + "=" * 70)
print("  MFE 캡처율 (얼마나 수익을 가져갔는가)")
print("=" * 70)

for t in trades:
    if t[6] > 0.01 and t[9] == "WIN":
        # 대략적 PnL%: pnl / position_size
        # MFE 대비 실제 캡처는 exit_price - entry_price 기준
        pass

win_trades = [t for t in trades if t[9] == "WIN"]
loss_trades = [t for t in trades if t[9] == "LOSS"]

avg_win_mfe = sum(t[6] for t in win_trades) / len(win_trades) if win_trades else 0
avg_loss_mfe = sum(t[6] for t in loss_trades) / len(loss_trades) if loss_trades else 0
avg_win_mae = sum(t[7] for t in win_trades) / len(win_trades) if win_trades else 0
avg_loss_mae = sum(t[7] for t in loss_trades) / len(loss_trades) if loss_trades else 0

print(f"\n  WIN ({len(win_trades)}건): 평균 MFE={avg_win_mfe:.3f}% | 평균 MAE={avg_win_mae:.3f}%")
print(f"  LOSS ({len(loss_trades)}건): 평균 MFE={avg_loss_mfe:.3f}% | 평균 MAE={avg_loss_mae:.3f}%")
print(f"\n  → WIN의 MFE/MAE 비율: {avg_win_mfe/avg_win_mae:.2f}x" if avg_win_mae > 0 else "")
print(f"  → LOSS의 MFE/MAE 비율: {avg_loss_mfe/avg_loss_mae:.2f}x" if avg_loss_mae > 0 else "")

# LOSS 중 MFE가 충분했던 것
good_mfe_losses = [t for t in loss_trades if t[6] >= 1.0]
print(f"\n  LOSS 중 MFE >= 1%: {len(good_mfe_losses)}건 (이들은 수익 구간에 있었지만 놓침)")
for t in good_mfe_losses:
    print(f"    {t[0]:>10}: MFE={t[6]:.3f}% but MAE={t[7]:.3f}% → SL 터짐 후 반등 (${t[3]:+.4f})")
