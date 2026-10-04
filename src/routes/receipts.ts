import { z } from 'zod';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import { receipts, receiptItems } from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound, forbidden, tooLarge } from '../lib/errors.js';
import { enqueueMediaJob, type MediaKind } from '../lib/queue.js';
import {
  assertContentType,
  buildStoragePath,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
} from '../lib/storage.js';
import { env } from '../env.js';

const STORAGE_KINDS = {
  receipt: 'receipts',
  recipe: 'recipes',
  product: 'products',
  order: 'orders',
} as const;

const presignSchema = z.object({
  kind: z.enum(['receipt', 'recipe', 'product', 'order']),
  contentType: z.string().min(1),
  originalFilename: z.string().trim().max(255).nullable().optional(),
  byteSize: z.coerce.number().int().positive().optional(),
  orderId: z.string().uuid().optional(),
});

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };

  /**
   * Step 1 of the ingestion pipeline: hand the client a short-lived presigned
   * R2 URL so the browser uploads directly, bypassing the API.
   */
  app.post('/uploads/presign', guards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = presignSchema.parse(request.body);

    const contentType = assertContentType(body.contentType);
    if (body.byteSize && body.byteSize > env.MAX_UPLOAD_BYTES) {
      throw tooLarge(`Uploads are limited to ${env.MAX_UPLOAD_BYTES} bytes`);
    }

    const storagePath = buildStoragePath({
      shopId: shop.id,
      kind: STORAGE_KINDS[body.kind],
      contentType,
    });
    const uploadUrl = await createPresignedUploadUrl(storagePath, contentType);

    // A receipt row is created up-front so the UI can show an in-progress card.
    let receiptId: string | null = null;
    if (body.kind === 'receipt') {
      const rows = await db
        .insert(receipts)
        .values({
          shopId: shop.id,
          uploadedBy: user.id,
          storagePath,
          originalFilename: body.originalFilename ?? null,
          status: 'pending',
          currency: shop.currency,
          progressStage: 'pending',
          progressMessage: 'Uploading document',
        })
        .returning({ id: receipts.id });
      receiptId = rows[0]?.id ?? null;
    }

    return reply.code(201).send({
      uploadUrl,
      storagePath,
      receiptId,
      method: 'PUT',
      expiresIn: env.UPLOAD_URL_TTL_SECONDS,
    });
  });

  /**
   * Step 3: the client confirms the upload landed, and we enqueue the
   * Gemini Flash vision job. Safe to call only after a successful PUT.
   */
  app.post('/uploads/complete', guards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = z
      .object({
        storagePath: z.string().trim().min(1).max(400),
        kind: z.enum(['receipt', 'recipe', 'product', 'order']),
        contentType: z.string().min(1),
        originalFilename: z.string().trim().max(255).nullable().optional(),
        receiptId: z.string().uuid().optional(),
        orderId: z.string().uuid().optional(),
      })
      .parse(request.body);

    if (!body.storagePath.startsWith(`${shop.id}/`)) {
      throw notFound('Unknown storage path for this shop');
    }

    let receiptId = body.receiptId ?? null;
    if (body.kind === 'receipt') {
      if (!receiptId) {
        const rows = await db
          .insert(receipts)
          .values({
            shopId: shop.id,
            uploadedBy: user.id,
            storagePath: body.storagePath,
            contentType: body.contentType,
            originalFilename: body.originalFilename ?? null,
            status: 'pending',
            currency: shop.currency,
            progressStage: 'pending',
            progressMessage: 'Queued for processing',
          })
          .returning({ id: receipts.id });
        receiptId = rows[0]?.id ?? null;
      } else {
        await db
          .update(receipts)
          .set({
            status: 'processing',
            contentType: body.contentType,
            progressStage: 'pending',
            progressMessage: 'Queued for processing',
            updatedAt: new Date(),
          })
          .where(
            and(eq(receipts.id, receiptId), eq(receipts.shopId, shop.id)),
          );
      }
    }

    const enqueued = await enqueueMediaJob({
      shopId: shop.id,
      uploadedBy: user.id,
      kind: body.kind as MediaKind,
      storagePath: body.storagePath,
      contentType: body.contentType,
      originalFilename: body.originalFilename ?? null,
      ...(body.orderId ? { orderId: body.orderId } : {}),
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECEIPT_UPLOAD',
      resourceId: receiptId,
      ipAddress: request.ip,
      metadata: { kind: body.kind, storagePath: body.storagePath, queued: enqueued.queued },
    });

    return reply.code(202).send({ receiptId, ...enqueued });
  });

  app.get('/receipts', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const conditions = [eq(receipts.shopId, shop.id)];
    if (query.status) conditions.push(eq(receipts.status, query.status));
    if (query.search) {
      conditions.push(
        or(ilike(receipts.merchantName, `%${query.search}%`),
          ilike(receipts.originalFilename, `%${query.search}%`))!,
      );
    }

    const rows = await db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.receiptDate), desc(receipts.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    return { receipts: rows };
  });

  app.get('/receipts/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    const receipt = rows[0];
    if (!receipt) throw notFound('Receipt not found');

    const items = await db
      .select()
      .from(receiptItems)
      .where(
        and(eq(receiptItems.receiptId, id), eq(receiptItems.shopId, shop.id)),
      )
      .orderBy(asc(receiptItems.id));

    return { receipt: { ...receipt, items } };
  });

  /** Manual re-run for a receipt whose AI extraction failed. */
  app.post('/receipts/:id/reprocess', guards, async (request, reply) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    const receipt = rows[0];
    if (!receipt) throw notFound('Receipt not found');

    await db
      .update(receipts)
      .set({
        status: 'processing',
        errorMessage: null,
        progressStage: 'pending',
        progressMessage: null,
        processingStartedAt: null,
        processingDeadline: null,
        updatedAt: new Date(),
      })
      .where(eq(receipts.id, id));

    const enqueued = await enqueueMediaJob({
      shopId: shop.id,
      uploadedBy: currentUser(request).id,
      kind: 'receipt',
      storagePath: receipt.storagePath,
      contentType: receipt.contentType ?? 'image/jpeg',
      originalFilename: receipt.originalFilename,
    });

    return reply.code(202).send({ receiptId: id, ...enqueued });
  });

  /** Cheap polling endpoint for the "processing…" state on a receipt card. */
  app.get('/receipts/:id/status', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select({
        status: receipts.status,
        errorMessage: receipts.errorMessage,
        progressStage: receipts.progressStage,
        progressMessage: receipts.progressMessage,
        processingStartedAt: receipts.processingStartedAt,
        processingDeadline: receipts.processingDeadline,
      })
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    if (!rows[0]) throw notFound('Receipt not found');
    return rows[0];
  });

  /** Raw AI output, for the receipt detail sheet's extraction trace. */
  app.get('/receipts/:id/extraction', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select({ rawExtraction: receipts.rawExtraction })
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    if (!rows[0]) throw notFound('Receipt not found');
    return { rawExtraction: rows[0].rawExtraction };
  });

  /** Count of receipts still being processed — used for polling decisions. */
  app.get('/receipts/queue/pending-count', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(
        and(
          eq(receipts.shopId, shop.id),
          sql`${receipts.status} in ('pending','processing')`,
        ),
      );
    return { pending: rows[0]?.count ?? 0 };
  });

  /**
   * Short-lived signed read for an already-uploaded object. Storage keys are
   * tenant-prefixed, so the prefix check is what stops one shop from signing
   * another shop's objects; the row lookup then confirms the path really is
   * theirs.
   */
  app.post('/uploads/download-url', guards, async (request) => {
    const shop = currentShop(request);
    const { path } = z.object({ path: z.string().trim().min(1).max(500) }).parse(request.body);

    if (!path.startsWith(`${shop.id}/`)) {
      throw forbidden('That file does not belong to this shop');
    }

    const rows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.shopId, shop.id), eq(receipts.storagePath, path)))
      .limit(1);
    if (!rows[0]) throw notFound('File not found');

    return {
      url: await createPresignedDownloadUrl(path),
      expiresIn: 3600,
    };
  });
};
