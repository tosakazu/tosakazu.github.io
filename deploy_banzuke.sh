#!/bin/bash
# Deploy SPSP site (= /spsp/) to GitHub Pages with version stamping.
# Usage: ./deploy_banzuke.sh "<commit message>"
#
# Steps:
#   1) rsync site/ to /tmp/tosakazu.github.io/spsp/ (skip players/, master jsonl, demo/)
#   2) Rebuild クロブラ/九龍 demo from latest master + index.html template
#   3) Stamp __SITE_VERSION__ with short SHA + UTC timestamp
#   4) Commit + push to gh-pages
#   5) Poll live site until the new version string appears

set -e

MSG="${1:-Deploy}"
SRC="/Users/kasaito/dev/delbugeki-seed/ranking_eval/site"
SITE="/tmp/tosakazu.github.io"
DST="$SITE/spsp"
PY="/Users/kasaito/dev/delbugeki-seed/ranking_eval/.venv/bin/python3"

echo "[1/5] rsync site -> $DST ..."
rsync -a \
  --exclude '.netlify' --exclude '.DS_Store' --exclude 'demo' \
  "$SRC/" "$DST/"

echo "[2/5] rebuild v2 demo pages ..."
cd /Users/kasaito/dev/delbugeki-seed/ranking_eval
"$PY" /tmp/build_demo_page.py \
  --participants /tmp/kurobra51_participants.txt \
  --master-jsonl "$DST/latest_tjpr_full.jsonl" --master-meta "$DST/meta.json" \
  --index-html "$SRC/index.html" \
  --title "クロブラ51 SP 1on1" \
  --source-url "https://www.start.gg/tournament/51-10-kurobra51/event/sp-1on1" \
  --out-dir "$DST/demo/kurobura_v2" > /dev/null
"$PY" /tmp/build_demo_page.py \
  --participants /tmp/kowloon18_participants.txt \
  --master-jsonl "$DST/latest_tjpr_full.jsonl" --master-meta "$DST/meta.json" \
  --index-html "$SRC/index.html" \
  --title "九龍 #18 SP" \
  --source-url "https://www.start.gg/tournament/kowloon-18/event/kowloon_sp" \
  --out-dir "$DST/demo/kowloon_v2" > /dev/null

# Inject V1/V2 cross-version banner into v2 demos (build_demo_page.py rebuilds from template, banner is lost each time)
$PY - <<PYEOF
import re
BANNER = lambda partner: '<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:8px 14px;margin:10px 0;font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;"><span style="background:#dc2626;color:#fff;padding:2px 10px;border-radius:10px;font-weight:600">V2</span><small style="color:#16a34a">σ floor 2.35 新モデル (覚醒選手の上位食い込み追従強化)</small> <a href=\'../{partner}/\' style=\'color:#dc2626;font-weight:600;text-decoration:none\'>→ V1 はこちら</a></div>'.format(partner=partner)
for path, partner in [
    ("$DST/demo/kurobura_v2/index.html", "kurobura_v1"),
    ("$DST/demo/kowloon_v2/index.html", "kowloon_v1"),
]:
    s = open(path).read()
    s = re.sub(r'<div style="background:#fef3c7[^"]*"[^>]*>(?:(?!</div>).)*V2(?:(?!</div>).)*</div>', '', s)
    s = re.sub(r'(<p class="subtitle">[^<]*<a[^<]*</a>[^<]*</p>)', r'\1' + BANNER(partner), s, count=1)
    open(path, 'w').write(s)
PYEOF

echo "[3/5] stamp __SITE_VERSION__ ..."
# Use a predicted version string: short hash of all HTML/JS in deployed tree + UTC timestamp.
TS=$(date -u +'%Y-%m-%d %H:%M UTC')
CONTENT_HASH=$(find "$DST" -path "$DST/players" -prune -o \
                 \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -print 2>/dev/null \
               | sort | xargs cat 2>/dev/null | shasum -a 256 | cut -c1-7)
VERSION="v ${CONTENT_HASH} · ${TS}"
echo "  → $VERSION"
# Use a simple Python one-liner for portable in-place replace (BSD sed is awkward).
$PY - <<PYEOF
import os
DST = "$DST"
ver = "$VERSION".replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
for root, _, files in os.walk(DST):
    if "/players" in root: continue
    for f in files:
        if not f.endswith(".html"): continue
        p = os.path.join(root, f)
        s = open(p, encoding="utf-8").read()
        if "__SITE_VERSION__" in s:
            open(p, "w", encoding="utf-8").write(s.replace("__SITE_VERSION__", ver))
PYEOF

echo "[4/5] commit + push ..."
cd "$SITE"
rm -f spsp/latest_banzuke_v2_1.jsonl spsp/latest_bt.jsonl spsp/seed_map.json
git add -A spsp/ banzuke/ 2>/dev/null || true
if git diff --cached --quiet; then
  echo "  → no changes, nothing to commit"
  exit 0
fi
git commit -m "$MSG"
git push origin gh-pages

echo "[5/5] verify live site ..."
TARGET="$CONTENT_HASH"
SECONDS_WAITED=0
until curl -fsS "https://tosakazu.github.io/spsp/index.html?$(date +%s)" 2>/dev/null | grep -q "$TARGET"; do
  sleep 10
  SECONDS_WAITED=$((SECONDS_WAITED + 10))
  if [ "$SECONDS_WAITED" -gt 240 ]; then
    echo "  → timeout waiting for $TARGET (deployed but not live yet — give it a minute)"
    exit 0
  fi
done
echo "  → live (${SECONDS_WAITED}s)"
echo
echo "✅ deployed: $VERSION"
