# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Nurcholis46/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Nurcholis46/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for 1280x720 screenshots: it decodes each stored PNG to RGBA, then searches colour-type reductions (palette with four orderings, grey, RGB, and single-colour tRNS keys), per-row PNG filters (fixed, minimum-sum, fewest-pairs, entropy, and a zlib-weighed brute force), and level-9 zlib settings, keeping the smallest file that still decodes pixel-for-pixel exact — transparent pixels' colours included.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Each instance is read from `<input-dir>/<id>/image.png` and written to `out/<id>/image.png`, creating the output folders itself and leaving them readable (0644/0755). With no environment set it reads `/input` and writes `/output`, as the grader does. Pure Node 22 builtins; nothing to install. The search budget is fixed work, never the clock, so two runs write identical bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mt29fv3h&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
