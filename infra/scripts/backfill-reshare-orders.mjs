#!/usr/bin/env node
// RE order cutover for results accepted before RE orders existed (docs/reshare-auto-orders.md).
//
//   node infra/scripts/backfill-reshare-orders.mjs                      # dry-run report (default)
//   node infra/scripts/backfill-reshare-orders.mjs --output plan.json   # save the reviewed plan
//   node infra/scripts/backfill-reshare-orders.mjs --apply \
//     --plan plan.json --decision <id> [--decision <id> ...] --actor <admin-account-id>
//
// The plan is read-only. Applying needs the reviewed plan file (its eligible-set hash must still
// match), an explicit list of decisions and an active administrator; it issues each listed
// eligible result once, skips everything else and is safe to rerun. It never runs on startup.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  applyReshareCutover,
  createDatabase,
  planReshareCutover,
} from '../../packages/database/dist/index.js';

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    plan: { type: 'string' },
    output: { type: 'string' },
    decision: { type: 'string', multiple: true, default: [] },
    actor: { type: 'string' },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = createDatabase({ connectionString: databaseUrl, max: 2 });
try {
  if (!values.apply) {
    const plan = await planReshareCutover(client.db);
    const report = {
      mode: 'dry-run',
      generatedAt: plan.generatedAt,
      counts: plan.counts,
      legacyResultCount: plan.legacyResultCount,
      eligibleHash: plan.eligibleHash,
      items: plan.items.filter((item) => item.category !== 'HAS_RESHARE_ORDER'),
    };
    if (values.output) await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, items: report.items.length }, null, 2));
  } else {
    if (!values.plan || !values.actor || values.decision.length === 0) {
      console.error(
        '--apply needs --plan <reviewed plan.json>, --actor <admin id> and --decision.',
      );
      process.exit(1);
    }
    const plan = JSON.parse(await readFile(values.plan, 'utf8'));
    const result = await applyReshareCutover(client.db, {
      decisionIds: values.decision,
      expectedEligibleHash: plan.eligibleHash,
      actorUserId: values.actor,
    });
    console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'reshare_cutover_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
