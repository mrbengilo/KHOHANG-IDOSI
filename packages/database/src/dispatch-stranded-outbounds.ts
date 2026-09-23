import { closeDatabase, db } from './client.js';
import { dispatchStrandedAllocationOutbounds } from './stranded-outbounds.js';

/**
 * One-off repair for allocation shipments stuck at `reserved`.
 *
 *   node packages/database/dist/dispatch-stranded-outbounds.js           # dry run (default)
 *   node packages/database/dist/dispatch-stranded-outbounds.js --apply   # release them
 *
 * Take a verified database backup before --apply. Every release writes an
 * OUTBOUND_REQUEST_DISPATCHED audit row marked `trigger: stranded-outbound-backfill`.
 */
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => arg !== '--apply' && arg !== '--dry-run');
if (unknown.length > 0 || (args.has('--apply') && args.has('--dry-run'))) {
  console.error('Usage: dispatch-stranded-outbounds.js [--dry-run | --apply]');
  process.exit(2);
}
const apply = args.has('--apply');

try {
  const result = await dispatchStrandedAllocationOutbounds(db, { apply });
  console.info(apply ? 'Mode: APPLY' : 'Mode: DRY RUN (no changes written)');
  console.info(`Stranded allocation outbounds found: ${result.candidates.length}`);
  for (const candidate of result.candidates) {
    console.info(
      [
        candidate.requestNumber,
        `store=${candidate.storeId}`,
        `lines=${candidate.lineCount}`,
        `bags=${candidate.approvedQuantity}`,
        `created=${candidate.createdAt.toISOString()}`,
        candidate.blockedReason === null ? 'dispatchable' : `BLOCKED: ${candidate.blockedReason}`,
      ].join(' | '),
    );
  }
  if (apply) console.info(`Dispatched: ${result.dispatchedIds.length}`);
  for (const skip of result.skipped) console.info(`Skipped ${skip.id}: ${skip.reason}`);
  if (result.skipped.length > 0) process.exitCode = 3;
} catch (error: unknown) {
  console.error(
    'Stranded outbound backfill failed; nothing after the failing outbound ran.',
    error,
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
