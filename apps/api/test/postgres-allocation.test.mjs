import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  allocationLines,
  allocationRuns,
  dailyPriorityOffers,
  db,
  htkdAssignments,
  inventorySnapshots,
  mergedOrderItems,
  mergedOrderSources,
  mergedOrders,
  orderRequestItems,
  orderRequests,
  orderSessions,
  products,
  sessions,
  storeGroups,
  stores,
  users,
  waitTickets,
} from '@idosi/database';
import { and, eq, isNull } from 'drizzle-orm';

import { createApi } from '../dist/app.js';
import { PostgresWarehouseRepository } from '../dist/postgres-repository.js';
import { hashSessionToken } from '../dist/security.js';

const describePostgres = process.env.RUN_POSTGRES_TESTS === '1' ? describe : describe.skip;

describePostgres('allocation result projection on fresh PostgreSQL', () => {
  test('enforces ADMIN, assigned HTKD and own STORE scope through the API', async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when RUN_POSTGRES_TESTS=1.');
    }
    const repository = new PostgresWarehouseRepository();
    let app;
    try {
      const fixture = await createFixture();
      app = await createApi({ repository });
      for (const [role, expected] of [
        ['admin', 3],
        ['htkd', 2],
        ['store', 1],
      ]) {
        const docs = await app.inject({
          method: 'GET',
          url: '/api/v1/session-documents?sessionId=' + fixture.sessionId + '&pageSize=1',
          headers: { cookie: sessionCookie(fixture.tokens[role]) },
        });
        assert.equal(docs.statusCode, 200, docs.body);
        assert.equal(docs.json().pagination.totalItems, expected);
        assert.equal(docs.json().data.length, 1);
        assert.ok(docs.json().data[0].sources.length > 0);
      }
      const forbiddenDocs = await app.inject({
        method: 'GET',
        url: '/api/v1/session-documents?storeId=' + fixture.storeIds.unassigned,
        headers: { cookie: sessionCookie(fixture.tokens.store) },
      });
      assert.equal(forbiddenDocs.statusCode, 403);
      const baseUrl = `/api/v1/allocations?sessionId=${fixture.sessionId}`;

      const adminPage = await app.inject({
        method: 'GET',
        url: `${baseUrl}&page=1&pageSize=2`,
        headers: { cookie: sessionCookie(fixture.tokens.admin) },
      });
      assert.equal(adminPage.statusCode, 200);
      assert.deepEqual(adminPage.json().pagination, {
        page: 1,
        pageSize: 2,
        totalItems: 3,
        totalPages: 2,
      });
      assert.equal(adminPage.json().data.length, 2);
      assert.deepEqual(
        adminPage.json().data.map((line) => line.storeId),
        [fixture.storeIds.assignedA, fixture.storeIds.assignedB],
      );
      const secondPage = await app.inject({
        method: 'GET',
        url: `${baseUrl}&page=2&pageSize=2`,
        headers: { cookie: sessionCookie(fixture.tokens.admin) },
      });
      assert.deepEqual(
        secondPage.json().data.map((line) => line.storeId),
        [fixture.storeIds.unassigned],
      );

      const unsafePage = await app.inject({
        method: 'GET',
        url: `${baseUrl}&page=9007199254740992&pageSize=1`,
        headers: { cookie: sessionCookie(fixture.tokens.admin) },
      });
      assert.equal(unsafePage.statusCode, 400);
      assert.equal(unsafePage.json().error.code, 'VALIDATION_ERROR');

      const htkdPage = await app.inject({
        method: 'GET',
        url: `${baseUrl}&pageSize=100`,
        headers: { cookie: sessionCookie(fixture.tokens.htkd) },
      });
      assert.equal(htkdPage.statusCode, 200);
      assert.equal(htkdPage.json().pagination.totalItems, 2);
      assert.deepEqual(
        [...new Set(htkdPage.json().data.map((result) => result.storeId))].sort(),
        [fixture.storeIds.assignedA, fixture.storeIds.assignedB].sort(),
      );

      const storePage = await app.inject({
        method: 'GET',
        url: `${baseUrl}&pageSize=100`,
        headers: {
          cookie: sessionCookie(fixture.tokens.store),
          accept: 'application/vnd.idosi.allocations.v2+json',
        },
      });
      assert.equal(storePage.statusCode, 200);
      assert.equal(storePage.json().pagination.totalItems, 1);
      assert.equal(storePage.json().data[0].storeId, fixture.storeIds.assignedA);
      assert.deepEqual(
        {
          requestedQuantity: storePage.json().data[0].requestedQuantity,
          allocatedQuantity: storePage.json().data[0].allocatedQuantity,
          waitlistedQuantity: storePage.json().data[0].waitlistedQuantity,
          reasonCode: storePage.json().data[0].reasonCode,
          roundNumber: storePage.json().data[0].roundNumber,
          rounds: storePage.json().data[0].rounds,
          status: storePage.json().data[0].status,
        },
        {
          requestedQuantity: 5,
          allocatedQuantity: 5,
          waitlistedQuantity: 0,
          reasonCode: 'ALLOCATED_BY_PRIORITY_ROUND_ROBIN',
          roundNumber: 1,
          rounds: [
            { roundNumber: 1, allocatedQuantity: 1 },
            { roundNumber: 2, allocatedQuantity: 1 },
            { roundNumber: 3, allocatedQuantity: 1 },
            { roundNumber: 4, allocatedQuantity: 1 },
            { roundNumber: 5, allocatedQuantity: 1 },
          ],
          status: 'ALLOCATED',
        },
      );

      const filtered = await app.inject({
        method: 'GET',
        url:
          `${baseUrl}&storeId=${fixture.storeIds.assignedB}` +
          `&productId=${fixture.productId}&status=PARTIAL&priority=P1`,
        headers: { cookie: sessionCookie(fixture.tokens.htkd) },
      });
      assert.equal(filtered.statusCode, 200);
      assert.equal(filtered.json().pagination.totalItems, 1);
      assert.equal(filtered.json().data[0].storeId, fixture.storeIds.assignedB);

      const htkdDenied = await app.inject({
        method: 'GET',
        url: `${baseUrl}&storeId=${fixture.storeIds.unassigned}`,
        headers: { cookie: sessionCookie(fixture.tokens.htkd) },
      });
      assert.equal(htkdDenied.statusCode, 403);
      const storeDenied = await app.inject({
        method: 'GET',
        url: `${baseUrl}&storeId=${fixture.storeIds.assignedB}`,
        headers: { cookie: sessionCookie(fixture.tokens.store) },
      });
      assert.equal(storeDenied.statusCode, 403);
      const largeRounds = Array.from({ length: 100000 }, (_, index) => index + 1);
      const largeFixture = await createFixture({
        quantity: 100000,
        policyRounds: largeRounds,
        policyRoundsVersion: 1,
      });
      const bounded = await app.inject({
        method: 'GET',
        url: `/api/v1/allocations?sessionId=${largeFixture.sessionId}`,
        headers: {
          cookie: sessionCookie(largeFixture.tokens.store),
          accept: 'application/vnd.idosi.allocations.v2+json',
        },
      });
      assert.equal(bounded.statusCode, 200);
      assert.equal(bounded.json().data[0].allocatedQuantity, 100000);
      assert.equal(bounded.json().data[0].appliedPriority, 'P1');
      assert.equal(bounded.json().data[0].roundsOmitted, true);
      assert.deepEqual(bounded.json().data[0].rounds, []);
      assert.ok(Buffer.byteLength(bounded.body) < 2000);
      const [stored] = await db
        .select({ metadata: allocationLines.decisionMetadata })
        .from(allocationLines)
        .where(eq(allocationLines.id, bounded.json().data[0].id));
      assert.equal(stored.metadata.policyRounds.length, 100000);
      for (const audit of [
        { quantity: 2, policyRounds: [1, 1], label: 'duplicate legacy rounds' },
        { quantity: 100000, policyRounds: largeRounds, label: 'unversioned large legacy audit' },
        { quantity: 5, policyRounds: largeRounds, label: 'legacy merged source mismatch' },
        {
          quantity: 5,
          policyRounds: largeRounds,
          policyRoundsVersion: 1,
          label: 'versioned count mismatch',
        },
        { quantity: 101, policyRounds: [...Array(100).fill(1), '1'], label: 'string round' },
        { quantity: 101, policyRounds: [...Array(100).fill(1), 1.5], label: 'fractional round' },
        { quantity: 101, policyRounds: [...Array(100).fill(1), 0], label: 'zero round' },
        {
          quantity: 101,
          policyRounds: [...Array(100).fill(1), 9007199254740992],
          label: 'unsafe round',
        },
      ]) {
        const invalidFixture = await createFixture(audit);
        const invalid = await app.inject({
          method: 'GET',
          url: `/api/v1/allocations?sessionId=${invalidFixture.sessionId}`,
          headers: {
            cookie: sessionCookie(invalidFixture.tokens.store),
            accept: 'application/vnd.idosi.allocations.v2+json',
          },
        });
        assert.equal(invalid.statusCode, 200, audit.label);
        assert.equal(invalid.json().data[0].roundsOmitted, false, audit.label);
        assert.deepEqual(invalid.json().data[0].rounds, [], audit.label);
        assert.ok(Buffer.byteLength(invalid.body) < 2000, audit.label);
      }
      const expanded = await createFixture({
        quantity: 2,
        policyRounds: [1, 2],
        documentExample: true,
      });
      const original = (
        await db
          .select()
          .from(allocationLines)
          .where(
            and(
              eq(allocationLines.storeId, expanded.storeIds.assignedA),
              eq(allocationLines.productId, expanded.productId),
            ),
          )
      )[0];
      const sourceItem = (
        await db
          .select()
          .from(orderRequestItems)
          .where(eq(orderRequestItems.id, original.orderRequestItemId))
      )[0];
      const sourceOrder = (
        await db.select().from(orderRequests).where(eq(orderRequests.id, sourceItem.orderRequestId))
      )[0];
      const productIds = [expanded.productId];
      await db.transaction(async (tx) => {
        const [second] = await tx
          .insert(orderRequests)
          .values({ ...sourceOrder, id: randomUUID(), code: '', requestNumber: 2 })
          .returning();
        const [item] = await tx
          .insert(orderRequestItems)
          .values({
            orderRequestId: second.id,
            productId: expanded.productId,
            requestedQuantity: 3,
            allocatedQuantity: 2,
            waitlistedQuantity: 1,
          })
          .returning();
        const [mergedItem] = await tx
          .select()
          .from(mergedOrderItems)
          .where(eq(mergedOrderItems.mergedOrderId, original.mergedOrderId));
        await tx.insert(mergedOrderSources).values({
          mergedOrderItemId: mergedItem.id,
          orderRequestItemId: item.id,
          requestedQuantity: 3,
        });
        await tx.insert(allocationLines).values({
          ...original,
          id: randomUUID(),
          orderRequestItemId: item.id,
          requestedQuantity: 3,
          allocatedQuantity: 2,
          waitlistedQuantity: 1,
          status: 'partial',
        });
        const [ticket] = await tx
          .insert(waitTickets)
          .values({
            storeId: expanded.storeIds.assignedA,
            productId: expanded.productId,
            sourceOrderRequestItemId: sourceItem.id,
            originalQuantity: 1,
            remainingQuantity: 1,
            fulfilledQuantity: 0,
            status: 'active',
          })
          .returning();
        const [offer] = await tx
          .insert(dailyPriorityOffers)
          .values({
            businessDate: '2000-01-01',
            storeId: expanded.storeIds.assignedA,
            productId: expanded.productId,
            waitTicketId: ticket.id,
            priorityLevel: 'P0A',
            offeredQuantity: 1,
            acceptedQuantity: 1,
            roundNumber: 1,
            status: 'accepted',
            responseDeadlineAt: original.createdAt,
            respondedAt: original.createdAt,
          })
          .returning();
        await tx.insert(allocationLines).values({
          ...original,
          id: randomUUID(),
          mergedOrderId: null,
          priorityOfferId: offer.id,
          orderRequestItemId: null,
          waitTicketId: ticket.id,
          priorityLevel: 'P0A',
          requestedQuantity: 1,
          allocatedQuantity: 0,
          waitlistedQuantity: 1,
          status: 'waitlisted',
          decisionMetadata: {},
        });
        for (const [quantity, allocated] of [
          [1, 1],
          [2, 0],
        ]) {
          const unique = randomUUID();
          const [product] = await tx
            .insert(products)
            .values({ sku: unique, slug: unique, name: 'Document product ' + unique })
            .returning();
          productIds.push(product.id);
          const [lineItem] = await tx
            .insert(orderRequestItems)
            .values({
              orderRequestId: second.id,
              productId: product.id,
              requestedQuantity: quantity,
              allocatedQuantity: allocated,
              waitlistedQuantity: quantity - allocated,
            })
            .returning();
          const [merged] = await tx
            .insert(mergedOrderItems)
            .values({
              mergedOrderId: original.mergedOrderId,
              productId: product.id,
              requestedQuantity: quantity,
              allocatedQuantity: allocated,
              waitlistedQuantity: quantity - allocated,
              priorityLevel: 'P1',
            })
            .returning();
          await tx.insert(mergedOrderSources).values({
            mergedOrderItemId: merged.id,
            orderRequestItemId: lineItem.id,
            requestedQuantity: quantity,
          });
          await tx.insert(allocationLines).values({
            ...original,
            id: randomUUID(),
            productId: product.id,
            orderRequestItemId: lineItem.id,
            requestedQuantity: quantity,
            allocatedQuantity: allocated,
            waitlistedQuantity: quantity - allocated,
            status: allocated ? 'allocated' : 'waitlisted',
            decisionMetadata: {},
          });
        }
      });
      const documentUrl =
        '/api/v1/session-documents?sessionId=' +
        expanded.sessionId +
        '&storeId=' +
        expanded.storeIds.assignedA +
        '&pageSize=1';
      const readDocument = () =>
        app.inject({
          method: 'GET',
          url: documentUrl,
          headers: { cookie: sessionCookie(expanded.tokens.admin) },
        });
      const documentResponse = await readDocument();
      assert.equal(documentResponse.statusCode, 200, documentResponse.body);
      const document = documentResponse.json().data[0];
      assert.equal(documentResponse.json().pagination.totalItems, 1);
      assert.equal(document.hasPrioritySource, true);
      assert.equal(document.sources.length, 5);
      assert.equal(
        new Set(document.sources.map((source) => source.orderRequestId).filter(Boolean)).size,
        2,
      );
      assert.deepEqual(
        productIds.map((productId) => {
          const line = document.lines.find((row) => row.productId === productId);
          return [line.requestedQuantity, line.allocatedQuantity, line.waitlistedQuantity];
        }),
        [
          [6, 4, 2],
          [1, 1, 0],
          [2, 0, 2],
        ],
      );
      assert.deepEqual((await readDocument()).json(), documentResponse.json());
      const filteredDocument = await app.inject({
        method: 'GET',
        url: documentUrl + '&status=ALLOCATED',
        headers: { cookie: sessionCookie(expanded.tokens.admin) },
      });
      assert.equal(filteredDocument.json().data[0].lines.length, 3);
      // A later completed version changes the official pointer, not historical rows.
      const [previousRun] = await db
        .select()
        .from(allocationRuns)
        .where(eq(allocationRuns.id, original.allocationRunId));
      const previousSources = await db
        .select()
        .from(allocationLines)
        .where(
          and(
            eq(allocationLines.allocationRunId, original.allocationRunId),
            eq(allocationLines.storeId, expanded.storeIds.assignedA),
          ),
        );
      await db.transaction(async (tx) => {
        const [newRun] = await tx
          .insert(allocationRuns)
          .values({ ...previousRun, id: randomUUID(), runNumber: 2, idempotencyKey: randomUUID() })
          .returning();
        // Ordinary rows suffice to check version selection; priority offers are one-shot.
        await tx
          .insert(allocationLines)
          .values(
            previousSources
              .filter((source) => source.waitTicketId === null)
              .map((source) => ({ ...source, id: randomUUID(), allocationRunId: newRun.id })),
          );
      });
      const latest = (await readDocument()).json();
      assert.equal(latest.pagination.totalItems, 1);
      assert.equal(latest.data[0].version, 2);
      assert.equal(latest.data[0].id, document.id);
      assert.equal(
        (
          await db
            .select()
            .from(allocationLines)
            .where(eq(allocationLines.allocationRunId, original.allocationRunId))
        ).length,
        7,
      );
    } finally {
      if (app) await app.close();
      else await repository.close();
    }
  });
});

async function createFixture({
  quantity = 5,
  policyRounds = [1, 2, 3, 4, 5],
  policyRoundsVersion,
  documentExample = false,
} = {}) {
  const suffix = randomUUID();
  const [administrator] = await db
    .select({ id: users.id, tokenVersion: users.tokenVersion })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)))
    .limit(1);
  const [group] = await db
    .select({ id: storeGroups.id })
    .from(storeGroups)
    .where(eq(storeGroups.isActive, true))
    .limit(1);
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.isActive, true), isNull(products.deletedAt)))
    .limit(1);
  if (!administrator || !group || !product) {
    throw new Error('Reference seed and administrator bootstrap must run before this test.');
  }

  const fixture = await db.transaction(async (tx) => {
    const createdStores = await tx
      .insert(stores)
      .values(
        ['A', 'B', 'C'].map((label, index) => ({
          groupId: group.id,
          code: `ALLOC_${suffix.slice(0, 8)}_${label}`,
          name: `Allocation fixture ${label}`,
          kind: 'retail',
          displayOrder: 10_000 + index,
        })),
      )
      .returning({ id: stores.id });
    const [storeA, storeB, storeC] = createdStores;
    if (!storeA || !storeB || !storeC) throw new Error('Allocation stores were not created.');

    const [htkdUser] = await tx
      .insert(users)
      .values({
        email: `allocation.htkd.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Allocation HTKD',
        role: 'htkd',
        status: 'active',
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    const [storeUser] = await tx
      .insert(users)
      .values({
        email: `allocation.store.${suffix}@example.test`,
        passwordHash: `integration-hash-${suffix}`,
        displayName: 'Allocation Store',
        role: 'store',
        status: 'active',
        storeId: storeA.id,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    if (!htkdUser || !storeUser) throw new Error('Allocation actors were not created.');
    await tx.insert(htkdAssignments).values([
      { userId: htkdUser.id, storeId: storeA.id, assignedByUserId: administrator.id },
      { userId: htkdUser.id, storeId: storeB.id, assignedByUserId: administrator.id },
    ]);

    // Keep this fixture away from today's business date because the worker's live
    // PostgreSQL pipeline deliberately creates the one non-cancelled session for today.
    const businessDate = '2000-01-01';
    const openedAt = new Date(`${businessDate}T00:00:00.000Z`);
    const snapshotAt = new Date(`${businessDate}T01:00:00.000Z`);
    const allocationAt = new Date(`${businessDate}T02:00:00.000Z`);
    const [session] = await tx
      .insert(orderSessions)
      .values({
        code: `ALLOC-${suffix}`,
        businessDate,
        status: 'completed',
        inventorySnapshotDueAt: snapshotAt,
        requestDeadlineAt: allocationAt,
        openedAt,
        closedAt: allocationAt,
        completedAt: allocationAt,
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        createdByUserId: administrator.id,
      })
      .returning({ id: orderSessions.id });
    if (!session) throw new Error('Allocation session was not created.');
    const [snapshot] = await tx
      .insert(inventorySnapshots)
      .values({
        orderSessionId: session.id,
        businessDate,
        snapshotType: 'pre_allocation',
        status: 'completed',
        capturedAt: snapshotAt,
        balanceVersion: 0,
        capturedByUserId: administrator.id,
        completedAt: snapshotAt,
      })
      .returning({ id: inventorySnapshots.id });
    if (!snapshot) throw new Error('Allocation snapshot was not created.');
    const [run] = await tx
      .insert(allocationRuns)
      .values({
        orderSessionId: session.id,
        inventorySnapshotId: snapshot.id,
        runNumber: 1,
        status: 'completed',
        policyVersion: 'idosi-round-robin-p0a-p3-v1',
        idempotencyKey: `allocation-result-test-${suffix}`,
        requestedQuantity: quantity + 10,
        allocatedQuantity: quantity + 3,
        waitlistedQuantity: 7,
        startedAt: snapshotAt,
        finishedAt: allocationAt,
        createdByUserId: administrator.id,
        createdAt: allocationAt,
      })
      .returning({ id: allocationRuns.id });
    if (!run) throw new Error('Allocation run was not created.');

    const lineInputs = [
      {
        storeId: storeA.id,
        requested: quantity,
        allocated: quantity,
        waitlisted: 0,
        status: 'allocated',
        requestStatus: 'allocated',
        reasonCode: 'ALLOCATED_BY_PRIORITY_ROUND_ROBIN',
        policyRounds,
      },
      {
        storeId: storeB.id,
        requested: 5,
        allocated: 3,
        waitlisted: 2,
        status: 'partial',
        requestStatus: 'partially_allocated',
        reasonCode: 'PARTIAL_SNAPSHOT_STOCK',
        policyRounds: [1, 2, 3],
      },
      {
        storeId: storeC.id,
        requested: 5,
        allocated: 0,
        waitlisted: 5,
        status: 'waitlisted',
        requestStatus: 'waitlisted',
        reasonCode: 'INSUFFICIENT_SNAPSHOT_STOCK',
        policyRounds: [],
      },
    ];
    for (const [index, input] of lineInputs.entries()) {
      const [request] = await tx
        .insert(orderRequests)
        .values({
          orderSessionId: session.id,
          storeId: input.storeId,
          requestNumber: 1,
          status: input.requestStatus,
          requestedByUserId: administrator.id,
          submittedAt: openedAt,
        })
        .returning({ id: orderRequests.id });
      if (!request) throw new Error('Allocation request was not created.');
      const [requestItem] = await tx
        .insert(orderRequestItems)
        .values({
          orderRequestId: request.id,
          productId: product.id,
          requestedQuantity: input.requested,
          priorityLevel: 'P1',
          allocatedQuantity: input.allocated,
          waitlistedQuantity: input.waitlisted,
        })
        .returning({ id: orderRequestItems.id });
      const [mergedOrder] = await tx
        .insert(mergedOrders)
        .values({
          orderSessionId: session.id,
          storeId: input.storeId,
          status: 'allocated',
          requestCount: documentExample && index === 0 ? 2 : 1,
          generatedByUserId: administrator.id,
        })
        .returning({ id: mergedOrders.id });
      if (!requestItem || !mergedOrder) throw new Error('Allocation source was not created.');
      const [mergedItem] = await tx
        .insert(mergedOrderItems)
        .values({
          mergedOrderId: mergedOrder.id,
          productId: product.id,
          requestedQuantity: documentExample && index === 0 ? 5 : input.requested,
          priorityLevel: 'P1',
          allocatedQuantity: documentExample && index === 0 ? 4 : input.allocated,
          waitlistedQuantity: documentExample && index === 0 ? 1 : input.waitlisted,
        })
        .returning({ id: mergedOrderItems.id });
      if (!mergedItem) throw new Error('Merged allocation item was not created.');
      await tx.insert(mergedOrderSources).values({
        mergedOrderItemId: mergedItem.id,
        orderRequestItemId: requestItem.id,
        requestedQuantity: input.requested,
      });
      await tx.insert(allocationLines).values({
        // Reverse ID order deliberately: pagination must follow planner coordinates.
        id: `${3 - index}0000000-${randomUUID().slice(9)}`,
        allocationRunId: run.id,
        mergedOrderId: mergedOrder.id,
        storeId: input.storeId,
        productId: product.id,
        orderRequestItemId: requestItem.id,
        priorityLevel: 'P1',
        roundNumber: 1,
        // Tier P1 precedes P3; zero grants sort last despite earlier fallback coordinates.
        sequenceInRound: index === 0 ? 5 : index === 1 ? 3 : 1,
        requestedQuantity: input.requested,
        allocatedQuantity: input.allocated,
        waitlistedQuantity: input.waitlisted,
        status: input.status,
        reasonCode: input.reasonCode,
        decisionMetadata: {
          policyRounds: input.policyRounds,
          appliedPriority: index === 0 ? 'P1' : 'P3',
          ...(policyRoundsVersion === undefined ? {} : { policyRoundsVersion }),
        },
        createdAt: allocationAt,
      });
    }

    const tokens = {
      admin: `allocation-admin-${suffix}`,
      htkd: `allocation-htkd-${suffix}`,
      store: `allocation-store-${suffix}`,
    };
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await tx.insert(sessions).values([
      {
        userId: administrator.id,
        tokenHash: hashSessionToken(tokens.admin),
        userTokenVersion: administrator.tokenVersion,
        expiresAt,
      },
      {
        userId: htkdUser.id,
        tokenHash: hashSessionToken(tokens.htkd),
        userTokenVersion: htkdUser.tokenVersion,
        expiresAt,
      },
      {
        userId: storeUser.id,
        tokenHash: hashSessionToken(tokens.store),
        userTokenVersion: storeUser.tokenVersion,
        expiresAt,
      },
    ]);
    return {
      productId: product.id,
      sessionId: session.id,
      storeIds: { assignedA: storeA.id, assignedB: storeB.id, unassigned: storeC.id },
      tokens,
    };
  });
  return fixture;
}

function sessionCookie(token) {
  return `idosi_session=${token}`;
}
