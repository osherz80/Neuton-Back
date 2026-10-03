import { db } from './src/db/client.js';
import { recipes } from './src/db/schema/index.js';
import { eq } from 'drizzle-orm';

const shopId = '92e54930-ad84-4c8e-90b2-7e2b8be48ddb'; // testShop

const existingRecipes = await db.select().from(recipes).where(eq(recipes.shopId, shopId));
console.log('Recipes for testShop:', existingRecipes);
await db.$client.end();