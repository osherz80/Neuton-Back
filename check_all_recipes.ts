import { db } from './src/db/client.js';
import { recipes } from './src/db/schema/index.js';
import { eq } from 'drizzle-orm';

const shopIds = [
  '7478bd27-87df-4a92-8996-45cd86995e5c', // osherzz
  '2dc7f540-8d05-4dbd-965a-c6b8449d057b', // Debug Kitchen
  'e67520c2-ef5c-44f7-80ae-1f4fdb590983', // QA Test Shop
  '92e54930-ad84-4c8e-90b2-7e2b8be48ddb', // testShop
  '6a687e63-aab2-4b3e-a753-103adc06e2dc', // testShop-1
  'c46a0bc2-40b9-404c-846e-07f0a4f4676b', // testShop-2
];

for (const shopId of shopIds) {
  const existingRecipes = await db.select().from(recipes).where(eq(recipes.shopId, shopId));
  console.log(`Shop ${shopId}: ${existingRecipes.length} recipes`);
  if (existingRecipes.length > 0) {
    console.log('  First recipe:', existingRecipes[0]);
  }
}
await db.$client.end();