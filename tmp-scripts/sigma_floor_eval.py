"""BT-gated に σ floor を入れた場合の精度評価.

各 σ floor 値で BT-gated rating を学習し、test 大会で予測精度 (Kendall τ + |SPR|) を測る.
incremental eval: 大会を時系列順に処理、test 大会では update 前 rating で予測.
"""
import datetime as dt
import sys
import math
import time
from pathlib import Path
from collections import defaultdict
import numpy as np
from scipy import stats as sp_stats

HERE = Path('/Users/kasaito/dev/delbugeki-seed/ranking_eval')
sys.path.insert(0, str(HERE))

from data_loader import load_all_tournaments
from build_tjpr_ranking import (
    tournament_display_name, tournament_event_id, is_weekend_range,
    is_weekend_date, GATED_M_TOUR, placement_to_w2w,
)
from raters.openskill_rater import OpenSkillBTRater

EVENTS_ROOT = Path('/Users/kasaito/dev/delbugeki-seed/smash_db_tournament/data/startgg/events')
EVAL_DATE = dt.datetime(2026, 5, 14)
DATA_START_DAYS = 365 * 3 + 30
TEST_START_DATE = EVAL_DATE - dt.timedelta(days=180)  # 直近 6 ヶ月を test
TEST_MIN_NENT = 48  # nent >= 48 の大会だけ test (= "意味のある大会")
SCOPES = [8, 16, 32, 64, 128, 256]
FLOORS = [0.0, 1.8, 1.9, 2.0, 2.1, 2.15, 2.2, 2.25, 2.3, 2.35, 2.4, 2.45, 2.5, 2.55, 2.6, 2.65, 2.7, 2.75, 2.8, 2.9, 3.0]


def eval_one_floor(all_tournaments, t_meta_by_id, placements_per_t, test_set_ids, floor):
    """Incremental: 各大会前後で rating 更新。test 大会では prev rating で予測."""
    b = OpenSkillBTRater()
    tour_count = defaultdict(int)

    per_scope_taus = {s: [] for s in SCOPES}
    per_scope_sprs = {s: [] for s in SCOPES}

    for t in all_tournaments:
        tid = id(t)
        is_wk = t_meta_by_id[tid]['is_weekend']

        # ── test 大会なら予測 (rating 更新前) ──
        if tid in test_set_ids:
            placements = placements_per_t.get(tid, {})
            if placements:
                # 各 attendee の現在 BT rating
                attendees = list(placements.keys())
                ratings = []
                for u in attendees:
                    r = b._get(u)
                    ratings.append((u, r.ordinal()))
                # ranked by rating desc → predicted seed
                ratings.sort(key=lambda x: -x[1])
                seed_map = {u: i + 1 for i, (u, _) in enumerate(ratings)}
                # Per scope: top-K attendees by predicted seed
                for scope in SCOPES:
                    sub = [u for u, _ in ratings[:scope] if u in placements]
                    if len(sub) < 4: continue
                    seeds = [seed_map[u] for u in sub]
                    places = [placements[u] for u in sub]
                    try:
                        tau, _ = sp_stats.kendalltau(seeds, places)
                        if not math.isnan(tau):
                            per_scope_taus[scope].append(tau)
                    except: pass
                    # SPR
                    sprs = [abs(placement_to_w2w(seed_map[u]) - placement_to_w2w(placements[u])) for u in sub]
                    if sprs:
                        per_scope_sprs[scope].append(np.mean(sprs))

        # ── 通常の BT-gated 更新 ──
        participants = set()
        for m in t.matches:
            participants.add(m.winner_id); participants.add(m.loser_id)
        for m in t.matches:
            wc, lc = tour_count[m.winner_id], tour_count[m.loser_id]
            update_w = is_wk or (wc <= GATED_M_TOUR)
            update_l = is_wk or (lc <= GATED_M_TOUR)
            if update_w or update_l:
                w_r = b._get(m.winner_id); l_r = b._get(m.loser_id)
                new_ratings = b.model.rate([[w_r], [l_r]], ranks=[1, 2])
                if update_w:
                    nw = new_ratings[0][0]
                    if floor > 0 and nw.sigma < floor:
                        nw = b.model.rating(mu=nw.mu, sigma=floor)
                    b.ratings[m.winner_id] = nw
                if update_l:
                    nl = new_ratings[1][0]
                    if floor > 0 and nl.sigma < floor:
                        nl = b.model.rating(mu=nl.mu, sigma=floor)
                    b.ratings[m.loser_id] = nl
        for uid in participants:
            tour_count[uid] += 1

    return per_scope_taus, per_scope_sprs


def main():
    t0 = time.time()
    print(f"Loading tournaments since {(EVAL_DATE - dt.timedelta(days=DATA_START_DAYS)).date()} ...", flush=True)
    data_start_ts = int((EVAL_DATE - dt.timedelta(days=DATA_START_DAYS)).timestamp())
    eval_ts = int(EVAL_DATE.timestamp())
    all_tournaments = load_all_tournaments(
        EVENTS_ROOT, "Japan",
        since_ts=data_start_ts, until_ts=eval_ts,
        min_entrants=8)
    all_tournaments.sort(key=lambda t: t.timestamp)
    print(f"  {len(all_tournaments)} tournaments ({time.time()-t0:.0f}s)", flush=True)

    # DQ filter (mirror build script)
    n_filtered = 0
    for t in all_tournaments:
        if not t.matches: continue
        played = set()
        for m in t.matches:
            played.add(m.winner_id); played.add(m.loser_id)
        if not played: continue
        filtered = [(p, u) for (p, u) in t.standings if u in played]
        if filtered and len(filtered) < len(t.standings):
            n_filtered += len(t.standings) - len(filtered)
            t.standings = filtered
    print(f"  Filtered {n_filtered} DQ no-shows", flush=True)

    # metadata
    t_meta_by_id = {}
    placements_per_t = {}
    test_set_ids = set()
    for t in all_tournaments:
        tname, ename, nent = tournament_display_name(t.event_path)
        nent = len(t.standings) or nent or 0
        d = dt.datetime.fromtimestamp(t.timestamp).date()
        end_ts = t.end_timestamp if t.end_timestamp is not None else t.timestamp
        end_d = dt.datetime.fromtimestamp(end_ts).date()
        is_wk = is_weekend_range(d, end_d)
        t_meta_by_id[id(t)] = {
            'nent': nent, 'tname': tname or '', 'ename': ename or '',
            'date': d.isoformat(), 'is_weekend': is_wk,
        }
        # placements
        seen = set(); pm = {}
        for p, u in t.standings:
            if u in seen: continue
            seen.add(u); pm[u] = p
        placements_per_t[id(t)] = pm
        # test set: test 期間 + nent >= TEST_MIN_NENT
        if t.timestamp >= int(TEST_START_DATE.timestamp()) and nent >= TEST_MIN_NENT:
            test_set_ids.add(id(t))
    print(f"  test set = {len(test_set_ids)} tournaments (since {TEST_START_DATE.date()}, nent>={TEST_MIN_NENT})", flush=True)

    # sweep
    results = {}
    for floor in FLOORS:
        st = time.time()
        per_scope_taus, per_scope_sprs = eval_one_floor(
            all_tournaments, t_meta_by_id, placements_per_t, test_set_ids, floor)
        results[floor] = (per_scope_taus, per_scope_sprs)
        print(f"  floor={floor}: done in {time.time()-st:.0f}s", flush=True)

    # Report
    print(f"\n{'='*80}")
    print(f"=== σ floor sweep results (test = {len(test_set_ids)} tournaments) ===\n")
    print(f"=== Mean Kendall τ (higher better) ===")
    print(f"  {'floor':<8s} " + ' '.join(f'K={s:<4d}' for s in SCOPES))
    for floor in FLOORS:
        taus = results[floor][0]
        parts = [f"  {floor:<8.2f}"]
        for s in SCOPES:
            v = np.mean(taus[s]) if taus[s] else None
            parts.append(f"{v:>+7.4f}" if v is not None else "   --  ")
        print(' '.join(parts))

    # Δ τ vs floor=0
    base_taus = results[0.0][0]
    print(f"\n=== Δ Kendall τ vs floor=0 (×10000) ===")
    print(f"  {'floor':<8s} " + ' '.join(f'K={s:<4d}' for s in SCOPES))
    for floor in FLOORS:
        if floor == 0.0: continue
        taus = results[floor][0]
        parts = [f"  {floor:<8.2f}"]
        for s in SCOPES:
            v = np.mean(taus[s]) if taus[s] else None
            b = np.mean(base_taus[s]) if base_taus[s] else None
            if v is None or b is None:
                parts.append("  --   ")
            else:
                d = int((v - b) * 10000)
                parts.append(f"{d:>+5d}  ")
        print(' '.join(parts))

    print(f"\n=== Mean |SPR| (lower better, W2W units) ===")
    print(f"  {'floor':<8s} " + ' '.join(f'K={s:<4d}' for s in SCOPES))
    for floor in FLOORS:
        sprs = results[floor][1]
        parts = [f"  {floor:<8.2f}"]
        for s in SCOPES:
            v = np.mean(sprs[s]) if sprs[s] else None
            parts.append(f"{v:>7.4f}" if v is not None else "   --  ")
        print(' '.join(parts))

    print(f"\nDONE in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
