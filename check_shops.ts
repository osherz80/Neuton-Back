import { db } from './src/db/client.js';
import { shops } from './src/db/schema/index.js';

const existingShops = await db.select().from(shops);
console.log('Shops:', existingShops);
await db.$client.end();