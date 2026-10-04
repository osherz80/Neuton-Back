import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { UnrecoverableError, type Job } from 'bullmq';
import type {
  OrderExtraction,
  ReceiptExtraction,
  RecipeExtraction,
} from '../src/lib/gemini.js';
import type { MediaJobData } from '../src/lib/queue.js';
import {
  applyPurchase,
  findOrCreateInventoryItem,
  processOrderDocument,
  processRecipe,
  processReceipt,
  recordTerminalFailure,
  runJob,
  type WorkerDeps,
} from '../src/worker.js';
import { FakeDb, type FakeResponses } from './support/fakeDb.js';

const SHOP_ID = '11111111-1111-1111-1111-111111111111';
const STORAGE_PATH = `${SHOP_ID}/receipts/abc123.jpg`;

interface ExtractionStubs {
  receipt?: ReceiptExtraction | null;
  recipe?: RecipeExtraction | null;
  order?: OrderExtraction | null;
}

interface Harness {
  db: FakeDb;
  deps: WorkerDeps;
  job: Job<MediaJobData>;
  jobData: MediaJobData;
  /** Records the storage key and payload the handler handed to the extractors. */
  extracted: { storagePath: string; mimeType: string; data: string }[];
}

function harness(options: {
  responses?: FakeResponses;
  extractions?: ExtractionStubs;
  data?: Partial<MediaJobData>;
} = {}): Harness {
  const db = new FakeDb(options.responses ?? {});
  const extracted: Harness['extracted'] = [];
  const jobData: MediaJobData = {
    shopId: SHOP_ID,
    uploadedBy: null,
    kind: 'receipt',
    storagePath: STORAGE_PATH,
    contentType: 'image/jpeg',
    originalFilename: 'receipt.jpg',
    ...options.data,
  };

  const record = (mimeType: string, data: string) => {
    extracted.push({ storagePath: jobData.storagePath, mimeType, data });
  };

  const deps: WorkerDeps = {
    db: db as unknown as WorkerDeps['db'],
    getObjectBytes: async () => new Uint8Array([104, 105]),
    extractReceipt: async (input) => {
      record(input.mimeType, input.data);
      return options.extractions?.receipt ?? null;
    },
    extractRecipe: async (input) => {
      record(input.mimeType, input.data);
      return options.extractions?.recipe ?? null;
    },
    extractOrder: async (input) => {
      record(input.mimeType, input.data);
      return options.extractions?.order ?? null;
    },
  };

  return {
    db,
    deps,
    jobData,
    extracted,
    job: { 
      id: 'job-1', 
      data: jobData,
      updateProgress: async () => {},
    } as unknown as Job<MediaJobData>,
  };
}

function receipt(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    merchantName: 'Shufersal',
    receiptDate: '2026-09-30',
    totalAmount: null,
    taxAmount: 12.3,
    currency: 'ILS',
    items: [
      {
        rawName: 'Flour',
        quantity: 2,
        unit: 'kg',
        unitPrice: 3.5,
        totalPrice: 7,
        confidence: 0.9123,
      },
    ],
    ...overrides,
  };
}

/** Scripted rows for one item that resolves to a fresh inventory row. */
const ONE_ITEM_FOUND = {
  'select:inventoryItems': [[], [], [{ currentQuantity: '0.000', averageUnitCost: '0.0000' }]],
  'insert:inventoryItems': [[{ id: 'inv-1' }]],
  'insert:receiptItems': [[{ id: 'ri-1' }]],
} satisfies FakeResponses;

// ---------------------------------------------------------------------------
// findOrCreateInventoryItem
// ---------------------------------------------------------------------------

test('inventory lookup: a blank name is rejected without touching the database', async () => {
  const { db, deps } = harness();

  assert.equal(await findOrCreateInventoryItem(deps, SHOP_ID, '   ', 'kg'), null);
  assert.equal(db.calls.length, 0);
});

test('inventory lookup: an exact name match short-circuits the fuzzy search', async () => {
  const { db, deps } = harness({ responses: { 'select:inventoryItems': [[{ id: 'inv-1' }]] } });

  assert.equal(await findOrCreateInventoryItem(deps, SHOP_ID, ' Flour ', 'kg'), 'inv-1');
  assert.equal(db.callsTo('select', 'inventoryItems').length, 1);
  assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
});

test('inventory lookup: a substring match reuses the row instead of inserting', async () => {
  const { db, deps } = harness({
    responses: { 'select:inventoryItems': [[], [{ id: 'inv-2' }]] },
  });

  assert.equal(await findOrCreateInventoryItem(deps, SHOP_ID, 'flour', 'kg'), 'inv-2');
  assert.equal(db.callsTo('select', 'inventoryItems').length, 2);
  assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
});

test('inventory lookup: an unknown name is created at zero stock', async () => {
  const { db, deps } = harness({
    responses: { 'select:inventoryItems': [[], []], 'insert:inventoryItems': [[{ id: 'inv-3' }]] },
  });

  assert.equal(await findOrCreateInventoryItem(deps, SHOP_ID, '  Tahini ', 'kg'), 'inv-3');
  assert.deepEqual(db.onlyCallTo('insert', 'inventoryItems').values, {
    shopId: SHOP_ID,
    name: 'Tahini',
    unit: 'kg',
    currentQuantity: '0.000',
  });
});

test('inventory lookup: only the six known units are stored, anything else becomes "unit"', async () => {
  const cases: Array<[string | null, string]> = [
    ['kg', 'kg'],
    ['g', 'g'],
    ['ml', 'ml'],
    ['pack', 'pack'],
    ['lbs', 'unit'],
    ['null', 'unit'],
    ['', 'unit'],
    [null, 'unit'],
  ];

  for (const [supplied, expected] of cases) {
    const { db, deps } = harness({
      responses: { 'select:inventoryItems': [[], []], 'insert:inventoryItems': [[{ id: 'inv-4' }]] },
    });
    await findOrCreateInventoryItem(deps, SHOP_ID, 'Saffron', supplied);
    const created = db.onlyCallTo('insert', 'inventoryItems').values as { unit: string };
    assert.equal(created.unit, expected, `unit ${String(supplied)} became ${created.unit}`);
  }
});

// ---------------------------------------------------------------------------
// applyPurchase
// ---------------------------------------------------------------------------

test('purchase: rolls the weighted moving average forward and writes numeric strings', async () => {
  const { db, deps } = harness({
    responses: {
      'select:inventoryItems': [[{ currentQuantity: '10.000', averageUnitCost: '4.0000' }]],
    },
  });

  await applyPurchase(deps, 'inv-1', 10, 6);

  const update = db.onlyCallTo('update', 'inventoryItems');
  const patch = update.set as Record<string, unknown>;
  assert.equal(patch.currentQuantity, '20.000');
  assert.equal(patch.averageUnitCost, '5.0000');
  assert.equal(patch.lastUnitCost, '6.0000');
  assert.ok(patch.updatedAt instanceof Date, 'updatedAt must be stamped');
});

test('purchase: a missing inventory row is a no-op rather than a crash', async () => {
  const { db, deps } = harness({ responses: { 'select:inventoryItems': [[]] } });

  await applyPurchase(deps, 'inv-missing', 10, 6);

  assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
});

test('purchase: a zero-quantity line keeps the previous average instead of dividing by zero', async () => {
  const { db, deps } = harness({
    responses: {
      'select:inventoryItems': [[{ currentQuantity: '0.000', averageUnitCost: '7.5000' }]],
    },
  });

  await applyPurchase(deps, 'inv-1', 0, 3);

  const patch = db.onlyCallTo('update', 'inventoryItems').set as Record<string, unknown>;
  assert.equal(patch.currentQuantity, '0.000');
  assert.equal(patch.averageUnitCost, '7.5000');
});

// ---------------------------------------------------------------------------
// processReceipt
// ---------------------------------------------------------------------------

test('receipt: replaces the stored lines and stamps the receipt complete inside one transaction', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:receipts': [[{ id: 'rcpt-1' }]], ...ONE_ITEM_FOUND },
    extractions: { receipt: receipt() },
  });

  await processReceipt(deps, jobData, job);

  assert.equal(db.transactionCount, 1);

  const removal = db.onlyCallTo('delete', 'receiptItems');
  assert.equal(removal.inTransaction, true, 'old lines must be removed inside the transaction');

  const line = db.onlyCallTo('insert', 'receiptItems');
  assert.equal(line.inTransaction, true);
  assert.deepEqual(line.values, {
    shopId: SHOP_ID,
    receiptId: 'rcpt-1',
    inventoryItemId: 'inv-1',
    rawName: 'Flour',
    quantity: '2.000',
    unitPrice: '3.5000',
    totalPrice: '7.00',
    unit: 'kg',
    confidence: '0.912',
  });

  const header = db.callsTo('update', 'receipts').find((c) => c.set?.status === 'completed')!;
  const patch = header.set as Record<string, unknown>;
  assert.equal(patch.status, 'completed');
  assert.equal(patch.totalAmount, '7.00');
  assert.equal(patch.taxAmount, '12.30');
  assert.equal(patch.currency, 'ILS');
  assert.equal(patch.receiptDate, '2026-09-30');
  assert.equal(patch.merchantName, 'Shufersal');
  assert.equal(patch.errorMessage, null, 'a previous failure message must be cleared');
});

test('receipt: the header total falls back to the sum of the line totals', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:receipts': [[{ id: 'rcpt-1' }]], ...ONE_ITEM_FOUND },
    extractions: {
      receipt: receipt({
        items: [
          { rawName: 'Flour', quantity: 2, unit: 'kg', unitPrice: 3.5, totalPrice: 7, confidence: 0.9 },
          { rawName: 'Oil', quantity: 1, unit: 'l', unitPrice: 10, totalPrice: null, confidence: 0.5 },
        ],
      }),
    },
  });

  await processReceipt(deps, jobData, job);

  const patch = db.callsTo('update', 'receipts').find((c) => c.set?.status === 'completed')!.set as Record<string, unknown>;
  assert.equal(patch.totalAmount, '7.00');
});

test('receipt: a total reported by the model wins over the derived sum', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:receipts': [[{ id: 'rcpt-1' }]], ...ONE_ITEM_FOUND },
    extractions: { receipt: receipt({ totalAmount: 42.5 }) },
  });

  await processReceipt(deps, jobData, job);

  const patch = db.callsTo('update', 'receipts').find((c) => c.set?.status === 'completed')!.set as Record<string, unknown>;
  assert.equal(patch.totalAmount, '42.50');
});

test('receipt: a missing receipt row writes nothing at all', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:receipts': [[]] },
    extractions: { receipt: receipt() },
  });

  await processReceipt(deps, jobData, job);

  // Progress tracking updates happen before the early return
  assert.ok(db.callsTo('update', 'receipts').length >= 1);
  assert.equal(db.callsTo('insert', 'receiptItems').length, 0);
  // No completed status update
  assert.equal(db.callsTo('update', 'receipts').filter((c) => c.set?.status === 'completed').length, 0);
});

test('receipt: unreadable fields are stored as null rather than as placeholders', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:receipts': [[{ id: 'rcpt-1' }]],
      'select:inventoryItems': [[], []],
      'insert:inventoryItems': [[{ id: 'inv-1' }]],
      'insert:receiptItems': [[{ id: 'ri-1' }]],
    },
    extractions: {
      receipt: receipt({
        taxAmount: null,
        items: [
          { rawName: 'Mystery', quantity: null, unit: null, unitPrice: null, totalPrice: null, confidence: null },
        ],
      }),
    },
  });

  await processReceipt(deps, jobData, job);

  const line = db.onlyCallTo('insert', 'receiptItems').values as Record<string, unknown>;
  assert.equal(line.quantity, null);
  assert.equal(line.unitPrice, null);
  assert.equal(line.totalPrice, null);
  assert.equal(line.confidence, null);
  assert.equal(line.unit, null);

  const patch = db.callsTo('update', 'receipts').find((c) => c.set?.status === 'completed')!.set as Record<string, unknown>;
  assert.equal(patch.taxAmount, null);
  assert.equal(patch.totalAmount, '0.00');
});

test('receipt: a line with no usable quantity or price never moves inventory', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:receipts': [[{ id: 'rcpt-1' }]],
      'select:inventoryItems': [[{ id: 'inv-1' }]],
      'insert:receiptItems': [[{ id: 'ri-1' }]],
    },
    extractions: {
      receipt: receipt({
        totalAmount: 7,
        items: [
          { rawName: 'Flour', quantity: null, unit: 'kg', unitPrice: 3.5, totalPrice: 7, confidence: 1 },
        ],
      }),
    },
  });

  await processReceipt(deps, jobData, job);

  assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
});

test('receipt: an unusable model response fails the job', async () => {
  const { deps, job, jobData } = harness({ extractions: { receipt: null } });

  await assert.rejects(
    () => processReceipt(deps, jobData, job),
    /Gemini returned no parsable receipt extraction/,
  );
});

test('receipt: the document bytes are fetched by storage path and sent base64-encoded', async () => {
  const { deps, job, jobData, extracted } = harness({
    responses: { 'select:receipts': [[]] },
    extractions: { receipt: receipt() },
  });

  await processReceipt(deps, jobData, job);

  assert.deepEqual(extracted, [
    {
      storagePath: STORAGE_PATH,
      mimeType: 'image/jpeg',
      data: Buffer.from([104, 105]).toString('base64'),
    },
  ]);
});

// ---------------------------------------------------------------------------
// processRecipe
// ---------------------------------------------------------------------------

const RECIPE = {
  name: 'Focaccia',
  description: 'No-knead',
  prepTimeMinutes: 30,
  yieldQuantity: 8,
  yieldUnit: 'trays',
  allergens: ['gluten'],
  instructions: 'Bake.',
  ingredients: [
    { rawName: 'Flour', quantity: 2, unit: 'kg' },
    { rawName: 'Salt', quantity: null, unit: 'kg' },
  ],
};

test('recipe: stores the recipe and links only the ingredients it could price', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:shops': [[{ hourlyLaborCost: '12.00', targetProfitMargin: '30.00' }]],
      'select:inventoryItems': [[], [], [{ id: 'inv-salt' }]],
      'insert:inventoryItems': [[{ id: 'inv-flour' }]],
      'insert:recipes': [[{ id: 'rec-1', name: 'Focaccia' }]],
      'insert:recipeIngredients': [[]],
    },
    extractions: { recipe: RECIPE },
  });

  await processRecipe(deps, jobData, job);

  const recipeRow = db.onlyCallTo('insert', 'recipes').values as Record<string, unknown>;
  assert.equal(recipeRow.name, 'Focaccia');
  assert.equal(recipeRow.yieldQuantity, '8.000');
  assert.equal(recipeRow.yieldUnit, 'trays');
  assert.equal(recipeRow.prepTimeMinutes, 30);

  const bill = db.onlyCallTo('insert', 'recipeIngredients').values as Array<Record<string, unknown>>;
  assert.deepEqual(bill, [
    {
      shopId: SHOP_ID,
      recipeId: 'rec-1',
      inventoryItemId: 'inv-flour',
      quantity: '2.000',
      unit: 'kg',
    },
  ]);
});

test('recipe: a missing or non-positive yield falls back to a single portion', async () => {
  for (const yieldQuantity of [null, 0, -4]) {
    const { db, deps, job, jobData } = harness({
      responses: {
        'select:shops': [[]],
        'select:inventoryItems': [[], []],
        'insert:inventoryItems': [[]],
        'insert:recipes': [[{ id: 'rec-1', name: 'Focaccia' }]],
      },
      extractions: { recipe: { ...RECIPE, yieldQuantity, yieldUnit: null, ingredients: [] } },
    });

    await processRecipe(deps, jobData, job);

    const recipeRow = db.onlyCallTo('insert', 'recipes').values as Record<string, unknown>;
    assert.equal(recipeRow.yieldQuantity, '1.000');
    assert.equal(recipeRow.yieldUnit, 'portion');
  }
});

test('recipe: a negative prep time is clamped to zero', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:shops': [[]],
      'insert:recipes': [[{ id: 'rec-1', name: 'Focaccia' }]],
    },
    extractions: { recipe: { ...RECIPE, prepTimeMinutes: -20, ingredients: [] } },
  });

  await processRecipe(deps, jobData, job);

  const recipeRow = db.onlyCallTo('insert', 'recipes').values as Record<string, unknown>;
  assert.equal(recipeRow.prepTimeMinutes, 0);
});

test('recipe: a nameless or unusable extraction fails the job', async () => {
  const { deps, job, jobData } = harness({ extractions: { recipe: null } });
  await assert.rejects(
    () => processRecipe(deps, jobData, job),
    /Gemini returned no parsable recipe extraction/,
  );

  const nameless = harness({ extractions: { recipe: { ...RECIPE, name: null } } });
  await assert.rejects(
    () => processRecipe(nameless.deps, nameless.jobData, nameless.job),
    /Gemini returned no parsable recipe extraction/,
  );
});

test('recipe: a recipe row that never comes back fails the job rather than costing nothing', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:shops': [[]], 'insert:recipes': [[]] },
    extractions: { recipe: { ...RECIPE, ingredients: [] } },
  });

  await assert.rejects(() => processRecipe(deps, jobData, job), /recipe insert returned no row/);
  assert.equal(db.callsTo('insert', 'recipeIngredients').length, 0);
});

// ---------------------------------------------------------------------------
// processOrderDocument
// ---------------------------------------------------------------------------

const ORDER = {
  id: 'order-1',
  shopId: SHOP_ID,
  customerName: null,
  destinationAddress: null,
  deliveryFee: '5.00',
  totalCost: '0.00',
  totalAmount: '0.00',
};

const CATALOG_RECIPE = {
  id: 'rec-1',
  name: 'Focaccia',
  prepTimeMinutes: 0,
  yieldQuantity: '1.000',
  targetMarginPct: null,
};

test('order: prices matched lines from the catalog and folds in the delivery fee', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:orders': [[{ ...ORDER }]],
      'select:recipes': [[{ ...CATALOG_RECIPE }]],
      'select:shops': [[{ hourlyLaborCost: '0', targetProfitMargin: '50.00' }]],
      'select:recipeIngredients': [[{ recipeId: 'rec-1', quantity: '2.000', averageUnitCost: '3.0000' }]],
      'insert:orderItems': [[]],
    },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: {
      order: {
        customerName: 'Dana',
        destinationAddress: '12 Hayarkon',
        items: [{ name: ' focaccia ', quantity: 2, unitPrice: null }],
      },
    },
  });

  await processOrderDocument(deps, jobData, job);

  const lines = db.onlyCallTo('insert', 'orderItems').values as Array<Record<string, unknown>>;
  assert.deepEqual(lines, [
    { shopId: SHOP_ID, orderId: 'order-1', recipeId: 'rec-1', quantity: '2.000', unitCost: '6.00', unitPrice: '9.00' },
  ]);

  const patch = db.onlyCallTo('update', 'orders').set as Record<string, unknown>;
  assert.equal(patch.totalCost, '12.00');
  assert.equal(patch.totalAmount, '23.00');
  assert.equal(patch.customerName, 'Dana');
  assert.equal(patch.destinationAddress, '12 Hayarkon');
});

test('order: a stated unit price overrides the derived retail price', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:orders': [[{ ...ORDER }]],
      'select:recipes': [[{ ...CATALOG_RECIPE }]],
      'select:shops': [[{ hourlyLaborCost: '0', targetProfitMargin: '50.00' }]],
      'select:recipeIngredients': [[]],
      'insert:orderItems': [[]],
    },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Focaccia', quantity: 1, unitPrice: 20 }] } },
  });

  await processOrderDocument(deps, jobData, job);

  const lines = db.onlyCallTo('insert', 'orderItems').values as Array<Record<string, unknown>>;
  assert.equal(lines[0]?.unitPrice, '20.00');
  const patch = db.onlyCallTo('update', 'orders').set as Record<string, unknown>;
  assert.equal(patch.totalAmount, '25.00');
});

test('order: an existing customer name is never overwritten by the model', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:orders': [[{ ...ORDER, customerName: 'Already Known', destinationAddress: 'Kept' }]],
      'select:recipes': [[{ ...CATALOG_RECIPE }]],
      'select:shops': [[{ hourlyLaborCost: '0', targetProfitMargin: '50.00' }]],
      'select:recipeIngredients': [[]],
      'insert:orderItems': [[]],
    },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: {
      order: { customerName: 'Dana', destinationAddress: 'New address', items: [{ name: 'Focaccia', quantity: 1, unitPrice: null }] },
    },
  });

  await processOrderDocument(deps, jobData, job);

  const patch = db.onlyCallTo('update', 'orders').set as Record<string, unknown>;
  assert.equal('customerName' in patch, false);
  assert.equal('destinationAddress' in patch, false);
});

test('order: a missing quantity is sold as one', async () => {
  const { db, deps, job, jobData } = harness({
    responses: {
      'select:orders': [[{ ...ORDER }]],
      'select:recipes': [[{ ...CATALOG_RECIPE }]],
      'select:shops': [[{ hourlyLaborCost: '0', targetProfitMargin: '50.00' }]],
      'select:recipeIngredients': [[]],
      'insert:orderItems': [[]],
    },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Focaccia', quantity: 0, unitPrice: null }] } },
  });

  await processOrderDocument(deps, jobData, job);

  const lines = db.onlyCallTo('insert', 'orderItems').values as Array<Record<string, unknown>>;
  assert.equal(lines[0]?.quantity, '1.000');
});

test('order: a document with no target order writes nothing', async () => {
  const { db, deps, job, jobData } = harness({
    data: { kind: 'order' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Focaccia', quantity: 1, unitPrice: null }] } },
  });

  await processOrderDocument(deps, jobData, job);

  assert.equal(db.calls.length, 0);
});

test('order: an unknown order is a no-op, not a crash', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:orders': [[]] },
    data: { kind: 'order', orderId: 'order-missing' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Focaccia', quantity: 1, unitPrice: null }] } },
  });

  await processOrderDocument(deps, jobData, job);

  assert.equal(db.calls.length, 1);
  assert.equal(db.transactionCount, 0);
});

test('order: lines that match no recipe leave the order untouched', async () => {
  const { db, deps, job, jobData } = harness({
    responses: { 'select:orders': [[{ ...ORDER }]], 'select:recipes': [[]], 'select:shops': [[]] },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Mystery', quantity: 1, unitPrice: null }] } },
  });

  await processOrderDocument(deps, jobData, job);

  assert.equal(db.transactionCount, 0);
  assert.equal(db.callsTo('insert', 'orderItems').length, 0);
});

test('order: an empty or unusable extraction fails the job', async () => {
  const empty = harness({
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [] } },
  });
  await assert.rejects(
    () => processOrderDocument(empty.deps, empty.jobData, empty.job),
    /Gemini returned no parsable order extraction/,
  );

  const nulled = harness({
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: null },
  });
  await assert.rejects(
    () => processOrderDocument(nulled.deps, nulled.jobData, nulled.job),
    /Gemini returned no parsable order extraction/,
  );
});

// ---------------------------------------------------------------------------
// recordTerminalFailure
// ---------------------------------------------------------------------------

test('terminal failure: marks the receipt failed with a shop-safe message', async () => {
  const { db, deps, jobData } = harness();

  await recordTerminalFailure(deps, jobData, Object.assign(new Error('boom'), { status: 402 }));

  const patch = db.onlyCallTo('update', 'receipts').set as Record<string, unknown>;
  assert.equal(patch.status, 'failed');
  assert.match(String(patch.errorMessage), /no prepaid credit left/);
});

test('terminal failure: the stored message is capped so it always fits the column', async () => {
  const { db, deps, jobData } = harness();

  await recordTerminalFailure(deps, jobData, new Error('x'.repeat(5000)));

  const stored = String((db.onlyCallTo('update', 'receipts').set as Record<string, unknown>).errorMessage);
  assert.ok(stored.length <= 1000, `stored message was ${stored.length} chars`);
  assert.ok(stored.length < 5000, 'the raw upstream text must not be stored verbatim');
  assert.match(stored, /\.\.\.$/);
});

test('terminal failure: a recipe or order job never touches a receipt row', async () => {
  const { db, deps, jobData } = harness({ data: { kind: 'recipe' } });

  await recordTerminalFailure(deps, jobData, new Error('boom'));

  assert.equal(db.calls.length, 0);
});

test('terminal failure: a failing update is swallowed so the job still reports its own error', async () => {
  const { db, deps, jobData } = harness();
  db.failOn('update', 'receipts', new Error('connection reset'));

  await recordTerminalFailure(deps, jobData, new Error('boom'));

  assert.equal(db.callsTo('update', 'receipts').length, 1);
});

// ---------------------------------------------------------------------------
// runJob
// ---------------------------------------------------------------------------

test('runJob: routes every media kind to its handler', async () => {
  const orderRun = harness({
    responses: { 'select:orders': [[{ ...ORDER }]], 'select:recipes': [[]], 'select:shops': [[]] },
    data: { kind: 'order', orderId: 'order-1' },
    extractions: { order: { customerName: null, destinationAddress: null, items: [{ name: 'Focaccia', quantity: 1, unitPrice: null }] } },
  });
  await runJob(orderRun.jobData, orderRun.job, orderRun.deps);
  assert.equal(orderRun.db.callsTo('select', 'recipes').length, 1, 'order documents read the catalog');
  assert.equal(orderRun.db.callsTo('insert', 'orderItems').length, 0, 'an unmatched catalog writes no lines');

  // `product` shares the recipe pipeline.
  const productRun = harness({
    responses: { 'select:shops': [[]], 'insert:recipes': [[{ id: 'rec-1', name: 'Bread' }]] },
    data: { kind: 'product' },
    extractions: { recipe: { ...RECIPE, ingredients: [] } },
  });
  await runJob(productRun.jobData, productRun.job, productRun.deps);
  assert.equal(productRun.db.onlyCallTo('insert', 'recipes').inTransaction, true);

  const recipeRun = harness({ data: { kind: 'recipe' }, extractions: { recipe: null } });
  await assert.rejects(() => runJob(recipeRun.jobData, recipeRun.job, recipeRun.deps), /recipe extraction/);

  const receiptRun = harness({
    responses: { 'select:receipts': [[]] },
    extractions: { receipt: receipt() },
  });
  await runJob(receiptRun.jobData, receiptRun.job, receiptRun.deps);
  assert.equal(receiptRun.extracted.length, 1, 'receipt jobs call the receipt extractor');
});

test('runJob: an unknown kind is rejected', async () => {
  const { deps, job, jobData } = harness();
  // The kind is deliberately off-union: the route must reject it at runtime.
  const bogus = { ...jobData, kind: 'invoice' } as unknown as MediaJobData;

  await assert.rejects(() => runJob(bogus, job, deps), /Unsupported job kind: invoice/);
});

test('runJob: a permanent upstream failure stops retrying and records the receipt', async () => {
  const error = Object.assign(new Error('quota'), { status: 402 });
  const { db, deps, job, jobData } = harness();
  deps.extractReceipt = async () => {
    throw error;
  };

  await assert.rejects(
    () => runJob(jobData, job, deps),
    (thrown: unknown) => {
      assert.ok(thrown instanceof UnrecoverableError, 'must not be retried');
      assert.match((thrown as Error).message, /no prepaid credit left/);
      return true;
    },
  );

  // The final failure update is the last one (progress tracking happens first)
  const failureUpdate = db.callsTo('update', 'receipts').pop()!;
  assert.equal((failureUpdate.set as Record<string, unknown>).status, 'failed');
});

test('runJob: a transient failure is rethrown untouched and records nothing', async () => {
  const error = new Error('ECONNRESET');
  const { db, deps, job, jobData } = harness();
  deps.extractReceipt = async () => {
    throw error;
  };

  await assert.rejects(() => runJob(jobData, job, deps), (thrown: unknown) => thrown === error);
  // Progress tracking updates happen before the failure, but no terminal failure is recorded
  assert.equal(db.callsTo('update', 'receipts').filter((c) => c.set?.status === 'failed').length, 0);
});

test('runJob: a model-not-found 404 rotates the ladder instead of killing the job', async () => {
  const error = Object.assign(new Error('models/x is not found for API version v1beta'), { status: 404 });
  const { db, deps, job, jobData } = harness();
  deps.extractReceipt = async () => {
    throw error;
  };

  await assert.rejects(() => runJob(jobData, job, deps), (thrown: unknown) => thrown === error);
  // Progress tracking updates happen before the failure, but no terminal failure is recorded
  assert.equal(db.callsTo('update', 'receipts').filter((c) => c.set?.status === 'failed').length, 0);
});

test('runJob: a permanent failure on a non-receipt job records no receipt', async () => {
  const { db, deps, job, jobData } = harness({ data: { kind: 'recipe' } });
  deps.extractRecipe = async () => {
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  };

  await assert.rejects(() => runJob(jobData, job, deps), UnrecoverableError);
  assert.equal(db.calls.length, 0);
});