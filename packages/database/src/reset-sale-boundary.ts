import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Transaction } from './transaction.js';

type ResetOperation = { cutoff: Date | string; period: string };
const transactionOperations = new WeakMap<Transaction, Promise<ResetOperation | undefined>>();
function resetOperation(tx: Transaction): Promise<ResetOperation | undefined> {
  let promise = transactionOperations.get(tx);
  if (!promise) {
    promise = (async () => {
      const relations = await tx.execute<{ operation: string | null; baseline: string | null }>(
        sql`SELECT to_regclass('public.test_data_reset_operations')::text AS operation,to_regclass('public.test_data_reset_baselines')::text AS baseline`,
      );
      const row = relations.rows[0]!;
      if (!row.operation && !row.baseline) return undefined; // legacy migration rehearsal
      if (!row.operation || !row.baseline) throw new Error('Incomplete reset schema');
      const result = await tx.execute<ResetOperation>(
        sql`SELECT cutoff,to_char(cutoff AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM') AS period FROM test_data_reset_operations LIMIT 1`,
      );
      return result.rows[0];
    })();
    transactionOperations.set(tx, promise);
  }
  return promise;
}

export function resetLinkSignature(productId: string, links: ReadonlyMap<string, string>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...links]
          .filter(([, id]) => id === productId)
          .map(([id]) => id)
          .sort(),
      ),
    )
    .digest('hex');
}

/** Fail closed for old months, missing/incomplete baselines and changed product mappings. */
export async function resetSaleBoundary(
  tx: Transaction,
  input: {
    storeId: string;
    productId: string;
    period: string;
    type: string;
    observed: bigint;
    generatedAt: string;
    links: ReadonlyMap<string, string>;
  },
): Promise<{ allow: boolean; baseline?: bigint }> {
  const operation = await resetOperation(tx);
  if (!operation) return { allow: true };
  if (
    input.period < operation.period ||
    Date.parse(input.generatedAt) < new Date(operation.cutoff).getTime()
  )
    return { allow: false };
  const signature = resetLinkSignature(input.productId, input.links);
  const rows = await tx.execute<{
    status: string;
    link_signature: string;
    baseline_grams: string;
  }>(sql`
    SELECT status,link_signature,baseline_grams::text FROM test_data_reset_baselines
    WHERE store_id=${input.storeId} AND product_id=${input.productId} AND period=${input.period} AND revenue_type=${input.type} FOR UPDATE`);
  const existing = rows.rows[0];
  if (existing?.status === 'mapping_review') return { allow: false };
  if (existing?.status === 'ready') {
    if (existing.link_signature !== signature) {
      await tx.execute(sql`UPDATE test_data_reset_baselines SET status='mapping_review'
        WHERE store_id=${input.storeId} AND product_id=${input.productId} AND period=${input.period} AND revenue_type=${input.type}`);
      return { allow: false };
    }
    return { allow: true, baseline: BigInt(existing.baseline_grams) };
  }
  if (![...input.links.values()].includes(input.productId)) return { allow: false };
  // A later month can start at zero only for an already-established mapping. A new product
  // starts from its first complete cumulative observation, leaving an explicitly reported gap.
  const prior =
    await tx.execute(sql`SELECT 1 FROM test_data_reset_baselines WHERE store_id=${input.storeId}
    AND product_id=${input.productId} AND revenue_type=${input.type} AND period<${input.period}
    AND status='ready' AND link_signature=${signature} LIMIT 1`);
  const baseline = input.period > operation.period && prior.rows.length ? 0n : input.observed;
  await tx.execute(sql`INSERT INTO test_data_reset_baselines(store_id,product_id,period,revenue_type,link_signature,status,baseline_grams,established_at)
    VALUES(${input.storeId},${input.productId},${input.period},${input.type},${signature},'ready',${baseline.toString()},${input.generatedAt}::timestamptz)
    ON CONFLICT(store_id,product_id,period,revenue_type) DO UPDATE SET status='ready',link_signature=excluded.link_signature,baseline_grams=excluded.baseline_grams,established_at=excluded.established_at`);
  return { allow: true, baseline };
}

export async function resetAllowsSettlement(
  tx: Transaction,
  storeId: string,
  productId: string,
  period: string,
  type: string,
): Promise<boolean> {
  if (!(await resetOperation(tx))) return true;
  const result = await tx.execute<{
    allowed: boolean;
  }>(sql`SELECT NOT EXISTS(SELECT 1 FROM test_data_reset_operations) OR EXISTS(
    SELECT 1 FROM test_data_reset_baselines b WHERE b.store_id=${storeId} AND b.product_id=${productId}
    AND b.period=${period} AND b.revenue_type=${type} AND b.status='ready') AS allowed`);
  return result.rows[0]?.allowed === true;
}
