import { GoogleGenAI, type Part } from '@google/genai';
import pino from 'pino';
import { env, isDevelopment } from '../env.js';
import { httpStatus, isPermanentError, isUnknownModelError } from './jobErrors.js';
import { ModelLadder, type FlagReason } from './modelLadder.js';
import type { MediaKind } from './queue.js';

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  // pino-pretty logs through a worker thread, so it is limited to development;
  // tests and CI use plain JSON and the process is free to exit.
  ...(isDevelopment ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});

/**
 * Creates a promise that rejects after the configured Gemini request timeout.
 * Used to enforce a hard deadline on the underlying HTTP call since the
 * Google GenAI SDK does not yet accept an AbortSignal on generateContent.
 */
function createGeminiTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Gemini request timed out after ${env.GEMINI_REQUEST_TIMEOUT_MS}ms`));
    }, env.GEMINI_REQUEST_TIMEOUT_MS);
    timer.unref(); // Don't prevent process exit while waiting
  });
}

/**
 * Vision models to draw from. Google serves each model from its own capacity
 * pool, so a 503 on one frequently succeeds on another — that rotation is the
 * whole point. Selection is random rather than in-order: every worker walking
 * the same order in lockstep rediscovers the same outage in the same sequence,
 * which keeps a just-recovered model saturated.
 * Configurable via GEMINI_MODELS so the pool can be retuned without a redeploy.
 */
const MODELS = env.GEMINI_MODELS.split(',')
  .map((m) => m.trim())
  .filter(Boolean);

if (MODELS.length === 0) {
  throw new Error('GEMINI_MODELS resolved to an empty model list');
}

/**
 * Shared across every job in this process. A model one job found at capacity is
 * very likely still at capacity for the next few seconds, and a per-call
 * selection would make each job pay to rediscover that.
 */
const ladder = new ModelLadder({
  models: MODELS,
  flagTtlMs: env.GEMINI_MODEL_FLAG_TTL_MS,
});

export interface ExtractedLineItem {
  rawName: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  confidence: number | null;
}

export interface ReceiptExtraction {
  merchantName: string | null;
  receiptDate: string | null;
  totalAmount: number | null;
  taxAmount: number | null;
  currency: string | null;
  items: ExtractedLineItem[];
}

export interface RecipeExtraction {
  name: string | null;
  description: string | null;
  prepTimeMinutes: number | null;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  allergens: string[];
  instructions: string | null;
  ingredients: { rawName: string; quantity: number | null; unit: string | null }[];
}

export interface OrderExtraction {
  customerName: string | null;
  destinationAddress: string | null;
  items: { name: string; quantity: number | null; unitPrice: number | null }[];
}

const RECEIPT_SCHEMA = `{
  "type": "object",
  "properties": {
    "merchantName": { "type": "string" },
    "receiptDate": { "type": "string", "description": "ISO date YYYY-MM-DD" },
    "totalAmount": { "type": "number" },
    "taxAmount": { "type": "number" },
    "currency": { "type": "string", "description": "ISO 4217, 3 letters" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "rawName": { "type": "string" },
          "quantity": { "type": "number" },
          "unit": { "type": "string" },
          "unitPrice": { "type": "number" },
          "totalPrice": { "type": "number" },
          "confidence": { "type": "number" }
        },
        "required": ["rawName"]
      }
    }
  },
  "required": ["items"]
}`;

const RECIPE_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "prepTimeMinutes": { "type": "number" },
    "yieldQuantity": { "type": "number" },
    "yieldUnit": { "type": "string" },
    "allergens": { "type": "array", "items": { "type": "string" } },
    "instructions": { "type": "string" },
    "ingredients": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "rawName": { "type": "string" },
          "quantity": { "type": "number" },
          "unit": { "type": "string" }
        },
        "required": ["rawName"]
      }
    }
  },
  "required": ["name", "ingredients"]
}`;

const ORDER_SCHEMA = `{
  "type": "object",
  "properties": {
    "customerName": { "type": "string" },
    "destinationAddress": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "quantity": { "type": "number" },
          "unitPrice": { "type": "number" }
        },
        "required": ["name"]
      }
    }
  },
  "required": ["items"]
}`;

const PROMPTS: Record<MediaKind, { instruction: string; schema: string }> = {
  receipt: {
    instruction:
      'Extract this shopping receipt. Return the merchant name, purchase date, grand total, tax, currency, and every purchased line item with its quantity, unit, unit price and line total. Use null for anything you cannot read. Never invent values.',
    schema: RECEIPT_SCHEMA,
  },
  recipe: {
    instruction:
      'Extract this recipe (handwritten or printed). Return the recipe name, short description, preparation time in minutes, how many portions it yields and their unit, the allergen list, the preparation instructions, and every ingredient with its quantity and unit. Use null for anything you cannot read. Never invent values.',
    schema: RECIPE_SCHEMA,
  },
  product: {
    instruction:
      'Extract this finished food or packaged product photo. Return a short product name, description, approximate preparation time in minutes and the ingredient list you can infer. Use null for anything you cannot read. Never invent values.',
    schema: RECIPE_SCHEMA,
  },
  order: {
    instruction:
      'Extract this customer order document or catering order sheet. Return the customer name, the destination address if printed, and each ordered line with its quantity and unit price. Use null for anything you cannot read. Never invent values.',
    schema: ORDER_SCHEMA,
  },
};

const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseJson<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

/**
 * Raised when a model answers but the payload is unusable (empty text, or JSON
 * that will not parse). Distinct from an API error: nothing is wrong with the
 * request, the model just did not honour the response schema. Worth another
 * model, because older vision models often ignore `responseSchema` outright.
 */
class UnusableResponseError extends Error {
  constructor(
    readonly model: string,
    readonly reason: string,
  ) {
    super(`model ${model} ${reason}`);
    this.name = 'UnusableResponseError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies a failure as the model's fault, so only those sideline a model.
 */
function shouldFlagModel(error: unknown): FlagReason | null {
  if (error instanceof UnusableResponseError) return 'unusable-response';
  if (isUnknownModelError(error)) return 'unknown-model';
  const status = httpStatus(error);
  // 429 and 5xx are the model's own capacity. Anything else (timeout, socket
  // reset, DNS) is the path, not the model: flagging on those would sideline
  // the entire pool during a network blip.
  if (status === 429) return 'rate-limited';
  if (status !== null && status >= 500) return 'unavailable';
  return null;
}

/**
 * Exponential backoff with full jitter. Jitter matters here: several workers
 * hit a capacity wall at the same moment, and without it they resync on every
 * retry and stampede the model that just recovered.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(
    env.GEMINI_RETRY_BASE_DELAY_MS * 2 ** attempt,
    env.GEMINI_RETRY_MAX_DELAY_MS,
  );
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/**
 * Picks models at random from the ones not recently sidelined, flagging each
 * model whose failure was its own doing. The flag memory is shared across jobs
 * on purpose: one worker discovering that a model is at capacity should spare
 * every other worker from rediscovering it.
 *
 * Returns null only when models answered but produced nothing usable, which
 * preserves the caller's existing contract.
 */
async function runStructured<T>(kind: MediaKind, part: Part): Promise<T | null> {
  const { instruction, schema } = PROMPTS[kind];
  const attemptedModels = new Set<string>();
  const unusableModels = new Set<string>();

  for (let attempt = 0; attempt < env.GEMINI_MAX_ATTEMPTS; attempt++) {
    const model = ladder.pick();
    attemptedModels.add(model);

    try {
      const response = await Promise.race([
        client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [part, { text: instruction }] }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: JSON.parse(schema) as unknown as Record<string, unknown>,
            temperature: 0.1,
          },
        }),
        createGeminiTimeout(),
      ]);

      const text = response.text;
      if (!text) throw new UnusableResponseError(model, 'returned no text');
      return parseJson<T>(text);
    } catch (error) {
      const unusable = error instanceof UnusableResponseError || isUnknownModelError(error);
      // Auth, billing, malformed requests and oversize payloads will fail
      // identically on every model, so they end the job immediately.
      const fatal = isPermanentError(error) && !unusable;
      const exhausted = attempt === env.GEMINI_MAX_ATTEMPTS - 1;

      // Sidelining happens on every model-attributable failure, including the
      // last one: another job should not walk into the same dead model.
      const reason = shouldFlagModel(error);
      if (reason) ladder.flag(model, reason);

      if (fatal) throw error;

      if (exhausted) {
        // Every attempt failed and the cause was an unusable model. If they
        // were all *unknown* models, the ladder never got a single usable
        // response, so say that instead of blaming the parse.
        if (unusable) {
          if (unusableModels.size === attemptedModels.size) {
            throw new Error(
              `No available vision model. Tried and rejected as unavailable: ${[...attemptedModels].join(', ')}. Update GEMINI_MODELS.`,
            );
          }
          return null;
        }
        throw error;
      }

      if (unusable) unusableModels.add(model);

      logger.warn(
        {
          model,
          attempt: attempt + 1,
          maxAttempts: env.GEMINI_MAX_ATTEMPTS,
          flagged: reason,
          nextPick: 'random from unflagged',
          err: error,
        },
        reason
          ? 'gemini model sidelined, picking another'
          : 'gemini call failed, retrying another model',
      );
      await sleep(backoffDelay(attempt));
    }
  }

  return null;
}

export async function extractReceipt(
  inlineData: { mimeType: string; data: string },
): Promise<ReceiptExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('receipt', {
    inlineData,
  });
  if (!raw) return null;

  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    merchantName: asString(raw.merchantName),
    receiptDate: asString(raw.receiptDate),
    totalAmount: asNumber(raw.totalAmount),
    taxAmount: asNumber(raw.taxAmount),
    currency: asString(raw.currency)?.toUpperCase() ?? null,
    items: items.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        rawName: asString(item.rawName) ?? 'Unknown item',
        quantity: asNumber(item.quantity),
        unit: asString(item.unit),
        unitPrice: asNumber(item.unitPrice),
        totalPrice: asNumber(item.totalPrice),
        confidence: asNumber(item.confidence),
      };
    }),
  };
}

export async function extractRecipe(
  inlineData: { mimeType: string; data: string },
): Promise<RecipeExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('recipe', { inlineData });
  if (!raw) return null;

  const ingredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    prepTimeMinutes: asNumber(raw.prepTimeMinutes),
    yieldQuantity: asNumber(raw.yieldQuantity),
    yieldUnit: asString(raw.yieldUnit),
    allergens: Array.isArray(raw.allergens)
      ? raw.allergens.filter((a): a is string => typeof a === 'string')
      : [],
    instructions: asString(raw.instructions),
    ingredients: ingredients.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        rawName: asString(item.rawName) ?? 'Unknown ingredient',
        quantity: asNumber(item.quantity),
        unit: asString(item.unit),
      };
    }),
  };
}

export async function extractOrder(
  inlineData: { mimeType: string; data: string },
): Promise<OrderExtraction | null> {
  const raw = await runStructured<Record<string, unknown>>('order', { inlineData });
  if (!raw) return null;

  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    customerName: asString(raw.customerName),
    destinationAddress: asString(raw.destinationAddress),
    items: items.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        name: asString(item.name) ?? 'Unknown item',
        quantity: asNumber(item.quantity),
        unitPrice: asNumber(item.unitPrice),
      };
    }),
  };
}