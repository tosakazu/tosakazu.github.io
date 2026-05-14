#!/usr/bin/env python3
"""Compute SPR and UF for ranking evaluation.

SPR (Seed Performance Rating) = W2W(seed) - W2W(placement)
UF  (Upset Factor) = W2W(winner_seed) - W2W(loser_seed) for upsets

W2W = "Wins to Win" = rounds from victory in DE bracket.
Reference: PGstats "Introducing SPR and UF" (2020)
"""
from __future__ import annotations
import argparse, datetime as dt, json, statistics
from pathlib import Path
from data_loader import load_all_tournaments

EVENTS_ROOT = Path(__file__).resolve().parent.parent / "smash_db_tournament" / "data" / "startgg" / "events"

# DE placement boundaries: W2W n -> placement boundary
# n=0:1, 1:2, 2:3, 3:4, 4:5, 5:7, 6:9, 7:13, 8:17, 9:25, ...
def _build_de_boundaries(max_w2w=30):
    """Return list of (placement_boundary, w2w)."""
    bounds = []
    for n in range(max_w2w + 1):
        if n == 0: p = 1
        elif n == 1: p = 2
        elif n % 2 == 0: p = 2 ** (n // 2) + 1
        else: p = 3 * 2 ** ((n - 3) // 2) + 1
        bounds.append((p, n))
    return bounds

DE_BOUNDS = _build_de_boundaries()

def placement_to_w2w(place: int) -> int:
    """Map a placement (or seed position) to W2W in DE bracket."""
    result = 0
    for p, w in DE_BOUNDS:
        if p <= place:
            result = w
        else:
            break
    return result

def load_ranking(path: Path) -> dict[int, int]:
    ranking = {}
    rank = 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.rstrip()
            if not line or line.lstrip().startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 3:
                continue
            uid = None
            for idx in (3, 2):
                if idx < len(parts):
                    try:
                        c = int(parts[idx])
                    except ValueError:
                        continue
                    if c > 1000:
                        uid = c
                        break
            if uid is None:
                continue
            rank += 1
            ranking[uid] = rank
    return ranking

def num_entrants(t) -> int:
    try:
        with open(Path(t.event_path) / "attr.json", "rb") as f:
            d = json.loads(f.read())
        return int(d.get("num_entrants") or 0)
    except Exception:
        return len(t.standings)

def evaluate_spr_uf(ranking: dict[int, int], majors: list):
    all_spr = []
    all_abs_spr = []
    total_uf = 0
    upset_count = 0
    match_count = 0

    for t in majors:
        # Build seed order among attendees
        attendees = []
        seen = set()
        for place, uid in t.standings:
            if uid in seen or uid not in ranking:
                continue
            seen.add(uid)
            attendees.append((uid, place, ranking[uid]))

        if len(attendees) < 2:
            continue

        # Seed = rank among attendees by ranking order
        attendees.sort(key=lambda x: x[2])  # sort by global rank
        uid_to_seed = {}
        for i, (uid, _, _) in enumerate(attendees):
            uid_to_seed[uid] = i + 1  # 1-based seed

        # SPR per player
        for uid, place, _ in attendees:
            seed = uid_to_seed[uid]
            spr = placement_to_w2w(seed) - placement_to_w2w(place)
            all_spr.append(spr)
            all_abs_spr.append(abs(spr))

        # UF per match (upsets only)
        for m in t.matches:
            w, l = m.winner_id, m.loser_id
            if w not in uid_to_seed or l not in uid_to_seed:
                continue
            match_count += 1
            w_seed = uid_to_seed[w]
            l_seed = uid_to_seed[l]
            if w_seed > l_seed:  # upset: lower-ranked player won
                uf = placement_to_w2w(w_seed) - placement_to_w2w(l_seed)
                total_uf += uf
                upset_count += 1

    return {
        "mean_spr": statistics.mean(all_spr) if all_spr else 0,
        "mean_abs_spr": statistics.mean(all_abs_spr) if all_abs_spr else 0,
        "median_abs_spr": statistics.median(all_abs_spr) if all_abs_spr else 0,
        "total_uf": total_uf,
        "upset_count": upset_count,
        "match_count": match_count,
        "upset_rate": upset_count / match_count if match_count else 0,
        "mean_uf_per_upset": total_uf / upset_count if upset_count else 0,
        "mean_uf_per_match": total_uf / match_count if match_count else 0,
        "n_players": len(all_spr),
    }

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ranking", action="append", required=True)
    ap.add_argument("--cutoff", default="2026-03-22")
    ap.add_argument("--min-entrants", type=int, default=100)
    args = ap.parse_args()

    cutoff_ts = int(dt.datetime.fromisoformat(args.cutoff).timestamp())
    all_t = load_all_tournaments(EVENTS_ROOT, "Japan", since_ts=cutoff_ts, min_entrants=args.min_entrants)
    majors = [t for t in all_t if num_entrants(t) >= args.min_entrants]
    print(f"{len(majors)} eval majors\n")

    results = []
    for path_str in args.ranking:
        p = Path(path_str)
        if not p.is_absolute():
            p = Path(__file__).resolve().parent / p
        r = load_ranking(p)
        res = evaluate_spr_uf(r, majors)
        res["name"] = p.name
        results.append(res)

    # Print table sorted by mean_abs_spr (lower = better)
    results.sort(key=lambda x: x["mean_abs_spr"])

    print(f"{'ranking':<28} {'mean_SPR':>9} {'|SPR|mean':>9} {'|SPR|med':>8} {'UF_total':>9} {'upsets':>7} {'matches':>8} {'upset%':>7} {'UF/upset':>9} {'UF/match':>9}")
    print("-" * 135)
    for r in results:
        print(f"{r['name']:<28} {r['mean_spr']:>+9.3f} {r['mean_abs_spr']:>9.3f} {r['median_abs_spr']:>8.1f} {r['total_uf']:>9d} {r['upset_count']:>7d} {r['match_count']:>8d} {r['upset_rate']*100:>6.1f}% {r['mean_uf_per_upset']:>9.3f} {r['mean_uf_per_match']:>9.3f}")

if __name__ == "__main__":
    main()
