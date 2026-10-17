export const UNITS = ['шт', 'г', 'кг', 'мл', 'л', 'уп'] as const;
export type Unit = (typeof UNITS)[number];

const INTEGER_ONLY_UNITS: ReadonlySet<Unit> = new Set(['шт', 'уп']);

export interface ProductFormInput {
  name: string;
  quantity: string;          // сырая строка из поля ввода
  unit: string;
  expiryDate?: string | null; // 'YYYY-MM-DD' или пусто
}

export type ProductField = 'name' | 'quantity' | 'unit' | 'expiryDate';

export interface ValidationResult {
  isValid: boolean;
  errors: Partial<Record<ProductField, string>>;
  warnings: Partial<Record<ProductField, string>>;
  // нормализованные значения, заполняются только при isValid
  value?: {
    name: string;
    quantity: number;
    unit: Unit;
    expiryDate: string | null;
  };
}

const NAME_MAX = 100;
const QUANTITY_MAX = 99_999;
const MAX_YEARS_AHEAD = 20;

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // защита от 2025-02-31, который Date молча переносит на март
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

export function validateProductForm(
  input: ProductFormInput,
  now: Date = new Date(), // внедряется для тестов
): ValidationResult {
  const errors: ValidationResult['errors'] = {};
  const warnings: ValidationResult['warnings'] = {};

  // Название
  const name = (input.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.name = 'Введите название продукта';
  else if (name.length > NAME_MAX)
    errors.name = `Не длиннее ${NAME_MAX} символов`;

  // Единица измерения
  const unit = (input.unit ?? '').trim();
  const unitValid = (UNITS as readonly string[]).includes(unit);
  if (!unit) errors.unit = 'Выберите единицу измерения';
  else if (!unitValid) errors.unit = 'Недопустимая единица измерения';

  // Количество
  const rawQty = (input.quantity ?? '').trim().replace(',', '.');
  let quantity = NaN;
  if (!rawQty) {
    errors.quantity = 'Введите количество';
  } else if (!/^\d+(\.\d+)?$/.test(rawQty)) {
    errors.quantity = 'Введите положительное число';
  } else {
    quantity = Number(rawQty);
    if (quantity <= 0) errors.quantity = 'Количество должно быть больше нуля';
    else if (quantity > QUANTITY_MAX)
      errors.quantity = `Не больше ${QUANTITY_MAX}`;
    else if (unitValid && INTEGER_ONLY_UNITS.has(unit as Unit) && !Number.isInteger(quantity))
      errors.quantity = `Для «${unit}» нужно целое число`;
  }

  // Срок годности (необязательный)
  const rawExpiry = (input.expiryDate ?? '').trim();
  let expiryDate: string | null = null;
  if (rawExpiry) {
    const parsed = parseIsoDate(rawExpiry);
    if (!parsed) {
      errors.expiryDate = 'Неверная дата, используйте формат ГГГГ-ММ-ДД';
    } else {
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const limit = Date.UTC(now.getFullYear() + MAX_YEARS_AHEAD, now.getMonth(), now.getDate());
      if (parsed.getTime() > limit) {
        errors.expiryDate = 'Слишком далёкая дата';
      } else {
        expiryDate = rawExpiry;
        if (parsed.getTime() < today) warnings.expiryDate = 'Срок годности уже истёк';
      }
    }
  }

  const isValid = Object.keys(errors).length === 0;
  return {
    isValid,
    errors,
    warnings,
    value: isValid
      ? { name, quantity, unit: unit as Unit, expiryDate }
      : undefined,
  };
}
