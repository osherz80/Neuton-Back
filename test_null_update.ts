import { db } from './src/db/client.js';
import { orders } from './src/db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function testNullUpdate() {
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
  
  // Soft delete first
  await db.update(orders).set({ deletedAt: new Date() }).where(eq(orders.id, orderId));
  console.log('Soft deleted');
  
  // Try a simple select
  const result = await db.select({ deletedAt: orders.deletedAt }).from(orders).where(eq(orders.id, orderId));
  console.log('Order after soft delete:', result);
  
  // Try a simple update with postgres directly
  try {
    await db.$client.unsafe(`update "orders" set "customer_name" = 'Updated' where "id" = '${orderId}'`);
    console.log('Simple update worked');
  } catch (err) {
    console.error('Simple update error:', err);
  }
  
  // Clean up
  await db.delete(orders).where(eq(orders.id, orderId));
  
  await db.$client.end();
  console.log('Done');
}

testNullUpdate().catch(async (err) => {
  console.error('Test failed:', err);
  await db.$client.end();
  process.exit(1);
});