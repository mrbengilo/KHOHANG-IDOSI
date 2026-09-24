import { randomUUID } from 'node:crypto';
import {
  allocationLines,
  allocationRuns,
  applyWarehouseMovement,
  createDatabase,
  dailyPriorityOffers,
  declareStoreReceipt,
  dispatchWarehouseOutboundRequest,
  finalizeStoreReceipt,
  inventorySnapshots,
  listHeldAllocationStock,
  listStoreReceiptSources,
  listWarehouseOutboundRequests,
  mergedOrders,
  mergedOrderItems,
  mergedOrderSources,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  reservations,
  resolveWarehouseShortageCheck,
  storeGroups,
  stores,
  submitStoreReceipt,
  users,
  waitTickets,
  warehouseBalances,
  warehouseShortageChecks,
  withSerializableTransaction,
} from '@idosi/database';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { materializeOutboundRequests } from '../src/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;
describePostgres('priority goods join the next ordinary shipment', () => {
  it.each([6, 2, 0])(
    'holds without an ordinary order, groups sources once and receives %i of 6 bags',
    async (received) => {
      const client = createDatabase({ connectionString: process.env.DATABASE_URL!, max: 4 });
      const db = client.db;
      const sessionIds: string[] = [];
      try {
        const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
        const [group] = await db.select().from(storeGroups).limit(1);
        if (!admin || !group) throw new Error('Bootstrap admin and reference seed required.');
        const token = randomUUID().replaceAll('-', '');
        const [store] = await db
          .insert(stores)
          .values({ code: `SHIP-${token}`, name: 'Shipment test', groupId: group.id })
          .returning();
        const [storeUser] = await db
          .insert(users)
          .values({
            email: `shipment.${token}`,
            displayName: 'Shipment test',
            passwordHash: admin.passwordHash,
            role: 'store',
            storeId: store!.id,
          })
          .returning();
        const [product] = await db
          .insert(products)
          .values({ sku: `SHIP-${token}`, slug: `ship-${token}`, name: 'Shipment product' })
          .returning();
        const now = new Date();
        const policyVersion = 'idosi-round-robin-p0a-p3-v1';
        const cycles = [];
        for (const offset of [-2, -1, 0]) {
          const date = new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10);
          const [session] = await db
            .insert(orderSessions)
            .values({
              code: `SHIP-${token}-${offset}`,
              businessDate: date,
              status: 'completed',
              inventorySnapshotDueAt: new Date(`${date}T08:00:00+07:00`),
              requestDeadlineAt: new Date(`${date}T09:00:00+07:00`),
              completedAt: now,
              policyVersion,
              createdByUserId: admin.id,
            })
            .returning();
          sessionIds.push(session!.id);
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
              status: 'completed',
              policyVersion,
              idempotencyKey: randomUUID(),
            })
            .returning();
          cycles.push({ session: session!, run: run! });
        }
        const sourceCycle = cycles[0]!;
        const priorityCycle = cycles[1]!;
        const nextCycle = cycles[2]!;
        const [oldOrder] = await db
          .insert(orderRequests)
          .values({
            orderSessionId: sourceCycle.session.id,
            storeId: store!.id,
            requestNumber: 1,
            status: 'allocated',
            submittedAt: now,
            requestedByUserId: admin.id,
          })
          .returning();
        const [oldItem] = await db
          .insert(orderRequestItems)
          .values({ orderRequestId: oldOrder!.id, productId: product!.id, requestedQuantity: 3 })
          .returning();
        const sourceIds: string[] = [];
        for (const [index, quantity] of [2, 1].entries()) {
          const [ticket] = await db
            .insert(waitTickets)
            .values({
              storeId: store!.id,
              productId: product!.id,
              sourceOrderRequestItemId: oldItem!.id,
              status: 'fulfilled',
              originalQuantity: quantity,
              remainingQuantity: 0,
              fulfilledQuantity: quantity,
            })
            .returning();
          const [offer] = await db
            .insert(dailyPriorityOffers)
            .values({
              businessDate: priorityCycle.session.businessDate,
              storeId: store!.id,
              productId: product!.id,
              waitTicketId: ticket!.id,
              priorityLevel: 'P0A',
              offeredQuantity: quantity,
              roundNumber: index + 1,
              acceptedQuantity: quantity,
              status: 'accepted',
              responseDeadlineAt: now,
              respondedAt: now,
            })
            .returning();
          const [line] = await db
            .insert(allocationLines)
            .values({
              allocationRunId: priorityCycle.run.id,
              storeId: store!.id,
              productId: product!.id,
              waitTicketId: ticket!.id,
              priorityOfferId: offer!.id,
              priorityLevel: 'P0A',
              roundNumber: 1,
              sequenceInRound: index + 1,
              requestedQuantity: quantity,
              allocatedQuantity: quantity,
              status: 'allocated',
              reasonCode: 'TEST_PRIORITY',
            })
            .returning();
          sourceIds.push(line!.id);
          await db.insert(reservations).values({
            allocationLineId: line!.id,
            storeId: store!.id,
            productId: product!.id,
            quantity,
            createdAt: new Date(now.getTime() - 2000 + index),
          });
        }
        const scheduled = (cycle: typeof nextCycle) => ({
          id: cycle.session.id,
          businessDate: cycle.session.businessDate,
          snapshotDueAt: cycle.session.inventorySnapshotDueAt,
          finalDueAt: cycle.session.requestDeadlineAt,
          policyVersion,
        });
        expect(
          await withSerializableTransaction(db, (tx) =>
            materializeOutboundRequests(tx, priorityCycle.run.id, scheduled(priorityCycle), now),
          ),
        ).toBe(0);
        expect(
          (
            await listWarehouseOutboundRequests(db, {
              page: 1,
              pageSize: 20,
              storeIds: [store!.id],
            })
          ).data,
        ).toHaveLength(0);
        const held = await db
          .select()
          .from(reservations)
          .where(eq(reservations.storeId, store!.id));
        expect(
          held.every((row) => row.status === 'active' && row.outboundRequestLineId === null),
        ).toBe(true);
        // Held goods are not silent: the store and its HTKD see them waiting for the next order.
        expect(await listHeldAllocationStock(db, { storeIds: [store!.id] })).toEqual([
          expect.objectContaining({ storeId: store!.id, productId: product!.id, heldQuantity: 3 }),
        ]);
        expect(await listHeldAllocationStock(db, { storeIds: [] })).toEqual([]);

        const [normal] = await db
          .insert(orderRequests)
          .values({
            orderSessionId: nextCycle.session.id,
            storeId: store!.id,
            requestNumber: 1,
            status: 'partially_allocated',
            submittedAt: now,
            requestedByUserId: admin.id,
          })
          .returning();
        const [normalItem] = await db
          .insert(orderRequestItems)
          .values({ orderRequestId: normal!.id, productId: product!.id, requestedQuantity: 3 })
          .returning();
        const [merged] = await db
          .insert(mergedOrders)
          .values({
            orderSessionId: nextCycle.session.id,
            storeId: store!.id,
            status: 'allocated',
            requestCount: 1,
          })
          .returning();
        const [mergedItem] = await db
          .insert(mergedOrderItems)
          .values({
            mergedOrderId: merged!.id,
            productId: product!.id,
            requestedQuantity: 3,
            priorityLevel: 'P1',
          })
          .returning();
        await db.insert(mergedOrderSources).values({
          mergedOrderItemId: mergedItem!.id,
          orderRequestItemId: normalItem!.id,
          requestedQuantity: 3,
        });
        const [normalLine] = await db
          .insert(allocationLines)
          .values({
            allocationRunId: nextCycle.run.id,
            mergedOrderId: merged!.id,
            storeId: store!.id,
            productId: product!.id,
            orderRequestItemId: normalItem!.id,
            priorityLevel: 'P1',
            roundNumber: 1,
            sequenceInRound: 1,
            requestedQuantity: 3,
            allocatedQuantity: 3,
            status: 'allocated',
            reasonCode: 'TEST_NORMAL',
          })
          .returning();
        sourceIds.push(normalLine!.id);
        await db.insert(reservations).values({
          allocationLineId: normalLine!.id,
          storeId: store!.id,
          productId: product!.id,
          quantity: 3,
          createdAt: now,
        });
        await db.transaction((tx) =>
          applyWarehouseMovement(tx, {
            productId: product!.id,
            eventType: 'opening_balance',
            onHandDelta: 10,
            reservedDelta: 6,
            sourceType: 'shipment_test',
            sourceId: randomUUID(),
            reason: 'Isolated grouped shipment fixture',
            occurredAt: now,
          }),
        );
        const calls = await Promise.all(
          [1, 2].map(() =>
            withSerializableTransaction(db, (tx) =>
              materializeOutboundRequests(tx, nextCycle.run.id, scheduled(nextCycle), now),
            ),
          ),
        );
        expect(calls.filter((value) => value > 0)).toHaveLength(1);
        const outbounds = await listWarehouseOutboundRequests(db, {
          page: 1,
          pageSize: 20,
          storeIds: [store!.id],
        });
        expect(outbounds.data).toHaveLength(1);
        const outbound = outbounds.data[0]!;
        expect(outbound.lines).toHaveLength(1);
        expect(outbound.lines[0]!.approvedQuantity).toBe(6);
        const linked = await db
          .select()
          .from(reservations)
          .where(eq(reservations.outboundRequestLineId, outbound.lines[0]!.id));
        expect(linked.map((row) => row.allocationLineId).sort()).toEqual(sourceIds.sort());
        // The grouped shipment is released by the run itself, once, even under a concurrent retry.
        expect(outbound).toMatchObject({
          status: 'dispatched',
          version: 1,
          dispatchedByUserId: null,
        });
        expect(outbound.lines[0]!.dispatchedQuantity).toBe(6);
        expect(await listHeldAllocationStock(db, { storeIds: [store!.id] })).toEqual([]);
        await expect(
          dispatchWarehouseOutboundRequest(db, {
            outboundRequestId: outbound.id,
            expectedVersion: 0,
            dispatchedByUserId: admin.id,
            dispatchedAt: now,
            idempotencyKey: randomUUID(),
            requestHash: randomUUID(),
          }),
        ).rejects.toThrow(/not ready for dispatch/);
        const sources = await listStoreReceiptSources(db, {
          page: 1,
          pageSize: 20,
          storeId: store!.id,
        });
        expect(sources.data.map((source) => source.id)).toEqual([outbound.id]);
        const [heldBalance] = await db
          .select()
          .from(warehouseBalances)
          .where(eq(warehouseBalances.productId, product!.id));
        // Releasing the shipment does not move stock; only the finalized receipt does.
        expect(heldBalance).toMatchObject({ onHandQuantity: 10, reservedQuantity: 6 });
        const receiptLines = [
          { productId: product!.id, approvedQuantity: 6, receivedQuantity: received },
        ];
        const discrepancyNote = received < 6 ? 'Thiếu bao trong chuyến giao gộp' : null;
        const declared = await declareStoreReceipt(db, {
          outboundRequestId: outbound.id,
          storeId: store!.id,
          declaredByUserId: storeUser!.id,
          lines: receiptLines,
          discrepancyNote,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        });
        if (declared.replayed) throw new Error('Unexpected declaration replay');
        await submitStoreReceipt(db, {
          receiptId: declared.value.receiptId,
          expectedVersion: 0,
          submittedByUserId: storeUser!.id,
          lines: receiptLines,
          discrepancyNote,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        });
        const finalInput = {
          receiptId: declared.value.receiptId,
          expectedVersion: 1,
          reviewedByUserId: admin.id,
          freightVnd: 0n,
          handlingVnd: 0n,
          lines: [
            {
              productId: product!.id,
              pricePerKgVnd: 1000n,
              bagWeightsKg: Array.from({ length: received }, () => '2.330'),
            },
          ],
          idempotencyKey: randomUUID(),
          requestHash: randomUUID(),
        };
        const final = await finalizeStoreReceipt(db, finalInput);
        if (final.replayed) throw new Error('Unexpected finalization replay');
        expect(final.value.inventoryBagIds).toHaveLength(received);
        expect((await finalizeStoreReceipt(db, finalInput)).replayed).toBe(true);
        const [balance] = await db
          .select()
          .from(warehouseBalances)
          .where(eq(warehouseBalances.productId, product!.id));
        // A reported shortage stays held until the warehouse confirms where the bags are.
        expect(balance).toMatchObject({
          onHandQuantity: 10 - received,
          reservedQuantity: 6 - received,
        });
        const checks = await db
          .select()
          .from(warehouseShortageChecks)
          .where(eq(warehouseShortageChecks.storeReceiptId, declared.value.receiptId));
        expect(checks.map((check) => check.quantity)).toEqual(received < 6 ? [6 - received] : []);
        if (checks[0]) {
          await resolveWarehouseShortageCheck(db, {
            checkId: checks[0].id,
            decision: 'returned_to_stock',
            reason: 'Kiểm kệ còn đủ bao',
            expectedVersion: 0,
            actorUserId: admin.id,
            idempotencyKey: randomUUID(),
            requestHash: randomUUID(),
          });
          const [released] = await db
            .select()
            .from(warehouseBalances)
            .where(eq(warehouseBalances.productId, product!.id));
          expect(released).toMatchObject({ onHandQuantity: 10 - received, reservedQuantity: 0 });
        }
        const waits = await db
          .select()
          .from(waitTickets)
          .where(and(eq(waitTickets.storeId, store!.id), eq(waitTickets.status, 'active')));
        expect(waits.reduce((total, row) => total + row.remainingQuantity, 0)).toBe(6 - received);
        expect(waits.length).toBe(received < 6 ? 1 : 0);
      } finally {
        for (const id of sessionIds)
          await db
            .update(orderSessions)
            .set({ deletedAt: new Date() })
            .where(eq(orderSessions.id, id));
        await client.close();
      }
    },
    30000,
  );
});
