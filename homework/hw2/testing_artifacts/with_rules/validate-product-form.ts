// src/domain/validate-product-form.ts
import { isBefore, isValid, parseISO, startOfDay } from 'date-fns';

export const PRODUCT_UNITS = ['шт', 'г', 'кг', 'мл', 'л'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export const MAX_NAME_LENGTH = 100;
export const MAX_QUANTITY = 10000;

export const PRODUCT_FORM_MESSAGES = {
  nameRequired: 'Введите название продукта',
  nameTooLong: `Название не должно быть длиннее ${MAX_NAME_LENGTH} символов`,
  quantityInvalid: 'Введите количество числом, например 2 или 1,5',
  quantityNotPositive: 'Количество должно быть больше нуля',
  quantityTooLarge: `Количество не должно превышать ${MAX_QUANTITY}`,
  unitInvalid: 'Выберите единицу измерения из списка',
  expiryInvalid: 'Введите дату в формате ГГГГ-ММ-ДД',
  expiryInPast: 'Срок годности не может быть в прошлом',
} as const;

export interface ProductFormInput {
  name: string;
  quantity: string;
  unit: string;
  /** Необязательное поле: пустая строка или undefined означают «срок не указан». */
  expiryDate?: string;
}

export interface ValidProductForm {
  name: string;
  quantity: number;
  unit: ProductUnit;
  expiryDate: Date | null;
}

export type ProductFormErrors = Partial<Record<keyof ProductFormInput, string>>;

export type ProductFormValidationResult =
  | { isValid: true; value: ValidProductForm }
  | { isValid: false; errors: ProductFormErrors };

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

const QUANTITY_PATTERN = /^\d+(\.\d+)?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isProductUnit(value: string): value is ProductUnit {
  return (PRODUCT_UNITS as readonly string[]).includes(value);
}

function checkName(raw: string): FieldResult<string> {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: PRODUCT_FORM_MESSAGES.nameRequired };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: PRODUCT_FORM_MESSAGES.nameTooLong };
  }
  return { ok: true, value: name };
}

function checkQuantity(raw: string): FieldResult<number> {
  // Запятая допустима как десятичный разделитель: так вводят на русской клавиатуре.
  const normalized = raw.trim().replace(',', '.');
  if (!QUANTITY_PATTERN.test(normalized)) {
    return { ok: false, error: PRODUCT_FORM_MESSAGES.quantityInvalid };
  }
  const quantity = Number(normalized);
  if (quantity <= 0) return { ok: false, error: PRODUCT_FORM_MESSAGES.quantityNotPositive };
  if (quantity > MAX_QUANTITY) {
    return { ok: false, error: PRODUCT_FORM_MESSAGES.quantityTooLarge };
  }
  return { ok: true, value: quantity };
}

function checkUnit(raw: string): FieldResult<ProductUnit> {
  const unit = raw.trim();
  if (!isProductUnit(unit)) return { ok: false, error: PRODUCT_FORM_MESSAGES.unitInvalid };
  return { ok: true, value: unit };
}

function checkExpiryDate(raw: string | undefined, now: Date): FieldResult<Date | null> {
  const text = (raw ?? '').trim();
  if (text.length === 0) return { ok: true, value: null };
  if (!ISO_DATE_PATTERN.test(text)) {
    return { ok: false, error: PRODUCT_FORM_MESSAGES.expiryInvalid };
  }
  // parseISO отсекает несуществующие даты вроде 2026-02-30.
  const date = parseISO(text);
  if (!isValid(date)) return { ok: false, error: PRODUCT_FORM_MESSAGES.expiryInvalid };
  // Сегодняшняя дата допустима: продукт может истекать сегодня.
  if (isBefore(date, startOfDay(now))) {
    return { ok: false, error: PRODUCT_FORM_MESSAGES.expiryInPast };
  }
  return { ok: true, value: date };
}

/**
 * Проверяет данные формы добавления продукта и нормализует их.
 * Проверяются все поля сразу, чтобы пользователь увидел все ошибки за один раз.
 *
 * @param input - значения полей формы в том виде, как их ввёл пользователь.
 * @param now - текущие дата и время; домен не обращается к часам напрямую.
 * @returns `{ isValid: true, value }` с обрезанным названием, числовым количеством
 *   и датой (или null), либо `{ isValid: false, errors }` с сообщениями по полям.
 * @throws не бросает исключений: некорректный ввод описывается в результате.
 */
export function validateProductForm(
  input: ProductFormInput,
  now: Date,
): ProductFormValidationResult {
  const name = checkName(input.name);
  const quantity = checkQuantity(input.quantity);
  const unit = checkUnit(input.unit);
  const expiryDate = checkExpiryDate(input.expiryDate, now);

  if (name.ok && quantity.ok && unit.ok && expiryDate.ok) {
    return {
      isValid: true,
      value: {
        name: name.value,
        quantity: quantity.value,
        unit: unit.value,
        expiryDate: expiryDate.value,
      },
    };
  }

  const errors: ProductFormErrors = {};
  if (!name.ok) errors.name = name.error;
  if (!quantity.ok) errors.quantity = quantity.error;
  if (!unit.ok) errors.unit = unit.error;
  if (!expiryDate.ok) errors.expiryDate = expiryDate.error;
  return { isValid: false, errors };
}
