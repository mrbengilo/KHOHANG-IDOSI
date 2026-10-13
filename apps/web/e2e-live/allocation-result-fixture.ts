import { randomUUID } from 'node:crypto';

import { expect, type Page } from '@playwright/test';
import {
  allocationLines,
  allocationRuns,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrders,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  outboundRequestLines,
  outboundRequests,
  publishAllocationDecisionsInTransaction,
  reservations,
  warehouseBalances,
  withSerializableTransaction,
  applyWarehouseMovement,
  type Database,
} from '@idosi/database';
import { eq, inArray } from 'drizzle-orm';

/* Shared live fixtures: what the 09:00 run persists for one store, sign-in, and balances. */

export async function signIn(page: Page, login: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập').fill(login.username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(login.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function balance(db: Database, productId: string) {
  const [row] = await db
    .select()
    .from(warehouseBalances)
    .where(eq(warehouseBalances.productId, productId));
  return { onHand: row!.onHandQuantity, reserved: row!.reservedQuantity };
}

/** Persists exactly what the 09:00 run writes for one store: lines, holds, decision, shipment. */
export async function publishResult(
  db: Database,
  input: {
    storeId: string;
    adminId: string;
    grants: readonly { productId: string; quantity: number }[];
    shipment: boolean;
    carry?: readonly string[];
  },
) {
  const token = randomUUID().replaceAll('-', '');
  const now = new Date();
  // The schedule must fall on the Asia/Ho_Chi_Minh business date, as real sessions do.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
  const [session] = await db
    .insert(orderSessions)
    .values({
      code: `E2E-DEC-${token}`,
      kind: 'manual',
      businessDate: date,
      status: 'completed',
      openedAt: new Date(`${date}T00:00:00+07:00`),
      inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
      requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
    })
    .returning();
  const [snapshot] = await db
    .insert(inventorySnapshots)
    .values({
      orderSessionId: session!.id,
      businessDate: date,
      snapshotType: 'manual',
      status: 'completed',
      capturedAt: now,
      completedAt: now,
      balanceVersion: 0,
    })
    .returning();
  const [run] = await db
    .insert(allocationRuns)
    .values({
      orderSessionId: session!.id,
      inventorySnapshotId: snapshot!.id,
      runNumber: 1,
      status: 'running',
      policyVersion: 'idosi-round-robin-p0a-p3-v1',
      idempotencyKey: randomUUID(),
    })
    .returning();
  const [order] = await db
    .insert(orderRequests)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      requestNumber: 1,
      status: 'allocated',
      submittedAt: now,
      requestedByUserId: input.adminId,
    })
    .returning();
  const [merged] = await db
    .insert(mergedOrders)
    .values({
      orderSessionId: session!.id,
      storeId: input.storeId,
      status: 'allocated',
      requestCount: 1,
    })
    .returning();
  const reservationIds: string[] = [];
  const lineIds: string[] = [];
  for (const [index, grant] of input.grants.entries()) {
    const [item] = await db
      .insert(orderRequestItems)
      .values({
        orderRequestId: order!.id,
        productId: grant.productId,
        requestedQuantity: grant.quantity,
      })
      .returning();
    const [mergedItem] = await db
      .insert(mergedOrderItems)
      .values({
        mergedOrderId: merged!.id,
        productId: grant.productId,
        requestedQuantity: grant.quantity,
        priorityLevel: 'P1',
      })
      .returning();
    await db.insert(mergedOrderSources).values({
      mergedOrderItemId: mergedItem!.id,
      orderRequestItemId: item!.id,
      requestedQuantity: grant.quantity,
    });
    const [line] = await db
      .insert(allocationLines)
      .values({
        allocationRunId: run!.id,
        mergedOrderId: merged!.id,
        storeId: input.storeId,
        productId: grant.productId,
        orderRequestItemId: item!.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        sequenceInRound: index + 1,
        requestedQuantity: grant.quantity,
        allocatedQuantity: grant.quantity,
        status: 'allocated',
        reasonCode: 'LIVE_E2E_DECISION',
      })
      .returning();
    lineIds.push(line!.id);
    const [reservation] = await db
      .insert(reservations)
      .values({
        productId: grant.productId,
        storeId: input.storeId,
        allocationLineId: line!.id,
        quantity: grant.quantity,
      })
      .returning();
    reservationIds.push(reservation!.id);
    await withSerializableTransaction(db, (tx) =>
      applyWarehouseMovement(tx, {
        productId: grant.productId,
        eventType: 'reservation',
        onHandDelta: 0,
        reservedDelta: grant.quantity,
        sourceType: 'allocation_run',
        sourceId: run!.id,
        eventSequence: index + 1,
      }),
    );
  }
  const [decision] = await withSerializableTransaction(db, (tx) =>
    publishAllocationDecisionsInTransaction(tx, {
      allocationRunId: run!.id,
      orderSessionId: session!.id,
      publishedAt: now,
    }),
  );
  if (input.shipment) {
    const [outbound] = await db
      .insert(outboundRequests)
      .values({
        requestNumber: '',
        storeId: input.storeId,
        orderSessionId: session!.id,
        allocationRunId: run!.id,
        status: 'reserved',
        requestedByUserId: input.adminId,
        submittedAt: now,
        approvedAt: now,
      })
      .returning();
    const carried = input.carry?.length
      ? await db
          .select()
          .from(reservations)
          .where(inArray(reservations.id, [...input.carry]))
      : [];
    const rows = [
      ...input.grants.map((grant, index) => ({
        productId: grant.productId,
        quantity: grant.quantity,
        lineId: lineIds[index]!,
        reservationId: reservationIds[index]!,
      })),
      ...carried.map((row) => ({
        productId: row.productId,
        quantity: row.quantity,
        lineId: row.allocationLineId!,
        reservationId: row.id,
      })),
    ];
    for (const productId of new Set(rows.map((row) => row.productId))) {
      const sources = rows.filter((row) => row.productId === productId);
      const quantity = sources.reduce((total, row) => total + row.quantity, 0);
      const [outboundLine] = await db
        .insert(outboundRequestLines)
        .values({
          outboundRequestId: outbound!.id,
          productId,
          allocationLineId: sources[0]!.lineId,
          requestedQuantity: quantity,
          approvedQuantity: quantity,
          reservedQuantity: quantity,
        })
        .returning();
      await db
        .update(reservations)
        .set({ outboundRequestLineId: outboundLine!.id })
        .where(
          inArray(
            reservations.id,
            sources.map((row) => row.reservationId),
          ),
        );
    }
  }
  await db
    .update(allocationRuns)
    .set({ status: 'completed' })
    .where(eq(allocationRuns.id, run!.id));
  return { decisionId: decision!.id, reservationIds };
}
