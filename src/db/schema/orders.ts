import { sql } from 'drizzle-orm';
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { recipes } from './catalog.js';
import { profiles, shops } from './identity.js';

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  customerName: text('customer_name'),
  orderDate: timestamp('order_date', { withTimezone: true }).notNull().defaultNow(),
  destinationAddress: text('destination_address'),
  deliveryDistanceKm: numeric('delivery_distance_km', { precision: 8, scale: 2 })
    .notNull()
    .default('0.00'),
  deliveryFee: numeric('delivery_fee', { precision: 10, scale: 2 }).notNull().default('0.00'),
  appliedProfitMargin: numeric('applied_profit_margin', { precision: 5, scale: 2 }),
  totalCost: numeric('total_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
  documentUrl: text('document_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  shopDateIdx: index('orders_shop_id_order_date_idx').on(t.shopId, t.orderDate),
  shopDeletedIdx: index('orders_shop_id_deleted_at_idx').on(t.shopId, t.deletedAt),
}));

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'restrict' }),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  unitCost: numeric('unit_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0.00'),
}, (t) => ({
  orderIdx: index('order_items_order_id_idx').on(t.orderId),
}));

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
