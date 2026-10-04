import { pathToFileURL } from 'node:url';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import pino from 'pino';
import { and, eq, ilike, isNull } from 'drizzle-orm';
import { db, sql as sqlClient, type Database } from './db/client.js';
import {
  inventoryItems,
  orderItems,
  orders,
  receiptItems,
  receipts,
  recipes,
  recipeIngredients,
  shops,
} from './db/schema/index.js';
import {
  createRedisConnection,
  QUEUE_NAME,
  type MediaJobData,
} from './lib/queue.js';
import { getObjectBytes } from './lib/storage.js';
import { extractOrder, extractReceipt, extractRecipe } from './lib/gemini.js';
import { isPermanentError, publicFailureMessage } from './lib/jobErrors.js';
import { money, quantity as qty, toNumber, unitCost } from './lib/money.js';
import { applyWeightedAverage, calculateRetailPrice, calculateUnitCost } from './lib/pricing.js';
import { env, isDevelopment } from './env.js';
import { geminiCircuitBreaker, CircuitOpenError } from './lib/circuitBreaker.js';
import { RECEIPT_PROGRESS_STAGES, type ReceiptProgressStage } from './db/schema/receipts.js';

const logger = pino({
  // A test run should assert on output, not emit a wall of JSON between cases.
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  // pino-pretty ships logs through a worker thread, so it is limited to
  // development. Anywhere else (tests, CI) plain JSON is used, which keeps the
  // process able to exit.
  ...(isDevelopment ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});

/**
 * Collaborators each job handler reaches for. Injected so the handlers can be
 * exercised without a live Postgres, an R2 bucket or a Gemini key; production
 * always passes `defaultWorkerDeps`.
 */
export interface WorkerDeps {
  db: Database;
  getObjectBytes: (key: string) => Promise<Uint8Array>;
  extractReceipt: typeof extractReceipt;
  extractRecipe: typeof extractRecipe;
  extractOrder: typeof extractOrder;
}

export const defaultWorkerDeps: WorkerDeps = {
  db,
  getObjectBytes,
  extractReceipt,
  extractRecipe,
  extractOrder,
};

const INVENTORY_UNITS = ['kg', 'g', 'l', 'ml', 'unit', 'pack'] as const;
type InventoryUnit = (typeof INVENTORY_UNITS)[number];

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export async function findOrCreateInventoryItem(
  deps: WorkerDeps,
  shopId: string,
  rawName: string,
  unit: string | null,
): Promise<string | null> {
  const name = rawName.trim();
  if (name.length === 0) return null;

  const exact = await deps.db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), eq(inventoryItems.name, name)))
    .limit(1);
  if (exact[0]) return exact[0].id;

  const fuzzy = await deps.db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), ilike(inventoryItems.name, `%${name}%`)))
    .limit(1);
  if (fuzzy[0]) return fuzzy[0].id;

  const created = await deps.db
    .insert(inventoryItems)
    .values({
      shopId,
      name,
      unit: (INVENTORY_UNITS as readonly string[]).includes(unit ?? '')
        ? (unit as InventoryUnit)
        : 'unit',
      currentQuantity: '0.000',
    })
    .returning({ id: inventoryItems.id });

  return created[0]?.id ?? null;
}

/**
 * Applies a purchased line to inventory: bumps stock and rolls the weighted
 * moving average unit cost forward.
 */
export async function applyPurchase(
  deps: WorkerDeps,
  inventoryItemId: string,
  purchasedQuantity: number,
  unitPrice: number,
): Promise<void> {
  const rows = await deps.db
    .select({
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId))
    .limit(1);

  const current = rows[0];
  if (!current) return;

  const next = applyWeightedAverage(
    { currentQuantity: current.currentQuantity, averageUnitCost: current.averageUnitCost },
    { quantity: purchasedQuantity, unitPrice },
  );

  await deps.db
    .update(inventoryItems)
    .set({
      currentQuantity: qty(next.currentQuantity),
      lastUnitCost: unitCost(next.lastUnitCost),
      averageUnitCost: unitCost(next.averageUnitCost),
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, inventoryItemId));
}

async function updateReceiptProgress(
  deps: WorkerDeps,
  data: MediaJobData,
  stage: ReceiptProgressStage,
  message: string,
): Promise<void> {
  await deps.db
    .update(receipts)
    .set({
      progressStage: stage,
      progressMessage: message,
      updatedAt: new Date(),
    })
    .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)));
}

function checkDeadline(deadline: Date | null): void {
  if (deadline && new Date() > deadline) {
    throw new Error('Processing deadline exceeded');
  }
}

export async function processReceipt(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + env.RECEIPT_PROCESSING_TIMEOUT_MS);

  // Initialize processing tracking
  await deps.db
    .update(receipts)
    .set({
      status: 'processing',
      progressStage: 'extracting',
      progressMessage: 'Downloading document from storage',
      processingStartedAt: startedAt,
      processingDeadline: deadline,
      updatedAt: new Date(),
    })
    .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)));

  const bytes = await deps.getObjectBytes(data.storagePath);
  checkDeadline(deadline);

  await updateReceiptProgress(deps, data, 'extracting', 'Extracting receipt data with AI');
  await job.updateProgress(10);

  const extraction = await deps.extractReceipt({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });
  checkDeadline(deadline);

  if (!extraction) {
    throw new Error('Gemini returned no parsable receipt extraction');
  }

  await updateReceiptProgress(deps, data, 'validating', 'Validating extracted data');
  await job.updateProgress(30);

  const jobLogger = logger.child({ jobId: job.id, shopId: data.shopId });

  await deps.db.transaction(async (tx) => {
    const receiptRows = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)),
      )
      .limit(1);
    const receiptId = receiptRows[0]?.id;
    if (!receiptId) {
      jobLogger.warn('receipt row missing for storage path');
      return;
    }

    checkDeadline(deadline);
    await updateReceiptProgress(deps, data, 'validating', 'Clearing previous line items');
    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    await job.updateProgress(40);

    const itemRows = [];
    for (let i = 0; i < extraction.items.length; i++) {
      checkDeadline(deadline);
      const item = extraction.items[i]!;
      const progress = 40 + Math.floor((i / extraction.items.length) * 40);
      await updateReceiptProgress(
        deps,
        data,
        'applying',
        `Processing line item ${i + 1} of ${extraction.items.length}`,
      );
      await job.updateProgress(progress);

      const inventoryItemId = await findOrCreateInventoryItem(
        deps,
        data.shopId,
        item.rawName,
        item.unit,
      );

      if (inventoryItemId && item.quantity && item.unitPrice) {
        await applyPurchase(deps, inventoryItemId, item.quantity, item.unitPrice);
      }

      const inserted = await tx
        .insert(receiptItems)
        .values({
          shopId: data.shopId,
          receiptId,
          inventoryItemId,
          rawName: item.rawName,
          quantity: item.quantity === null ? null : qty(item.quantity),
          unitPrice: item.unitPrice === null ? null : unitCost(item.unitPrice),
          totalPrice: item.totalPrice === null ? null : money(item.totalPrice),
          unit: item.unit,
          confidence: item.confidence === null ? null : item.confidence.toFixed(3),
        })
        .returning({ id: receiptItems.id });

      itemRows.push(inserted[0]?.id);
    }

    checkDeadline(deadline);
    await updateReceiptProgress(deps, data, 'applying', 'Finalizing receipt');
    await job.updateProgress(85);

    const derivedTotal =
      extraction.totalAmount ??
      extraction.items.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);

    await tx
      .update(receipts)
      .set({
        merchantName: extraction.merchantName,
        receiptDate: extraction.receiptDate,
        totalAmount: money(derivedTotal),
        taxAmount: extraction.taxAmount === null ? null : money(extraction.taxAmount),
        currency: extraction.currency,
        status: 'completed',
        progressStage: 'completed',
        progressMessage: 'Processing complete',
        rawExtraction: extraction as unknown as Record<string, unknown>,
        processedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(receipts.id, receiptId));
    await job.updateProgress(100);
  });

  jobLogger.info(
    { items: extraction.items.length, merchant: extraction.merchantName },
    'receipt processed',
  );
}

export async function processRecipe(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const bytes = await deps.getObjectBytes(data.storagePath);
  const extraction = await deps.extractRecipe({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });

  if (!extraction?.name) {
    throw new Error('Gemini returned no parsable recipe extraction');
  }

  const {
    name,
    description,
    prepTimeMinutes,
    yieldQuantity,
    yieldUnit,
    allergens,
    instructions,
  } = extraction;
  const safeName = name;

  const shopRows = await deps.db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);
  const shop = shopRows[0];

  const linkedIngredientIds = new Map<string, string>();
  for (const ingredient of extraction.ingredients) {
    const inventoryItemId = await findOrCreateInventoryItem(
      deps,
      data.shopId,
      ingredient.rawName,
      ingredient.unit,
    );
    if (inventoryItemId) linkedIngredientIds.set(ingredient.rawName, inventoryItemId);
  }

  const costed = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(recipes)
      .values({
        shopId: data.shopId,
        name: safeName,
        description,
        prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
        yieldQuantity: qty(yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1),
        yieldUnit: yieldUnit ?? 'portion',
        allergens,
        instructions,
      })
      .returning();

    const recipe = inserted[0];
    if (!recipe) throw new Error('recipe insert returned no row');

    const bill = extraction.ingredients
      .map((ingredient) => {
        const inventoryItemId = linkedIngredientIds.get(ingredient.rawName);
        if (!inventoryItemId || !ingredient.quantity) return null;
        return {
          shopId: data.shopId,
          recipeId: recipe.id,
          inventoryItemId,
          quantity: qty(ingredient.quantity),
          unit: ingredient.unit ?? 'unit',
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (bill.length > 0) {
      await tx.insert(recipeIngredients).values(bill);
    }

    return recipe;
  });

  logger.info(
    {
      jobId: job.id,
      recipeId: costed.id,
      name: costed.name,
      hourlyLaborCost: shop?.hourlyLaborCost,
    },
    'recipe drafted from document',
  );
}

export async function processOrderDocument(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const bytes = await deps.getObjectBytes(data.storagePath);
  const extraction = await deps.extractOrder({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });

  if (!extraction || extraction.items.length === 0) {
    throw new Error('Gemini returned no parsable order extraction');
  }

  if (!data.orderId) {
    logger.warn({ jobId: job.id }, 'order document uploaded without a target order');
    return;
  }

  const orderRows = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, data.orderId), eq(orders.shopId, data.shopId), isNull(orders.deletedAt)))
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    logger.warn({ jobId: job.id, orderId: data.orderId }, 'target order not found');
    return;
  }

  const recipeRows = await deps.db
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.isActive, true)));
  const byName = new Map(recipeRows.map((recipe) => [recipe.name.toLowerCase(), recipe]));

  const shopRows = await deps.db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);
  const shop = shopRows[0];

  const matched = extraction.items
    .map((item) => {
      const recipe = byName.get(item.name.trim().toLowerCase());
      if (!recipe) return null;
      const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
      return { recipe, quantity, unitPrice: item.unitPrice };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (matched.length === 0) {
    logger.info({ jobId: job.id }, 'no order lines matched catalog recipes');
    return;
  }

  const ingredientRows = await deps.db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .where(eq(recipeIngredients.shopId, data.shopId));
  const byRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    byRecipe.set(row.recipeId, [...(byRecipe.get(row.recipeId) ?? []), row]);
  }

  const priced = matched.map((row) => {
    const breakdown = calculateUnitCost({
      ingredients: (byRecipe.get(row.recipe.id) ?? []).map((i) => ({
        quantity: i.quantity,
        averageUnitCost: i.averageUnitCost,
      })),
      prepTimeMinutes: row.recipe.prepTimeMinutes,
      hourlyLaborCost: shop?.hourlyLaborCost ?? '0',
      yieldQuantity: row.recipe.yieldQuantity,
    });
    const { retailPrice } = calculateRetailPrice(
      breakdown.unitCost,
      shop?.targetProfitMargin ?? '0',
      row.recipe.targetMarginPct,
    );
    return {
      recipeId: row.recipe.id,
      quantity: row.quantity,
      unitCost: breakdown.unitCost,
      unitPrice: row.unitPrice ?? retailPrice,
    };
  });

  await deps.db.transaction(async (tx) => {
    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    await tx.insert(orderItems).values(
      priced.map((row) => ({
        shopId: data.shopId,
        orderId: order.id,
        recipeId: row.recipeId,
        quantity: qty(row.quantity),
        unitCost: money(row.unitCost),
        unitPrice: money(row.unitPrice),
      })),
    );

    const totalCost = priced.reduce((sum, row) => sum + row.quantity * row.unitCost, 0);
    const subtotal = priced.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);

    await tx
      .update(orders)
      .set({
        ...(extraction.customerName && !order.customerName
          ? { customerName: extraction.customerName }
          : {}),
        ...(extraction.destinationAddress && !order.destinationAddress
          ? { destinationAddress: extraction.destinationAddress }
          : {}),
        totalCost: money(totalCost),
        totalAmount: money(subtotal + toNumber(order.deliveryFee)),
      })
      .where(eq(orders.id, order.id));
  });

  logger.info({ jobId: job.id, orderId: order.id, lines: priced.length }, 'order auto-filled');
}

/**
 * Records the terminal failure on the receipt row. Without this the UI polls
 * `/receipts/:id/status` forever on "processing" and never offers reprocess.
 * Only fires once BullMQ has exhausted attempts, so transient failures stay
 * invisible to the shop.
 */
export async function recordTerminalFailure(
  deps: WorkerDeps,
  data: MediaJobData,
  error: unknown,
): Promise<void> {
  if (data.kind !== 'receipt') return;

  const message = publicFailureMessage(error);
  const isTimeout = error instanceof Error && error.message.includes('deadline exceeded');
  try {
    await deps.db
      .update(receipts)
      .set({
        status: 'failed',
        progressStage: isTimeout ? 'failed' : undefined,
        progressMessage: isTimeout ? 'Processing timed out' : undefined,
        errorMessage: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)));
  } catch (updateError) {
    logger.error(
      { err: updateError, jobShopId: data.shopId },
      'could not record terminal receipt failure',
    );
  }
}

/**
 * Routes a job to its handler and translates failures into BullMQ semantics.
 * Permanent errors stop the retry schedule and surface a shop-safe message.
 * Also enforces an overall processing deadline and respects the circuit breaker.
 */
export async function runJob(
  data: MediaJobData,
  job: Job<MediaJobData>,
  deps: WorkerDeps = defaultWorkerDeps,
): Promise<void> {
  const jobLogger = logger.child({ jobId: job.id, kind: data.kind, shopId: data.shopId });
  jobLogger.info('job started');

  // Check circuit breaker before starting
  if (!geminiCircuitBreaker.canExecute()) {
    const status = geminiCircuitBreaker.getStatus();
    jobLogger.warn({ circuitState: status.state, failureCount: status.failureCount }, 'circuit breaker open, failing fast');
    throw new CircuitOpenError(env.CIRCUIT_BREAKER_RESET_MS);
  }

  // Overall deadline for the entire job (including retries within the job)
  const deadline = Date.now() + env.RECEIPT_PROCESSING_TIMEOUT_MS;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(`Job exceeded overall processing deadline of ${env.RECEIPT_PROCESSING_TIMEOUT_MS}ms`);
    }
  };

  try {
    checkDeadline();
    switch (data.kind) {
      case 'receipt':
        await processReceipt(deps, data, job);
        break;
      case 'recipe':
      case 'product':
        await processRecipe(deps, data, job);
        break;
      case 'order':
        await processOrderDocument(deps, data, job);
        break;
      default:
        throw new Error(`Unsupported job kind: ${String(data.kind)}`);
    }
    // Record success for circuit breaker
    geminiCircuitBreaker.recordSuccess();
  } catch (error) {
    // Record failure for circuit breaker (but not for permanent errors or circuit open)
    if (!(error instanceof CircuitOpenError) && !isPermanentError(error)) {
      geminiCircuitBreaker.recordFailure();
    }

    // Billing/auth/malformed-payload errors will not resolve on retry, so
    // drop them straight to failed instead of spending the backoff schedule.
    if (isPermanentError(error)) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }

    // Processing deadline exceeded - treat as permanent failure to avoid retries
    if (error instanceof Error && error.message.includes('deadline exceeded')) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }
    throw error;
  }

  jobLogger.info('job completed');
}

/**
 * Importing this module must not boot a worker: the test suite imports it to
 * exercise the handlers above, and a stray worker would hold a Redis
 * connection and the event loop open.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function startWorker(): void {
  const worker = new Worker<MediaJobData>(QUEUE_NAME, (job) => runJob(job.data, job), {
    connection: createRedisConnection(),
    concurrency: env.RECEIPT_WORKER_CONCURRENCY,
    /** Duration of the lock for the job in milliseconds. If the lock is lost, the job will be moved back to wait. */
    lockDuration: env.JOB_LOCK_DURATION_MS,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job done'));
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'job failed');
    // Covers transient errors that ran out of attempts, so the receipt row does
    // not stay on "processing" with no explanation.
    if (job && (error instanceof UnrecoverableError || error instanceof CircuitOpenError)) return;
    if (!job) return;
    void recordTerminalFailure(defaultWorkerDeps, job.data, error);
  });
  worker.on('error', (error) => logger.error({ err: error }, 'worker error'));

  logger.info(
    { queue: QUEUE_NAME, concurrency: env.RECEIPT_WORKER_CONCURRENCY },
    'neuton vision worker ready',
  );

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, closing worker`);
    await worker.close();
    await sqlClient.end({ timeout: 5 }).catch(() => { });
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (isEntrypoint()) {
  startWorker();
}
