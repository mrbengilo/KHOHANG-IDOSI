import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  db,
  outboundRequestLines,
  outboundRequests,
  products,
  storeInventoryBags,
  storeReceiptBags,
  storeReceiptLines,
  storeReceipts,
  stores,
  users,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('PostgreSQL wholesale receipt scope and discrepancies', () => {
  test('lists only assigned wholesale receipts and persists unexpected goods separately', async () => {
    const suffix = randomUUID();
    const [wholesaleStore] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.kind, 'wholesale'), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1);
    const [retailStore] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.kind, 'retail'), eq(stores.isActive, true), isNull(stores.deletedAt)))
      .limit(1);
    const catalog = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.isActive, true), isNull(products.deletedAt)))
      .limit(2);
    assert.ok(wholesaleStore && retailStore && catalog.length === 2);
    const [account] = await db
      .insert(users)
      .values({
        email: `receipt.wholesale.${suffix}@example.test`,
        displayName: 'Wholesale receipt test',
        passwordHash: `test-${suffix}`,
        role: 'wholesale',
        status: 'active',
      })
      .returning({ id: users.id });
    assert.ok(account);
    const actor = {
      accountId: account.id,
      assignedStoreIds: [wholesaleStore.id],
      displayName: 'Wholesale receipt test',
      role: 'WHOLESALE',
      status: 'ACTIVE',
      storeId: null,
      username: `receipt.wholesale.${suffix}@example.test`,
    };
    const repository = new PostgresWarehouseRepository();
    const receiptIds = [];
    const outboundIds = [];
    try {
      const addOutbound = async (storeId) => {
        const [outbound] = await db
          .insert(outboundRequests)
          .values({
            requestNumber: '',
            storeId,
            status: 'dispatched',
            requestedByUserId: account.id,
            dispatchedByUserId: account.id,
            dispatchedAt: new Date(),
          })
          .returning({ id: outboundRequests.id });
        assert.ok(outbound);
        outboundIds.push(outbound.id);
        const [line] = await db
          .insert(outboundRequestLines)
          .values({
            outboundRequestId: outbound.id,
            productId: catalog[0].id,
            requestedQuantity: 2,
            approvedQuantity: 2,
            reservedQuantity: 2,
            dispatchedQuantity: 2,
          })
          .returning({ id: outboundRequestLines.id });
        assert.ok(line);
        return { outboundId: outbound.id, lineId: line.id };
      };
      const wholesale = await addOutbound(wholesaleStore.id);
      const retail = await addOutbound(retailStore.id);
      const [retailReceipt] = await db
        .insert(storeReceipts)
        .values({
          receiptNumber: '',
          outboundRequestId: retail.outboundId,
          storeId: retailStore.id,
        })
        .returning({ id: storeReceipts.id });
      assert.ok(retailReceipt);
      receiptIds.push(retailReceipt.id);
      await db.insert(storeReceiptLines).values({
        storeReceiptId: retailReceipt.id,
        outboundRequestLineId: retail.lineId,
        productId: catalog[0].id,
        approvedQuantity: 2,
        receivedQuantity: 2,
      });

      const pendingBefore = await repository.listStoreReceiptSources(actor, {
        storeId: wholesaleStore.id,
        page: 1,
        pageSize: 100,
      });
      assert.ok(pendingBefore.data.some((source) => source.id === wholesale.outboundId));
      assert.ok(pendingBefore.data.every((source) => source.storeId === wholesaleStore.id));
      assert.equal(pendingBefore.pagination.totalItems, pendingBefore.data.length);
      await assert.rejects(
        repository.listStoreReceiptSources(actor, {
          storeId: retailStore.id,
          page: 1,
          pageSize: 100,
        }),
        (error) => error.statusCode === 403,
      );
      await assert.rejects(
        repository.declareStoreReceipt(
          actor,
          {
            storeId: retailStore.id,
            outboundRequestId: retail.outboundId,
            lines: [{ productId: catalog[0].id, approvedUnits: 2, receivedUnits: 2 }],
            discrepancyNote: null,
          },
          randomUUID(),
          randomUUID(),
          { requestId: randomUUID(), ipAddress: null, userAgent: null },
        ),
        (error) => error.statusCode === 403,
      );

      // Two tabs declaring the same shipment with different keys produce one receipt.
      const race = await Promise.allSettled(
        [1, 2].map(() =>
          repository.declareStoreReceipt(
            actor,
            {
              storeId: wholesaleStore.id,
              outboundRequestId: wholesale.outboundId,
              lines: [{ productId: catalog[0].id, approvedUnits: 2, receivedUnits: 2 }],
              unexpectedItems: [{ productId: catalog[1].id, quantity: 3 }],
              discrepancyNote: 'Dư ba bao mặt hàng khác',
            },
            randomUUID(),
            randomUUID(),
            { requestId: randomUUID(), ipAddress: null, userAgent: null },
          ),
        ),
      );
      const won = race.filter((result) => result.status === 'fulfilled');
      assert.equal(won.length, 1, JSON.stringify(race.map((result) => result.status)));
      const declared = won[0].value;
      const declaredRows = await db
        .select({ id: storeReceipts.id })
        .from(storeReceipts)
        .where(
          and(
            eq(storeReceipts.outboundRequestId, wholesale.outboundId),
            isNull(storeReceipts.deletedAt),
          ),
        );
      assert.equal(declaredRows.length, 1);
      const pendingAfter = await repository.listStoreReceiptSources(actor, {
        storeId: wholesaleStore.id,
        page: 1,
        pageSize: 100,
      });
      assert.ok(pendingAfter.data.every((source) => source.id !== wholesale.outboundId));
      const replayKey = randomUUID();
      const replayHash = randomUUID();
      const declaredAgain = await repository
        .declareStoreReceipt(
          actor,
          {
            storeId: wholesaleStore.id,
            outboundRequestId: wholesale.outboundId,
            lines: [{ productId: catalog[0].id, approvedUnits: 2, receivedUnits: 2 }],
            unexpectedItems: [{ productId: catalog[1].id, quantity: 3 }],
            discrepancyNote: 'Dư ba bao mặt hàng khác',
          },
          replayKey,
          replayHash,
          { requestId: randomUUID(), ipAddress: null, userAgent: null },
        )
        .catch((error) => error);
      // The shipment already has a live receipt: a fresh declaration is refused, not duplicated.
      assert.ok(declaredAgain instanceof Error);
      receiptIds.push(declared.data.id);
      assert.match(declared.data.receiptNumber, /^PNH-\d{6}$/u);
      assert.deepEqual(declared.data.unexpectedItems, [{ productId: catalog[1].id, quantity: 3 }]);
      const submitted = await repository.submitStoreReceipt(
        actor,
        declared.data.id,
        {
          expectedVersion: 0,
          lines: [{ productId: catalog[0].id, approvedUnits: 2, receivedUnits: 2 }],
          unexpectedItems: [{ productId: catalog[1].id, quantity: 3 }],
          discrepancyNote: 'Dư ba bao mặt hàng khác',
        },
        randomUUID(),
        randomUUID(),
        { requestId: randomUUID(), ipAddress: null, userAgent: null },
      );
      assert.equal(submitted.data.status, 'PENDING_HTKD');
      // Declaring and submitting never books store stock; only HTKD finalization does.
      const bookedBags = await db
        .select({ id: storeInventoryBags.id })
        .from(storeInventoryBags)
        .innerJoin(
          storeReceiptBags,
          eq(storeReceiptBags.id, storeInventoryBags.sourceStoreReceiptBagId),
        )
        .innerJoin(storeReceiptLines, eq(storeReceiptLines.id, storeReceiptBags.storeReceiptLineId))
        .where(eq(storeReceiptLines.storeReceiptId, declared.data.id));
      assert.equal(bookedBags.length, 0);
      assert.deepEqual(submitted.data.unexpectedItems, [{ productId: catalog[1].id, quantity: 3 }]);
      const visible = await repository.listReceipts(actor, { page: 1, pageSize: 100 });
      assert.ok(visible.data.some((receipt) => receipt.id === declared.data.id));
      assert.ok(visible.data.every((receipt) => receipt.storeId === wholesaleStore.id));
      await assert.rejects(
        repository.getReceipt(actor, retailReceipt.id),
        (error) => error.statusCode === 403,
      );
    } finally {
      const deletedAt = new Date();
      for (const id of receiptIds)
        await db.update(storeReceipts).set({ deletedAt }).where(eq(storeReceipts.id, id));
      for (const id of outboundIds)
        await db.update(outboundRequests).set({ deletedAt }).where(eq(outboundRequests.id, id));
      await db.update(users).set({ deletedAt }).where(eq(users.id, account.id));
      await repository.close();
    }
  });
});
