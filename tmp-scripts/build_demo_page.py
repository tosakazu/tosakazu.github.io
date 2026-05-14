#!/usr/bin/env python3
"""Build a /banzuke/demo/<name>/ filtered ranking page.

Inputs:
  --participants  TSV (seed, uid, display) from fetch_event_participants.py
  --master-jsonl  /banzuke/latest_tjpr_full.jsonl
  --master-meta   /banzuke/meta.json
  --index-html    /banzuke/index.html (template)
  --title         Page title prefix
  --out-dir       output directory (e.g. /tmp/tosakazu.github.io/banzuke/demo/kurobra51)
"""
import argparse
import json
import re
import sys
from pathlib import Path


def load_participants(path):
    """Returns list of dicts: {uid: int|None, display: str, seed: int|None}."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            seed_raw, uid_raw, display = parts[0], parts[1], parts[2]
            try:
                uid = int(uid_raw)
            except ValueError:
                uid = None
            try:
                seed = int(seed_raw)
            except ValueError:
                seed = None
            rows.append({"uid": uid, "display": display, "seed": seed})
    return rows


def filter_and_rerank(participants, master_path):
    """Filter master JSONL to participants and append DB-missing players at bottom.

    participants: list of dicts {uid, display, seed}.
    Returns: list of records (ranked + unranked appended).
    """
    pset = {p["uid"] for p in participants if p["uid"] is not None}
    pmap = {p["uid"]: p for p in participants if p["uid"] is not None}
    found_uids = set()
    found = []
    with open(master_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            uid = rec.get("user_id")
            if uid in pset:
                rec.setdefault("ranks", {})
                rec["ranks"]["global_ensemble"] = rec["ranks"].get("ensemble")
                rec["ranks"]["global_tjpr"] = rec["ranks"].get("tjpr")
                rec["ranks"]["global_bt_gated"] = rec["ranks"].get("bt_gated")
                found.append(rec)
                found_uids.add(uid)

    n = len(found)
    # Ensemble は event-local 1..N に再付番 (= シード順)
    found.sort(key=lambda r: r["ranks"]["global_ensemble"] or 10**9)
    for i, rec in enumerate(found):
        rec["ranks"]["ensemble"] = i + 1
    # 順位評価 / 直対評価 は全体ランキングのまま (ranks.tjpr / ranks.bt_gated はマスター JSONL の global 値)
    # ensemble_avg_rank も既に global tjpr+bt の平均なのでそのまま

    # Append DB-missing participants at the bottom (sorted by start.gg seed)
    missing = [p for p in participants if p["uid"] not in found_uids]
    missing.sort(key=lambda p: p["seed"] if p["seed"] is not None else 10**9)
    next_rank = n + 1
    for p in missing:
        rec = {
            "user_id": p["uid"],
            "display": p["display"],
            "unranked": True,
            "ranks": {
                "ensemble": next_rank,
                "tjpr": None,
                "bt_gated": None,
                "global_ensemble": None,
                "global_tjpr": None,
                "global_bt_gated": None,
            },
            "scores": {
                "tjpr_score": 0.0,
                "tjpr_elo": 0.0,
                "tjpr_level": 0,
                "bt_gated_ordinal": 0.0,
                "bt_gated_elo": 0.0,
                "ensemble_avg_rank": None,
                "ensemble_avg_score": None,
            },
            "metadata": {
                "tour_count_3y": 0,
                "bt_weekday_included": False,
                "matches_count_3y": 0,
            },
        }
        found.append(rec)
        next_rank += 1

    return found, len(missing)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--participants", required=True)
    ap.add_argument("--master-jsonl", required=True)
    ap.add_argument("--master-meta", required=True)
    ap.add_argument("--index-html", required=True)
    ap.add_argument("--overview-html", required=False)
    ap.add_argument("--details-html", required=False)
    ap.add_argument("--title", required=True, help="Tournament label, e.g. '黒ブラ51'")
    ap.add_argument("--source-url", required=True, help="start.gg event URL")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Load participants
    participants = load_participants(args.participants)
    print(f"Loaded {len(participants)} participants", file=sys.stderr)

    # Filter master and re-rank, plus append DB-missing as unranked
    found, missing = filter_and_rerank(participants, args.master_jsonl)
    ranked = len(found) - missing
    print(f"Ranked: {ranked} / {len(participants)} ({missing} appended as DB-missing at bottom)", file=sys.stderr)

    # Write JSONL (ordered: ranked first, missing last)
    out_jsonl = out_dir / "latest_tjpr_full.jsonl"
    with out_jsonl.open("w", encoding="utf-8") as f:
        for rec in found:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"Wrote {out_jsonl}", file=sys.stderr)

    # Write meta.json (filtered count)
    meta = json.load(open(args.master_meta, encoding="utf-8"))
    meta["n_players"] = len(found)
    meta["demo"] = {
        "title": args.title,
        "source_url": args.source_url,
        "participants_total": len(participants),
        "participants_ranked": ranked,
        "participants_missing": missing,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    # Modify index.html
    html = Path(args.index_html).read_text(encoding="utf-8")
    # Override PLAYERS_DIR to point to main /banzuke/players/
    # The script reads `players/${uid}.json`. We need to redirect to `../../players/`.
    # Inject window.PLAYERS_DIR = '../../players/' before main script.
    injection = """<script>
// Demo page: override paths to load player details + nav from main /banzuke/.
window.PLAYERS_DIR = '../../players';
window.DEMO_TITLE = """ + json.dumps(args.title, ensure_ascii=False) + """;
window.DEMO_SOURCE_URL = """ + json.dumps(args.source_url) + """;
window.DEMO_NAV_PREFIX = '../../';
</script>
"""
    # Insert before the main fetch script. Find the <script> tag near "// Load data".
    # Simpler: insert just before </head>.
    html = html.replace("</head>", injection + "</head>", 1)

    # Replace title
    html = re.sub(r"<title>.*?</title>", f"<title>SPSP — {args.title}</title>", html, count=1)
    # Replace H1
    html = re.sub(r"<h1>SPSP</h1>", f'<h1>SPSP — {args.title}</h1>', html, count=1)
    # Replace subtitle
    n_total = len(participants)
    n_found = len(found)
    miss_note = f" (うち {missing} 名は DB に履歴なし → 最下位扱い)" if missing else ""
    new_sub = (f'<p class="subtitle"><a href="{args.source_url}" target="_blank" style="color:#58a6ff">'
               f'{args.source_url}</a> 出場者 {n_total} 名のシード予想{miss_note}</p>')
    html = re.sub(r'<p class="subtitle">.*?</p>', new_sub, html, count=1)

    # Fix nav links to point back to main banzuke (../../)
    html = html.replace('href="index.html" class="current"', 'href="../../index.html"')
    html = html.replace('href="overview.html"', 'href="../../overview.html"')
    html = html.replace('href="details.html"', 'href="../../details.html"')
    html = html.replace('href="seed/"', 'href="../../seed/"')
    html = html.replace('href="seed-upload/"', 'href="../../seed-upload/"')
    # Player and tournament detail page links (relative depth: demo/<name>/ -> ../../p, ../../t)
    html = html.replace('href="p/?uid=', 'href="../../p/?uid=')
    html = html.replace('href="t/?id=', 'href="../../t/?id=')

    # Patch JS: fetch('players/...') → fetch(`${window.PLAYERS_DIR}/...`)
    # Original: const res = await fetch(`players/${uid}.json`);
    html = html.replace(
        "fetch(`players/${uid}.json`)",
        "fetch(`${window.PLAYERS_DIR || 'players'}/${uid}.json`)"
    )

    (out_dir / "index.html").write_text(html)
    print(f"Wrote {out_dir}/index.html", file=sys.stderr)


if __name__ == "__main__":
    main()
