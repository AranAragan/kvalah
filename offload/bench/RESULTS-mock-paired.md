# Kvalah paired benchmark — MOCK (not measured)

MOCK: deterministic mock model; cloud token usage of BOTH arms is a heuristic estimate. This run checks the harness and the pipeline (routing, chunking, retrieval, quote verification). It is not measured usage and must not be quoted as savings.

seed=2026 reps=1 ctx=16384 node=v24.22.1 date=2026-11-24T19:10:09.747Z

Scenarios: 54; errors: 0; mean pipeline recall (L1/L2 scenarios): 1; router declined (L3): 10.

Estimated cloud tokens on the target set (mock heuristic): baseline 188262, hybrid 121014. Gates: not evaluated (usage not measured).

| scenario | category | target set | level | strategy | ok | recall | baseline in+out (est.) | hybrid in+out (est.) | ms |
|---|---|---|---|---|---|---|---|---|---|
| ci-log-0 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 5308+200 | 1315+239 | 30 |
| ci-log-1 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 7037+200 | 1656+239 | 23 |
| ci-log-2 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 8754+200 | 1999+239 | 29 |
| ci-log-3 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 10471+200 | 1317+239 | 38 |
| ci-log-4 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 12207+200 | 1657+239 | 39 |
| ci-log-5 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 13941+200 | 1999+239 | 47 |
| ci-log-6 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 15645+200 | 1376+245 | 17 |
| ci-log-7 | ci-log | yes | 2 | map-reduce | ✔ | 1 | 17366+200 | 1717+245 | 15 |
| ci-log-count-0 | ci-log | yes | 2 | retrieve | ✔ | 1 | 5301+200 | 1658+247 | 21 |
| ci-log-count-3 | ci-log | yes | 2 | retrieve | ✔ | 1 | 10464+200 | 1698+247 | 37 |
| search-env | search | yes | 1 | deterministic | ✔ | 1 | 75+200 | 163+215 | 83 |
| search-deprecated | search | yes | 1 | deterministic | ✔ | 1 | 62+200 | 150+216 | 18 |
| search-innerhtml | search | yes | 1 | deterministic | ✔ | 1 | 44+200 | 116+214 | 18 |
| search-eval | search | yes | 1 | deterministic | ✔ | 1 | 40+200 | 112+214 | 17 |
| search-todo | search | yes | 1 | deterministic | ✔ | 1 | 296+200 | 642+214 | 12 |
| search-exec | search | yes | 1 | deterministic | ✔ | 1 | 50+200 | 124+215 | 16 |
| deps-importers-widget | outline-deps | yes | 1 | deterministic | ✔ | 1 | 141+200 | 509+217 | 139 |
| deps-cycle | outline-deps | yes | 1 | deterministic | ✔ | 1 | 1134+200 | 264+206 | 10 |
| deps-transitive | outline-deps | yes | 1 | deterministic | ✔ | 1 | 140+200 | 176+216 | 9 |
| outline-review | outline-deps | yes | 1 | deterministic | ✔ | 1 | 5467+200 | 67977+217 | 11 |
| symbols-createWidget | outline-deps | yes | 1 | deterministic | ✔ | 1 | 45+200 | 142+215 | 11 |
| references-createWidget | outline-deps | yes | 1 | deterministic | ✔ | 1 | 233+200 | 515+215 | 9 |
| docs-storage | docs | yes | 2 | direct | ✔ | 1 | 1864+200 | 1053+238 | 3 |
| docs-scheduler | docs | yes | 2 | direct | ✔ | 1 | 1901+200 | 1058+238 | 2 |
| docs-network | docs | yes | 2 | direct | ✔ | 1 | 1860+200 | 1053+238 | 2 |
| docs-security | docs | yes | 2 | direct | ✔ | 1 | 1894+200 | 1055+238 | 3 |
| docs-release | docs | yes | 2 | direct | ✔ | 1 | 1860+200 | 1053+238 | 3 |
| docs-telemetry | docs | yes | 2 | direct | ✔ | 1 | 1902+200 | 1058+238 | 2 |
| tests-m0 | tests | yes | 2 | direct | ✔ | 1 | 83+200 | 956+243 | 1 |
| tests-m1 | tests | yes | 2 | direct | ✔ | 1 | 84+200 | 956+243 | 1 |
| tests-m2 | tests | yes | 2 | direct | ✔ | 1 | 84+200 | 956+243 | 1 |
| tests-m3 | tests | yes | 2 | direct | ✔ | 1 | 84+200 | 956+243 | 1 |
| tests-m4 | tests | yes | 2 | direct | ✔ | 1 | 83+200 | 956+243 | 1 |
| review-r0 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5467+200 | 1243+255 | 18 |
| review-r1 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5470+200 | 1237+255 | 15 |
| review-r2 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5469+200 | 1251+255 | 22 |
| review-r3 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5468+200 | 1248+255 | 16 |
| review-r4 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5468+200 | 1287+255 | 17 |
| review-r5 | pre-review | yes | 2 | retrieve | ✔ | 1 | 5468+200 | 1285+255 | 25 |
| repo-summary-pkg4 | large-repo | yes | 2 | direct | ✔ | 1 | 313+200 | 2512+301 | 3 |
| repo-stats | large-repo | yes | 1 | deterministic | ✔ | 1 | 8316+200 | 112+207 | 16 |
| repo-graph | large-repo | yes | 1 | deterministic | ✔ | 1 | 1141+200 | 271+206 | 9 |
| repo-symbols-mod | large-repo | yes | 1 | deterministic | ✔ | 1 | 41+200 | 138+213 | 10 |
| repo-review-all | large-repo | yes | 2 | retrieve | ✔ | 1 | 10921+200 | 1691+255 | 69 |
| short-table | short | no | 3 | declined | ✔ | n/a | 10+200 | 119+224 | 1 |
| short-rename | short | no | 3 | declined | ✔ | n/a | 13+200 | 122+229 | 1 |
| short-json | short | no | 3 | declined | ✔ | n/a | 8+200 | 148+221 | 0 |
| short-regex | short | no | 3 | declined | ✔ | n/a | 9+200 | 150+228 | 1 |
| short-commit | short | no | 3 | declined | ✔ | n/a | 11+200 | 121+226 | 0 |
| read-config | already-read | no | 3 | declined | ✔ | n/a | 16+200 | 82+234 | 0 |
| read-widget | already-read | no | 3 | declined | ✔ | n/a | 13+200 | 79+233 | 0 |
| read-cycle | already-read | no | 3 | declined | ✔ | n/a | 12+200 | 78+231 | 0 |
| read-deprecated | already-read | no | 3 | declined | ✔ | n/a | 12+200 | 78+233 | 0 |
| read-readme | already-read | no | 3 | declined | ✔ | n/a | 11+200 | 77+228 | 0 |
