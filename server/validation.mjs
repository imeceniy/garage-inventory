// @ts-check
import { z } from 'zod';

const text = z.string().trim();
const nonNegative = z.coerce.number().finite().min(0);
const stringList = z.union([z.array(text), text]).transform((value) => {
  const entries = Array.isArray(value) ? value : value.split(/[\n,;]+/);
  return Array.from(new Set(entries.map((entry) => entry.trim().replace(/^#+/, '')).filter(Boolean)));
});

export const itemInputSchema = z.object({
  name: text.min(1, 'Название обязательно'),
  category: text.default('Прочее'),
  quantity: nonNegative.default(0),
  unit: text.default('шт'),
  location: text.default(''),
  locations: stringList.default([]),
  barcode: text.default(''),
  project: text.default(''),
  projects: stringList.optional(),
  tags: stringList.default([]),
  containerId: text.default(''),
  photo: text.default(''),
  minQuantity: nonNegative.default(0),
  reorderPoint: nonNegative.optional(),
  targetQuantity: nonNegative.optional(),
  note: text.default('')
});

export const itemPatchSchema = itemInputSchema.partial();

export const balanceInputSchema = z.object({
  containerId: text.default(''),
  location: text.default(''),
  quantity: nonNegative.default(0)
});

export const transferInputSchema = z.object({
  fromBalanceId: text.min(1),
  toBalanceId: text.min(1),
  amount: z.coerce.number().finite().positive()
}).refine((value) => value.fromBalanceId !== value.toBalanceId, {
  message: 'Исходное и целевое место должны отличаться'
});

export function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw Object.assign(new Error(result.error.issues[0]?.message || 'Некорректные данные'), { status: 400 });
}
