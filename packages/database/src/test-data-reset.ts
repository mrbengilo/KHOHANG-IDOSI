import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdosiOrderStatisticsPayloadSchema } from '@idosi/contracts';
import { idosiProductSaleGrams, idosiItemsForProduct } from './store-sale-sync.js';
import { idosiNormalSaleGrams } from './store-normal-sale-sync.js';
import { resetLinkSignature } from './reset-sale-boundary.js';

/** Reviewed PostgreSQL 17 catalog built by migrations 0000..0037 in the isolated fixture. */
export const EXPECTED_RESET_SCHEMA_HASH =
  'a7d5123b6d10678e2b906d46c7ad5eb59d3d77b87b98f2161a877e7aa80b781c';

/** Only this reviewed set can ever be passed to TRUNCATE. No SQL comes from a manifest. */
export const RESET_PURGE_TABLES = [
  'order_sessions',
  'order_requests',
  'order_request_items',
  'merged_orders',
  'merged_order_items',
  'merged_order_sources',
  'wait_tickets',
  'daily_priority_offers',
  'inventory_snapshots',
  'inventory_snapshot_items',
  'allocation_runs',
  'allocation_lines',
  'reservations',
  'outbound_requests',
  'outbound_request_lines',
  'outbound_bag_picks',
  'receipts',
  'receipt_items',
  'receipt_bag_weights',
  'receipt_costs',
  'store_receipts',
  'store_receipt_lines',
  'store_receipt_bags',
  'warehouse_shortage_checks',
  'store_receipt_adjustments',
  'store_receipt_adjustment_lines',
  'receipt_shortage_entitlements',
  'store_receipt_returns',
  'store_inventory_bags',
  'store_inventory_ledger_entries',
  'warehouse_ledger_entries',
  'warehouse_stock_adjustments',
  'store_outbounds',
  'store_transfers',
  'store_partner_inbounds',
  'store_partner_inbound_lines',
  'store_partner_inbound_bags',
  'store_sorted_stocks',
  'store_sorting_events',
  'sorted_sale_transfers',
  'store_charity_exports',
  'idempotency_keys',
  'worker_heartbeats',
] as const;
export const RESET_KEEP_TABLES = [
  'users',
  'sessions',
  'htkd_assignments',
  'stores',
  'store_groups',
  'products',
  'product_conversions',
  'idosi_product_links',
  'operational_settings_versions',
  'idosi_statistics_snapshots',
  'idosi_statistics_sync_attempts',
  'document_code_counters',
  'store_inventory_bag_code_counters',
] as const;
const REBASE = ['warehouse_balances', 'store_sale_sync_progress', 'store_normal_sale_progress'];
const INTERNAL = [
  'test_data_reset_operations',
  'test_data_reset_baselines',
  'test_data_reset_replay_keys',
];
export type ResetAction = 'KEEP' | 'PURGE' | 'REBASE' | 'REVIEW' | 'SELECTIVE';
export function resetAction(schema: string, table: string): ResetAction {
  if (schema === 'drizzle' && table === '__drizzle_migrations') return 'KEEP';
  if (schema !== 'public') return 'REVIEW';
  if ((RESET_KEEP_TABLES as readonly string[]).includes(table)) return 'KEEP';
  if (INTERNAL.includes(table)) return 'REBASE';
  if ((RESET_PURGE_TABLES as readonly string[]).includes(table)) return 'PURGE';
  if (REBASE.includes(table)) return 'REBASE';
  if (table === 'audit_logs') return 'SELECTIVE';
  return 'REVIEW';
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(',')}}`;
}
export function resetHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function qualified(schema: string, name: string): string {
  return `${identifier(schema)}.${identifier(name)}`;
}

export interface ResetContext {
  host: string;
  project: string;
  release: string;
  operationId: string;
  cutoff: string;
  /** A separately reviewed structural fingerprint from migrated fixture DB. */
  expectedSchemaHash: string;
  /** Digest of an independently reviewed inventory, not a claim that unknown copies are absent. */
  inventoryHash: string;
  /**
   * `purge` (default, original procedure): inventoried test backups are purged after a clean
   * backup is proven. `retain`: every inventoried backup is kept as a recovery copy, a verified
   * pre-reset backup is required, and the operation finishes with BACKUPS_RETAINED.
   */
  backupRetention?: ResetBackupRetention;
}
export type ResetBackupRetention = 'purge' | 'retain';
/** Phases after which another, newer reset operation may start. */
export const RESET_TERMINAL_PHASE = 'COMPLETE';
export interface ResetTable {
  schema: string;
  name: string;
  kind: string;
  action: ResetAction;
  count: string;
  fingerprint: string;
  expectedCount: string;
}
export interface ResetManifest {
  version: 1;
  context: ResetContext;
  identity: Record<string, unknown>;
  schemaHash: string;
  securityHash: string;
  keptAudit: { count: number; fingerprint: string };
  catalog: unknown[];
  tables: ResetTable[];
  review: string[];
  hash: string;
}

// Payload-bearing audit rows are classified by exact action/entity and structural payload keys.
// Unknown/mixed rows block apply; there is no permissive "keep everything else" rule.
const AUDIT_KEEP_ENTITIES = new Set([
  'test_data_reset_operation',
  'user',
  'product',
  'product_conversion',
  'idosi_product_link',
  'store',
  'store_group',
  'operational_settings_version',
  'idosi_statistics_snapshot',
  'idosi_statistics_sync_attempt',
]);
const AUDIT_KEEP_ACTIONS = new Set([
  // The maintenance log of an earlier reset is kept by every later one.
  'TEST_DATA_RESET',
  'ACCOUNT_CREATED',
  'ACCOUNT_UPDATED',
  'ACCOUNT_STATUS_UPDATED',
  'ACCOUNT_PASSWORD_RESET',
  'HTKD_ASSIGNMENTS_REPLACED',
  'STORE_CREATED',
  'STORE_UPDATED',
  'STORE_GROUP_CREATED',
  'STORE_GROUP_UPDATED',
  'IDOSI_PRODUCT_LINK_CREATED',
  'IDOSI_PRODUCT_LINK_CHANGED',
  'PRODUCT_DISPLAY_NAME_UPDATED',
  'PRODUCT_CONVERSION_CREATED',
  'PRODUCT_CONVERSION_APPENDED',
  'PRODUCT_CONVERSION_REPLACED',
  'PRODUCT_CONVERSION_RETIRED',
  'OPERATIONAL_POLICY_REPAIRED',
  'OPERATIONAL_POLICY_DEFAULT_UPGRADED',
  'OPERATIONAL_SETTINGS_VERSION_CREATED',
  'IDOSI_STATISTICS_SYNC_SUCCEEDED',
  'IDOSI_STATISTICS_SYNC_FAILED',
]);
const AUDIT_PURGE_ENTITIES = new Set([
  ...RESET_PURGE_TABLES.map((t) => t.replace(/s$/, '')),
  'priority_offer',
  'supplier_inbound_receipt',
  'inventory_snapshot',
  'allocation_run',
]);
const PAYLOAD_DENY_KEYS =
  /^(order|receipt|outbound|allocation|reservation|bag|stock|ledger|transfer|entitlement)(Id|Ids|Code|Lines|Quantity|WeightKg)?$/i;
function hasBusinessPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => PAYLOAD_DENY_KEYS.test(k) || hasBusinessPayload(v));
}
export function classifyResetAudit(row: {
  action: string;
  entity_type: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
}): ResetAction {
  if (AUDIT_PURGE_ENTITIES.has(row.entity_type)) return 'PURGE';
  if (
    AUDIT_KEEP_ENTITIES.has(row.entity_type) &&
    AUDIT_KEEP_ACTIONS.has(row.action) &&
    !hasBusinessPayload([row.before, row.after, row.metadata])
  )
    return 'KEEP';
  return 'REVIEW';
}

export async function resetCatalog(client: PoolClient): Promise<unknown[]> {
  const result = await client.query(`
    SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relispartition,
      (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
      (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true),pg_get_functiondef(t.tgfoid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
      (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes,
      CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END AS view
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      AND c.relkind IN ('r','p','v','m','f') ORDER BY n.nspname,c.relname`);
  return result.rows;
}

/** The running operation's own maintenance log row is written by apply; it is not pre-existing. */
async function keptAuditDigest(client: PoolClient, operationId: string) {
  const result = await client.query('SELECT to_jsonb(a) AS row FROM public.audit_logs a');
  const hashes = result.rows
    .map(({ row }) => row)
    .filter((row) => classifyResetAudit(row) === 'KEEP')
    .filter(
      (row) => !(row.entity_type === 'test_data_reset_operation' && row.entity_id === operationId),
    )
    .map((row) => resetHash(row))
    .sort();
  return { count: hashes.length, fingerprint: resetHash(hashes) };
}

/** Read-only fingerprint for a named restore rehearsal. Its own database identity is retained. */
export async function inventoryDatabaseCopy(pool: Pool): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const catalog = await resetCatalog(client);
    const tables = [];
    for (const table of catalog as { schema: string; name: string; kind: string }[]) {
      if (table.kind !== 'r') throw new Error('Restore copy has an unreviewed relation');
      tables.push({ ...table, ...(await tableDigest(client, table.schema, table.name)) });
    }
    const result = { identity: await identity(client), schemaHash: resetHash(catalog), tables };
    await client.query('COMMIT');
    return { ...result, hash: resetHash(result) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function tableDigest(
  client: PoolClient,
  schema: string,
  name: string,
): Promise<{ count: string; fingerprint: string }> {
  const result = await client.query(
    `SELECT count(*)::text AS count,encode(sha256(convert_to(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS fingerprint FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash FROM ${qualified(schema, name)} t) s`,
  );
  return result.rows[0];
}
async function identity(client: PoolClient): Promise<Record<string, unknown>> {
  const result =
    await client.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,
    current_user AS role,current_setting('server_version') AS server_version`);
  return result.rows[0];
}
async function securityHash(client: PoolClient): Promise<string> {
  const tables =
    await client.query(`SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' ORDER BY 1,2,3`);
  const policies = await client.query(
    'SELECT * FROM pg_policies ORDER BY schemaname,tablename,policyname',
  );
  const extensions = await client.query(
    'SELECT extname,extversion FROM pg_extension ORDER BY extname',
  );
  return resetHash({ tables: tables.rows, policies: policies.rows, extensions: extensions.rows });
}
function validateContext(context: ResetContext) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(context.operationId))
    throw new Error('Invalid operation ID');
  if (!/^[\da-f]{40}$/.test(context.release)) throw new Error('Release must be a full SHA');
  if (
    !/^[\da-f]{64}$/.test(context.inventoryHash) ||
    !/^[\da-f]{64}$/.test(context.expectedSchemaHash)
  )
    throw new Error('Expected schema and inventory digests required');
  if (!context.host || !context.project || !Number.isFinite(Date.parse(context.cutoff)))
    throw new Error('Explicit environment and cutoff required');
  if (Date.parse(context.cutoff) > Date.now())
    throw new Error('Reset cutoff cannot be in the future');
  if (
    context.backupRetention !== undefined &&
    context.backupRetention !== 'purge' &&
    context.backupRetention !== 'retain'
  )
    throw new Error('backupRetention must be purge or retain');
}
/**
 * A new operation is allowed after earlier ones, but only one at a time and only forward in time:
 * every earlier operation must be COMPLETE and the new cutoff must be after the latest one. The
 * operation with the latest cutoff is the one in effect for epochs and sale baselines.
 */
async function previousOperationIssues(
  client: PoolClient,
  context: ResetContext,
): Promise<string[]> {
  const previous = await client.query(
    `SELECT id::text,phase,cutoff FROM public.test_data_reset_operations
    WHERE id<>$1 ORDER BY cutoff DESC,committed_at DESC,id DESC`,
    [context.operationId],
  );
  const issues: string[] = [];
  for (const row of previous.rows)
    if (row.phase !== RESET_TERMINAL_PHASE)
      issues.push(
        `Previous reset operation ${row.id} is ${row.phase}, not ${RESET_TERMINAL_PHASE}`,
      );
  const latest = previous.rows[0];
  if (latest && new Date(latest.cutoff).getTime() >= Date.parse(context.cutoff))
    issues.push(`Cutoff must be after previous reset operation ${latest.id}`);
  return issues;
}
async function hasOtherWriters(client: PoolClient): Promise<boolean> {
  // Concurrent invocations can wait on our exact maintenance lock; they inspect the committed
  // operation journal after acquiring it. Ordinary idle or active app clients still block reset.
  return Boolean(
    (
      await client.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND backend_type='client backend'
    AND NOT(application_name='idosi-test-reset' AND wait_event_type='Lock' AND wait_event='advisory'
      AND query=$1)`,
        ["SELECT pg_advisory_xact_lock(hashtextextended('idosi-one-shot-test-reset',0))"],
      )
    ).rowCount,
  );
}
async function planInTransaction(
  client: PoolClient,
  context: ResetContext,
): Promise<ResetManifest> {
  validateContext(context);
  const catalog = await resetCatalog(client);
  const schemaHash = resetHash(catalog);
  const review: string[] = [];
  if (schemaHash !== context.expectedSchemaHash)
    review.push('Schema differs from reviewed fixture');
  const tables: ResetTable[] = [];
  for (const item of catalog as {
    schema: string;
    name: string;
    kind: string;
    relispartition: boolean;
  }[]) {
    let action = resetAction(item.schema, item.name);
    if (item.kind !== 'r' || item.relispartition) action = 'REVIEW';
    if (action === 'REVIEW') review.push(`Unreviewed relation ${item.schema}.${item.name}`);
    const digest = await tableDigest(client, item.schema, item.name);
    tables.push({
      ...item,
      action,
      ...digest,
      expectedCount:
        action === 'PURGE' ? '0' : action === 'KEEP' ? digest.count : 'verified-by-invariant',
    });
  }
  const expected = [
    ...RESET_KEEP_TABLES,
    ...RESET_PURGE_TABLES,
    ...REBASE,
    ...INTERNAL,
    'audit_logs',
  ];
  for (const name of expected)
    if (!tables.some((t) => t.schema === 'public' && t.name === name))
      review.push(`Missing table ${name}`);
  const audit = await client.query(
    'SELECT id,action,entity_type,before,after,metadata FROM public.audit_logs',
  );
  for (const row of audit.rows)
    if (classifyResetAudit(row) === 'REVIEW')
      review.push(`Audit requires payload review: ${row.id}`);
  review.push(...(await previousOperationIssues(client, context)));
  const data = {
    version: 1 as const,
    context,
    identity: await identity(client),
    schemaHash,
    securityHash: await securityHash(client),
    keptAudit: await keptAuditDigest(client, context.operationId),
    catalog,
    tables,
    review,
  };
  return { ...data, hash: resetHash(data) };
}
export async function planTestDataReset(pool: Pool, context: ResetContext): Promise<ResetManifest> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const plan = await planInTransaction(client, context);
    await client.query('COMMIT');
    return plan;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function applyTestDataReset(
  pool: Pool,
  manifest: ResetManifest,
  confirmation: string,
): Promise<Record<string, unknown>> {
  validateContext(manifest.context);
  const { hash, ...body } = manifest;
  if (confirmation !== hash || resetHash(body) !== hash || manifest.review.length)
    throw new Error('Manifest is unconfirmed, changed, or requires review');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'");
    if (resetHash(await identity(client)) !== resetHash(manifest.identity))
      throw new Error('Wrong database or cluster');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('idosi-one-shot-test-reset',0))",
    );
    const previous = await client.query(
      'SELECT * FROM public.test_data_reset_operations WHERE id=$1',
      [manifest.context.operationId],
    );
    if (previous.rowCount) {
      if (previous.rows[0].manifest_hash !== hash)
        throw new Error('Operation ID already belongs to another manifest');
      await client.query('COMMIT');
      return { resumed: true, phase: previous.rows[0].phase };
    }
    // A repeated reset is a new, explicitly reviewed operation. Its own manifest already carries
    // these checks (the plan reports them for review); they are re-asserted under the lock.
    const previousIssues = await previousOperationIssues(client, manifest.context);
    if (previousIssues.length) throw new Error(previousIssues.join('; '));
    // An advisory lock alone cannot exclude ordinary app writers. Maintenance must remove all
    // other database connections before this transaction, and all relations are locked here.
    if (await hasOtherWriters(client))
      throw new Error('Database still has other clients; stop and drain writers');
    const locks = manifest.tables
      .filter((t) => t.kind === 'r')
      .map((t) => qualified(t.schema, t.name));
    await client.query(`LOCK TABLE ${locks.join(',')} IN ACCESS EXCLUSIVE MODE`);
    const current = await planInTransaction(client, manifest.context);
    if (current.hash !== hash)
      throw new Error(
        'Manifest stale: environment, schema, counts, or source fingerprints changed',
      );
    const removed = [...RESET_PURGE_TABLES, ...REBASE];
    // Keep only irreversible digests, never old response bodies, resource IDs or request data.
    await client.query(
      "INSERT INTO public.test_data_reset_replay_keys(key_hash) SELECT DISTINCT encode(sha256(convert_to(key,'UTF8')),'hex') FROM public.idempotency_keys ON CONFLICT DO NOTHING",
    );
    // PostgreSQL enforces the complete FK closure; deliberately no CASCADE or trigger bypass.
    await client.query(`TRUNCATE TABLE ${removed.map((t) => qualified('public', t)).join(',')}`);
    await client.query(
      'INSERT INTO public.warehouse_balances(product_id) SELECT id FROM public.products',
    );
    const audit = await client.query(
      'SELECT id,action,entity_type,before,after,metadata FROM public.audit_logs',
    );
    const purgeIds = audit.rows
      .filter((row) => classifyResetAudit(row) === 'PURGE')
      .map((row) => row.id as string);
    // The sole scoped exception to append-only audit. Both ALTERs are transactional.
    await client.query('ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_immutable');
    await client.query('DELETE FROM public.audit_logs WHERE id=ANY($1::uuid[])', [purgeIds]);
    await client.query('ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_immutable');
    await client.query(
      `INSERT INTO public.test_data_reset_operations(id,manifest_hash,cutoff,phase,evidence)
      VALUES($1,$2,$3,'DATABASE_COMMITTED',$4)`,
      [
        manifest.context.operationId,
        hash,
        manifest.context.cutoff,
        JSON.stringify({
          schemaHash: manifest.schemaHash,
          inventoryHash: manifest.context.inventoryHash,
          backupRetention: manifest.context.backupRetention ?? 'purge',
        }),
      ],
    );
    // Baselines belong to the operation in effect. A newer operation rebases every one of them on
    // its own cutoff; the source snapshots they were derived from stay untouched.
    await client.query('DELETE FROM public.test_data_reset_baselines');
    // Reconciliation establishes baselines from the next usable full-month source; with missing
    // or stale snapshots this deliberately records an unmeasured interval instead of guessing 0.
    await client.query(
      `INSERT INTO public.test_data_reset_baselines(store_id,product_id,period,revenue_type,link_signature,status,baseline_grams)
      SELECT s.id,p.id,to_char($1::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM'),r.type,'','pending',0
      FROM public.stores s CROSS JOIN public.products p CROSS JOIN (VALUES('normal'),('sale_kg'),('sale_piece')) r(type)`,
      [manifest.context.cutoff],
    );
    await rebaseResetSnapshots(client, manifest.context.cutoff);
    await client.query(
      `INSERT INTO public.audit_logs(action,entity_type,entity_id,metadata)
      VALUES('TEST_DATA_RESET','test_data_reset_operation',$1,$2)`,
      [manifest.context.operationId, JSON.stringify({ manifestHash: hash })],
    );
    for (const table of manifest.tables.filter(
      (t) => t.action === 'KEEP' && !INTERNAL.includes(t.name),
    )) {
      const after = await tableDigest(client, table.schema, table.name);
      if (after.fingerprint !== table.fingerprint || after.count !== table.count)
        throw new Error(`Protected data changed: ${table.name}`);
    }
    for (const name of RESET_PURGE_TABLES) {
      if ((await tableDigest(client, 'public', name)).count !== '0')
        throw new Error(`Nonempty purge table: ${name}`);
    }
    if (resetHash(await resetCatalog(client)) !== manifest.schemaHash)
      throw new Error('Schema protections changed');
    if ((await securityHash(client)) !== manifest.securityHash)
      throw new Error('Database grants, policies or extensions changed');
    if (
      resetHash(await keptAuditDigest(client, manifest.context.operationId)) !==
      resetHash(manifest.keptAudit)
    )
      throw new Error('Protected audit changed');
    if (await hasOtherWriters(client)) throw new Error('A writer connected during maintenance');
    await client.query('COMMIT');
    return {
      resumed: false,
      phase: 'DATABASE_COMMITTED',
      operationId: manifest.context.operationId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function assertResetManifest(manifest: ResetManifest): void {
  const { hash, ...body } = manifest;
  validateContext(manifest.context);
  if (resetHash(body) !== hash || manifest.review.length)
    throw new Error('Manifest contents changed or require review');
}

/** Run while writers remain stopped. A completed verification is never a new purge. */
export async function verifyTestDataReset(
  pool: Pool,
  manifest: ResetManifest,
  restore = false,
): Promise<Record<string, unknown>> {
  assertResetManifest(manifest);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'");
    // Lock before reading digests so an unmanaged writer cannot commit behind a stale snapshot.
    // All classified relations remain stable through verification and its journal update.
    const locks = manifest.tables
      .filter((t) => t.kind === 'r')
      .map((t) => qualified(t.schema, t.name));
    await client.query(`LOCK TABLE ${locks.join(',')} IN ACCESS EXCLUSIVE MODE`);
    if (await hasOtherWriters(client))
      throw new Error('Database still has other clients; stop and drain writers');
    const operation = await client.query(
      'SELECT * FROM test_data_reset_operations WHERE id=$1 FOR UPDATE',
      [manifest.context.operationId],
    );
    if (operation.rows[0]?.manifest_hash !== manifest.hash)
      throw new Error('Reset operation not found or manifest differs');
    if (!restore && resetHash(await identity(client)) !== resetHash(manifest.identity))
      throw new Error('Wrong verification database');
    if (restore && (await identity(client)).database === manifest.identity.database)
      throw new Error('Restore verification must use an isolated database');
    if (resetHash(await resetCatalog(client)) !== manifest.schemaHash)
      throw new Error('Schema changed during reset');
    if ((await securityHash(client)) !== manifest.securityHash)
      throw new Error('Database security changed during reset/restore');
    if (
      resetHash(await keptAuditDigest(client, manifest.context.operationId)) !==
      resetHash(manifest.keptAudit)
    )
      throw new Error('Protected audit verification failed');
    const evidence: Record<string, unknown> = {};
    for (const table of manifest.tables.filter(
      (t) => t.action === 'KEEP' && !INTERNAL.includes(t.name),
    )) {
      const digest = await tableDigest(client, table.schema, table.name);
      if (digest.fingerprint !== table.fingerprint || digest.count !== table.count)
        throw new Error(`Protected data verification failed: ${table.name}`);
      evidence[table.name] = { count: digest.count, match: true };
    }
    for (const table of RESET_PURGE_TABLES)
      if ((await tableDigest(client, 'public', table)).count !== '0')
        throw new Error(`Reset contains transactions: ${table}`);
    if (
      (
        await client.query(
          'SELECT 1 FROM warehouse_balances WHERE on_hand_quantity<>0 OR reserved_quantity<>0 OR available_quantity<>0',
        )
      ).rowCount
    )
      throw new Error('Nonzero inventory after reset');
    if (
      (
        await client.query(
          'SELECT 1 FROM store_sale_sync_progress WHERE applied_grams<>0 UNION ALL SELECT 1 FROM store_normal_sale_progress WHERE applied_grams<>0',
        )
      ).rowCount
    )
      throw new Error('Old stock applications remain');
    if (!restore)
      await client.query(
        "UPDATE test_data_reset_operations SET phase='VERIFIED',evidence=evidence||$2::jsonb,updated_at=now() WHERE id=$1 AND phase='DATABASE_COMMITTED'",
        [manifest.context.operationId, JSON.stringify({ verification: evidence })],
      );
    if (await hasOtherWriters(client)) throw new Error('A writer connected during verification');
    await client.query('COMMIT');
    return { state: restore ? 'CLEAN_RESTORE_VERIFIED' : 'VERIFIED', protected: evidence };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rebaseResetSnapshots(client: PoolClient, cutoff: string): Promise<void> {
  const period = new Date(Date.parse(cutoff) + 7 * 3600000).toISOString().slice(0, 7);
  const snapshots = await client.query(
    `SELECT id,store_id,payload,source_generated_at FROM public.idosi_statistics_snapshots
    WHERE period=$1 AND filter_date IS NULL AND shift_id IS NULL AND payment_method IS NULL AND scope_key=$2`,
    [period, JSON.stringify([period, null, null, null])],
  );
  const catalog = await client.query('SELECT id,name FROM public.products');
  const linkRows = await client.query(
    'SELECT idosi_product_id,product_id FROM public.idosi_product_links',
  );
  const links = new Map<string, string>(
    linkRows.rows.map((row) => [row.idosi_product_id, row.product_id]),
  );
  for (const snapshot of snapshots.rows) {
    const parsed = IdosiOrderStatisticsPayloadSchema.safeParse(snapshot.payload);
    if (
      !parsed.success ||
      parsed.data.filters.period !== period ||
      parsed.data.filters.date ||
      parsed.data.filters.shiftId ||
      parsed.data.filters.paymentMethod
    )
      continue;
    // Sources accumulated before cutoff are retained verbatim; their source time is recorded so
    // the operator can see the interval between the latest observation and the maintenance cut.
    if (new Date(snapshot.source_generated_at).getTime() > Date.parse(cutoff))
      throw new Error('Snapshot is newer than cutoff; replan');
    if (new Date(snapshot.source_generated_at).getTime() < Date.parse(cutoff)) continue;
    for (const product of catalog.rows) {
      const match = { productId: product.id as string, links };
      if (!idosiItemsForProduct(parsed.data, product.name, match).length) continue;
      for (const type of ['normal', 'sale_kg', 'sale_piece'] as const) {
        const grams =
          type === 'normal'
            ? idosiNormalSaleGrams(parsed.data, product.name, match)
            : idosiProductSaleGrams(parsed.data, product.name, type, match);
        if (grams === null) continue;
        await client.query(
          `UPDATE public.test_data_reset_baselines SET link_signature=$1,status='ready',baseline_grams=$2,established_at=$3
          WHERE store_id=$4 AND product_id=$5 AND period=$6 AND revenue_type=$7`,
          [
            resetLinkSignature(product.id, links),
            grams.toString(),
            snapshot.source_generated_at,
            snapshot.store_id,
            product.id,
            period,
            type,
          ],
        );
        if (type === 'normal')
          await client.query(
            `INSERT INTO public.store_normal_sale_progress(store_id,product_id,period,baseline_grams,observed_grams,applied_grams,source_snapshot_id)
          VALUES($1,$2,$3,$4,$4,0,$5)`,
            [snapshot.store_id, product.id, period, grams.toString(), snapshot.id],
          );
        else
          await client.query(
            `INSERT INTO public.store_sale_sync_progress(store_id,product_id,period,sale_type,baseline_grams,observed_grams,applied_grams,source_snapshot_id)
          VALUES($1,$2,$3,$4,$5,$5,0,$6)`,
            [snapshot.store_id, product.id, period, type, grams.toString(), snapshot.id],
          );
      }
    }
  }
}
