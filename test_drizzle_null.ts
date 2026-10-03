import { db } from './src/db/client.js';
import { orders } from './src/db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function testDrizzleNull() {
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
  console.log('About to soft delete...');
  const deleteResult = await db.update(orders).set({ deletedAt: new Date() }).where(eq(orders.id, orderId));
  console.log('Soft delete result:', deleteResult);
  console.log('Soft deleted successfully');
  
  // Try to update a different column
  try {
    await db.update(orders).set({ customerName: 'Updated' }).where(eq(orders.id, orderId));
    console.log('Update customerName worked');
  } catch (err) {
    console.error('Update customerName error:', err);
  }
  
  // Clean up
  await db.delete(orders).where(eq(orders.id, orderId));
  
  await db.$client.end();
  console.log('Done');
}

testDrizzleNull().catch(async (err) => {
  console.error('Test failed:', err);
  await db.$client.end();
  process.exit(1);
});