# SPSP (Saikyo Player SPECIAL) Build Pipeline — Backup Branch

Backup of scripts/templates driving the SPSP ranking site at https://tosakazu.github.io/spsp/.

This branch is **not** the published site (see `gh-pages` for that). It snapshots the source files
that live outside the gh-pages repo so they don't get lost.

## Layout

```
build_tjpr_ranking.py     # main builder (training + JSON render)
data_loader.py            # load tournaments from smash_db
deploy_banzuke.sh         # rsync site → gh-pages + version stamp + push
spr_uf_analysis.py        # W2W bounds for DE bracket
raters/                   # OpenSkill BradleyTerryFull adapter etc.

site/                     # HTML templates
  index.html              # main ranking page
  overview.html
  details.html
  p/index.html            # player detail
  t/index.html            # tournament detail
  seed/index.html         # seed generator
  seed-upload/index.html

tmp-scripts/              # files that live in /tmp/ on the build host
  build_demo_page.py
  sigma_floor_eval.py     # σ floor sweep experiment
  kurobra51_participants.txt
  kowloon18_participants.txt
```

## Source repo

These all originated from `/Users/kasaito/dev/delbugeki-seed/ranking_eval/` (local repo with no remote).
This branch is the only backup that survives outside that local checkout.
