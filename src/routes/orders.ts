import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import { orderItems, orders, recipes } from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { money, quantity as qty, toNumber } from '../lib/money.js';
import {
  calculateDeliveryFee,
  calculateOrderTotals,
  calculateRetailPrice,
  calculateUnitCost,
} from '../lib/pricing.js';
import { recipeIngredients, inventoryItems } from '../db/schema/index.js';

const orderItemSchema = z.object({
  recipeId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(100_000),
  /** Optional override; when omitted the recipe retail price is used. */
  unitPrice: z.coerce.number().min(0).nullable().optional(),
});

const createOrderSchema = z.object({
  customerName: z.string().trim().max(160).nullable().optional(),
  orderDate: z.coerce.date().optional(),
  destinationAddress: z.string().trim().max(300).nullable().optional(),
  deliveryDistanceKm: z.coerce.number().min(0).max(20_000).default(0),
  documentUrl: z.string().trim().max(500).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
});

async function priceOrderItems(
  shopId: string,
  shopMargin: string,
  hourlyLaborCost: string,
  items: { recipeId: string; quantity: number; unitPrice?: number | null }[],
) {
  const recipeIds = [...new Set(items.map((item) => item.recipeId))];
  if (recipeIds.length === 0) return [];

  const recipeRows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, shopId), inArray(recipes.id, recipeIds)));

  const ingredientRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .where(eq(recipeIngredients.shopId, shopId));

  const byRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    const list = byRecipe.get(row.recipeId) ?? [];
    list.push(row);
    byRecipe.set(row.recipeId, list);
  }

  return items.map((item) => {
    const recipe = recipeRows.find((row) => row.id === item.recipeId);
    if (!recipe) throw notFound(`Recipe ${item.recipeId} not found`);

    const breakdown = calculateUnitCost({
      ingredients: (byRecipe.get(recipe.id) ?? []).map((row) => ({
        quantity: row.quantity,
        averageUnitCost: row.averageUnitCost,
      })),
      prepTimeMinutes: recipe.prepTimeMinutes,
      hourlyLaborCost,
      yieldQuantity: recipe.yieldQuantity,
    });

    const { retailPrice, appliedMarginPercent } = calculateRetailPrice(
      breakdown.unitCost,
      shopMargin,
      recipe.targetMarginPct,
    );

    return {
      recipeId: recipe.id,
      name: recipe.name,
      quantity: item.quantity,
      unitCost: breakdown.unitCost,
      unitPrice: item.unitPrice ?? retailPrice,
      appliedProfitMargin: appliedMarginPercent,
      retailPrice,
    };
  });
}

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };

  app.get('/orders', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const conditions = [eq(orders.shopId, shop.id), isNull(orders.deletedAt)];
    if (query.from) conditions.push(sql`${orders.orderDate} >= ${query.from}`);
    if (query.to) conditions.push(sql`${orders.orderDate} <= ${query.to}`);
    if (query.search) {
      conditions.push(sql`${orders.customerName} ilike ${`%${query.search}%`}`);
    }

    const rows = await db
      .select()
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.orderDate), desc(orders.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const totalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(...conditions));

    return {
      orders: rows.map((order) => ({
        ...order,
        netProfit: toNumber(order.totalAmount) - toNumber(order.deliveryFee) - toNumber(order.totalCost),
      })),
      total: totalRows[0]?.count ?? 0,
    };
  });

  app.get('/orders/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shop.id), isNull(orders.deletedAt)))
      .limit(1);
    const order = rows[0];
    if (!order) throw notFound('Order not found');

    const items = await db
      .select({
        id: orderItems.id,
        recipeId: orderItems.recipeId,
        name: recipes.name,
        quantity: orderItems.quantity,
        unitCost: orderItems.unitCost,
        unitPrice: orderItems.unitPrice,
      })
      .from(orderItems)
      .innerJoin(recipes, eq(recipes.id, orderItems.recipeId))
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.id));

    return {
      order: {
        ...order,
        items,
        netProfit:
          toNumber(order.totalAmount) -
          toNumber(order.deliveryFee) -
          toNumber(order.totalCost),
      },
    };
  });

  /** Live pricing for the New Order screen before anything is persisted. */
  app.post('/orders/quote', guards, async (request) => {
    const shop = currentShop(request);
    const body = z
      .object({
        deliveryDistanceKm: z.coerce.number().min(0).default(0),
        items: z.array(orderItemSchema).min(1),
      })
      .parse(request.body);

    const priced = await priceOrderItems(
      shop.id,
      shop.targetProfitMargin,
      shop.hourlyLaborCost,
      body.items,
    );

    const deliveryFee = calculateDeliveryFee(
      body.deliveryDistanceKm,
      shop.deliveryBaseFee,
      shop.deliveryRatePerKm,
    );

    const totals = calculateOrderTotals({
      items: priced.map((item) => ({
        quantity: item.quantity,
        unitCost: item.unitCost,
        unitPrice: item.unitPrice,
      })),
      deliveryFee,
    });

    return {
      items: priced,
      deliveryDistanceKm: body.deliveryDistanceKm,
      baseFee: toNumber(shop.deliveryBaseFee),
      ratePerKm: toNumber(shop.deliveryRatePerKm),
      ...totals,
    };
  });

  app.post('/orders', guards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = createOrderSchema.parse(request.body);

    const priced = await priceOrderItems(
      shop.id,
      shop.targetProfitMargin,
      shop.hourlyLaborCost,
      body.items,
    );

    const deliveryFee = calculateDeliveryFee(
      body.deliveryDistanceKm,
      shop.deliveryBaseFee,
      shop.deliveryRatePerKm,
    );

    const totals = calculateOrderTotals({
      items: priced.map((item) => ({
        quantity: item.quantity,
        unitCost: item.unitCost,
        unitPrice: item.unitPrice,
      })),
      deliveryFee,
    });

    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(orders)
        .values({
          shopId: shop.id,
          userId: user.id,
          customerName: body.customerName ?? null,
          orderDate: body.orderDate ?? new Date(),
          destinationAddress: body.destinationAddress ?? null,
          deliveryDistanceKm: toNumber(body.deliveryDistanceKm).toFixed(2),
          deliveryFee: money(deliveryFee),
          appliedProfitMargin:
            priced[0]?.appliedProfitMargin !== undefined
              ? priced[0].appliedProfitMargin.toFixed(2)
              : null,
          totalCost: money(totals.totalCost),
          totalAmount: money(totals.totalAmount),
          documentUrl: body.documentUrl ?? null,
        })
        .returning();

      const order = inserted[0];
      if (!order) throw new Error('Order insert returned no row');

      await tx.insert(orderItems).values(
        priced.map((item) => ({
          shopId: shop.id,
          orderId: order.id,
          recipeId: item.recipeId,
          quantity: qty(item.quantity),
          unitCost: money(item.unitCost),
          unitPrice: money(item.unitPrice),
        })),
      );

      return order;
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'ORDER_CREATED',
      resourceId: created.id,
      ipAddress: request.ip,
      metadata: { totalAmount: totals.totalAmount, items: priced.length },
    });

    return reply.code(201).send({ order: created, totals });
  });

  app.delete('/orders/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await db
      .delete(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shop.id)));
    return { ok: true };
  });
};
