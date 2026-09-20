# Sales dashboard and interface refresh

## Scope and acceptance

- Display IDOSI revenue, piece quantities and sold kg, including all product rows, for the selected month and authorized stores. Keep retail snapshots separate from internal warehouse sales; never add the two revenue sources.
- Preserve missing, incomplete and failed-sync states; distinguish measured from converted kg. Monetary aggregation uses integers.
- Bright panel/button borders, colored navigation icons, clearly selected navigation and red required-field markers.
- Replace the split login screen with the existing login form and the requested IDOSI slogan.
- Supplier inbound weights become optional: unknown is null, never zero; bag stock is still counted, and kg-based cost confirmation must reject incomplete weights.
- Reshape the operational dashboard around the supplied reference, using only real available measures and functional filters/actions.

## Evidence and root cause

The deployed database contains monthly IDOSI snapshots. The dashboard reads the monthly internal operations report, not those snapshots. The sales screen requires an individual store selection and truncates the product table to eight rows. A paginated authorized snapshot endpoint and reusable sales section close these read/render gaps without changing stock.

## Commit plan

1. Scoped IDOSI snapshot reads, summary UI and regression tests.
2. Login and global visual states.
3. Optional supplier weight contract, migration, transactions, UI and tests.
4. Dashboard layout and remaining required-field coverage, responsive verification.

## Verification and risk

Run format, lint, typecheck, unit/API, PostgreSQL integration, migration, production build and browser tests at 360, 390, 412, 768, 1366 and 1440 px. Verify month/store switching, missing snapshots, mixed PIECE/KG, stale sync and unauthorized scopes. Verify weightless receipts, mixed known/unknown weights, replay, stock conservation and rejected kg-based costing.

Before deployment: merge only after CI/review gates, take and restore-check a fresh backup, build immutable merged-SHA images, then check readiness, source data and browser output. Nullable inbound weight is forward-compatible at the database level but old application readers cannot consume new null-weight receipts; roll back application code only before any such receipt exists, otherwise use a forward fix.

No source credentials, production rows or sample screenshot metrics belong in this repository.
