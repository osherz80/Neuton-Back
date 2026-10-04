import { sql } from 'drizzle-orm';
import {
  char,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { RECEIPT_STATUSES } from './enums.js';
import { inventoryItems } from './catalog.js';
import { profiles, shops } from './identity.js';

export const RECEIPT_PROGRESS_STAGES = [
  'pending',
  'extracting',
  'validating',
  'applying',
  'completed',
  'failed',
] as const;
export type ReceiptProgressStage = (typeof RECEIPT_PROGRESS_STAGES)[number];

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => profiles.id, { onDelete: 'set null' }),
  storagePath: text('storage_path').notNull(),
  /** MIME type actually stored in R2; reprocessing must not guess this. */
  contentType: text('content_type'),
  originalFilename: text('original_filename'),
  merchantName: text('merchant_name'),
  merchantAddress: text('merchant_address'), // the specific chain branch location/number
  receiptDate: date('receipt_date'),
  paymentMethod: text('payment_method'),
  totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }),
  currency: char('currency', { length: 3 }),
  status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('pending'),
  progressStage: text('progress_stage', { enum: RECEIPT_PROGRESS_STAGES }).default('pending'),
  progressMessage: text('progress_message'),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  processingDeadline: timestamp('processing_deadline', { withTimezone: true }),
  rawExtraction: jsonb('raw_extraction'),
  errorMessage: text('error_message'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopDateIdx: index('receipts_shop_id_receipt_date_idx').on(t.shopId, t.receiptDate),
  shopStatusIdx: index('receipts_shop_id_status_idx').on(t.shopId, t.status),
}));

export const receiptItems = pgTable('receipt_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  receiptId: uuid('receipt_id')
    .notNull()
    .references(() => receipts.id, { onDelete: 'cascade' }),
  inventoryItemId: uuid('inventory_item_id').references(() => inventoryItems.id, {
    onDelete: 'set null',
  }),
  rawName: text('raw_name').notNull(),
  rawSku: text('raw_sku'),
  quantity: numeric('quantity', { precision: 12, scale: 3 }),
  unitPrice: numeric('unit_price', { precision: 12, scale: 4 }),
  totalPrice: numeric('total_price', { precision: 12, scale: 2 }),
  unit: text('unit'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  receiptIdx: index('receipt_items_receipt_id_idx').on(t.receiptId),
  shopItemIdx: index('receipt_items_shop_id_inventory_item_id_idx').on(
    t.shopId,
    t.inventoryItemId,
  ),
  shopSkuIdx: index('receipt_items_shop_id_raw_sku_idx')
    .on(t.shopId, t.rawSku)
    .where(sql`${t.rawSku} IS NOT NULL`),
}));

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type NewReceiptItem = typeof receiptItems.$inferInsert;
