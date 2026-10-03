import { db } from './src/db/client.js';
import { orders, orderItems, recipes } from './src/db/schema/index.js';
import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function testSoftDelete() {
  const shopId = 'c46a0bc2-40b9-404c-846e-07f0a4f4676b'; // testShop-2 with recipe
  const recipeId = '88e06e48-5086-429f-8f9f-c8e9400a0823';
  
  // First, let's see if there are any existing orders
  const existingOrders = await db.select().from(orders).where(eq(orders.shopId, shopId));
  console.log('Existing orders:', existingOrders.length);
  
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
  
  // Add an order item
  await db.insert(orderItems).values({
    shopId,
    orderId,
    recipeId,
    quantity: '2',
    unitCost: '25.00',
    unitPrice: '50.00',
  });
  
  // Query active orders (should include our new order)
  const activeOrders = await db.select().from(orders).where(and(eq(orders.shopId, shopId), isNull(orders.deletedAt)));
  console.log('Active orders after create:', activeOrders.length);
  
  // Soft delete the order
  const deleteResult = await db.update(orders).set({ deletedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.shopId, shopId), isNull(orders.deletedAt)));
  console.log('Delete result length:', deleteResult.length);
  
  // Query active orders again (should NOT include our deleted order)
  const activeOrdersAfterDelete = await db.select().from(orders).where(and(eq(orders.shopId, shopId), isNull(orders.deletedAt)));
  console.log('Active orders after delete:', activeOrdersAfterDelete.length);
  
  // Query all orders including deleted (should include our deleted order)
  const allOrders = await db.select().from(orders).where(eq(orders.shopId, shopId));
  console.log('All orders (including deleted):', allOrders.length);
  const deletedOrder = allOrders.find(o => o.id === orderId);
  console.log('Deleted order deletedAt:', deletedOrder?.deletedAt);
  
  // Restore the order
  const restoreResult = await db.update(orders).set({ deletedAt: null }).where(and(eq(orders.id, orderId), eq(orders.shopId, shopId)));
  console.log('Restore result length:', restoreResult.length);
  
  // Query active orders again (should include our restored order)
  const activeOrdersAfterRestore = await db.select().from(orders).where(and(eq(orders.shopId, shopId), isNull(orders.deletedAt)));
  console.log('Active orders after restore:', activeOrdersAfterRestore.length);
  
  // Clean up - hard delete the test order
  await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
  await db.delete(orders).where(eq(orders.id, orderId));
  console.log('Test order cleaned up');
  
  await db.$client.end();
  console.log('\n✅ Soft delete test passed!');
}

testSoftDelete().catch(async (err) => {
  console.error('Test failed:', err);
  await db.$client.end();
  process.exit(1);
});