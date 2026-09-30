# Desktop layout and semantic colour audit

Base: `125e4b7565da20a3a62688a064e640b57193884e`. Presentation-only change; no API, database, permission, money or weight logic touched. Migration: N/A.

## Layout baseline (measured, mock-fallback build, Chromium)

160 cases = 4 roles (ADMIN, HTKD, STORE_RETAIL, STORE_WHOLESALE) × their permitted routes × 1366×768, 1440×900, 1920×1080, 2560×1440. Measured: document `scrollWidth`, gap between `.app-main` content box and the page header/panels, escaped `.panel/.page-header/table` rectangles.

- Result: **no gutter or overflow defect** on the shared shell. Left/right gaps equal the 18px token on every case; header and panels share one axis; no document overflow. The only "suspect" hits were the two-column `/requests` grid (first panel is one intentional column) and the 404 page, which lives outside the shell and is centred by `place-content: center`.
- Consequently the shell CSS (`--sidebar-width`, `--content-pad`, `.app-main`) was **not changed**.
- Denied routes redirect to `/` (`AppShell`), they do not render a denied screen; unknown paths render `NotFoundPage`.
- Observation, not fixed: in the API-error state of `/warehouse-inbound` the error panel starts 36px from the top versus 18px elsewhere.

Limit: the preview has no API, so most data-bearing screens rendered their error/empty state. Layout with populated data is covered only by the existing fixtures (inbound, inventory). Populated tabs/modals on other routes are **NOT TESTED** here.

## Colour findings and changes

| Finding                                                                                                                        | Change                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority` tone (badges, stat cards, flow cards, priority-offer banner) was green, indistinguishable in meaning from `success` | Now pink `--priority #be185d` on `#fdf2f8`; banner background `#be185d` with white text                                                                                            |
| No purple/yellow tokens for secondary groups                                                                                   | Added `--accent #6d28d9`, `--caution #854d0e` (+ soft/border) and `accent` tone for badge/StatCard                                                                                 |
| Importance could only be expressed through business status                                                                     | `StatCard emphasis="important"` renders the value in `--danger` independent of `tone`                                                                                              |
| Important totals were neutral                                                                                                  | Red: receipt grand total (`.receipt-totals__grand`), adjustment delta, receipt line "Thiếu N" badge (now `danger`, text kept), sales "Chưa phân loại" when orders need reconciling |

Sale-by-piece / sale-by-kg revenue cards use the purple `accent` tone. Errors remain red and carry label/icon.

## Tests

- `src/components/StatCard.test.tsx` — emphasis is independent of tone and backwards compatible.
- `e2e/desktop-visual-colors.spec.ts` (default mock suite, desktop project): per role/route/viewport, every top-level block of `.app-main` is symmetric within 2px, no document/panel overflow; denied route redirects; unknown path centred; computed contrast ≥ 4.5:1 for every badge/stat tone (with and without emphasis) and priority ≠ success. Verified to fail against the old CSS (important success card was green).
- `e2e/desktop-route-matrix.ts` — route × role manifest mirroring `lib/access.ts`.
- This spec needs the demo-role mock mode, so it runs in the default suite, not `e2e:production`.

Local results (Node 22 with `--engine-strict=false`, Chromium 1194 via executablePath): default e2e 33 passed / 11 skipped (mobile-skips); production-config e2e 17 passed / 1 skipped; unit 312+129+77+149; format, lint, typecheck, build clean. `e2e:live` (PostgreSQL) was not run — no database in this environment.

## Not done

Before/after screenshots and browser-zoom (100/125/150%) evidence were not produced in this session; zoom and populated-screen colour review remain to be done.

## Rollback

Revert the squash commit via PR; the watcher deploys the new green `main` SHA. No schema change.
