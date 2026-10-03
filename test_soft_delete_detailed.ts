import { db } from './src/db/client.js';
import { orders, orderItems } from './src/db/schema/index.js';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function testSoftDelete() {
  const shopId = 'c46a0bc2-40b9-404c-846e-07f0a4f4676b';
  
  // Create a test order
  const orderId = randomUUID();
  const now = new Date();
  
  const inserted = await db.insert(orders).values({
    id: orderId,
    shopId,
    userId: null,
    customerName: 'Test Customer',
    orderDate: now,
    destinationAddress: '123 Test St',
    deliveryDistanceKm: '5.00',
    deliveryFee: '10.00',
    appliedProfitMargin: '20.00',
    totalCost: '50.00',
    totalAmount: '100.00',
    documentUrl: null,
    createdAt: now,
    deletedAt: null,
  }).returning();
  
  console.log('Created order:', inserted[0]?.id);
  
  // Check initial state
  let order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  console.log('Initial deletedAt:', order[0]?.deletedAt);
  
  // Soft delete the order using Drizzle
  console.log('\n--- Soft Delete ---');
  const deleteResult = await db.update(orders).set({ deletedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.shopId, shopId), isNull(orders.deletedAt)));
  console.log('Delete result:', deleteResult);
  console.log('Delete result length:', deleteResult.length);
  
  // Check state after delete
  order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  console.log('After delete - deletedAt:', order[0]?.deletedAt);
  
  // Try to restore using Drizzle with null
  console.log('\n--- Restore with null ---');
  const restoreResult = await db.update(orders).set({ deletedAt: null }).where(and(eq(orders.id, orderId), eq(orders.shopId, shopId)));
  console.log('Restore result:', restoreResult);
  console.log('Restore result length:', restoreResult.length);
  
  // Check state after restore attempt
  order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  console.log('After restore attempt - deletedAt:', order[0]?.deletedAt);
  
  // Try to restore using raw SQL
  console.log('\n--- Restore with raw SQL ---');
  await db.$client`update "orders" set "deleted_at" = NULL where "id" = ${orderId}`;
  console.log('Raw SQL restore executed');
  
  // Check state after raw SQL restore
  order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  console.log('After raw SQL restore - deletedAt:', order[0]?.deletedAt);
  
  // Clean up
  await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
  await db.delete(orders).where(eq(orders.id, orderId));
  console.log('\nTest order cleaned up');
  
  await db.$client.end();
}

testSoftDelete().catch(async (err) => {
  console.error('Test failed:', err);
  await db.$client.end();
  process.exit(1);
});