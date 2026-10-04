ALTER TABLE "receipts" ADD COLUMN "progress_stage" text DEFAULT 'pending';
ALTER TABLE "receipts" ADD COLUMN "progress_message" text;
ALTER TABLE "receipts" ADD COLUMN "processing_started_at" timestamp with time zone;
ALTER TABLE "receipts" ADD COLUMN "processing_deadline" timestamp with time zone;