// src/domain/validate-product-form.test.ts
import {
  MAX_NAME_LENGTH,
  MAX_QUANTITY,
  PRODUCT_FORM_MESSAGES,
  ProductFormInput,
  validateProductForm,
} from './validate-product-form';

const NOW = new Date(2026, 9, 15, 12, 30);

function makeInput(overrides: Partial<ProductFormInput> = {}): ProductFormInput {
  return { name: 'Молоко', quantity: '2', unit: 'л', expiryDate: '2026-10-20', ...overrides };
}

function getErrors(input: ProductFormInput) {
  const result = validateProductForm(input, NOW);
  if (result.isValid) throw new Error('Ожидалась ошибка валидации');
  return result.errors;
}

describe('validateProductForm', () => {
  describe('позитивные случаи', () => {
    it('принимает корректные данные и возвращает нормализованное значение', () => {
      const result = validateProductForm(makeInput(), NOW);
      expect(result).toEqual({
        isValid: true,
        value: { name: 'Молоко', quantity: 2, unit: 'л', expiryDate: new Date(2026, 9, 20) },
      });
    });

    it('обрезает пробелы в названии', () => {
      const result = validateProductForm(makeInput({ name: '  Хлеб  ' }), NOW);
      expect(result.isValid && result.value.name).toBe('Хлеб');
    });

    it('принимает дробное количество с запятой и с точкой', () => {
      const comma = validateProductForm(makeInput({ quantity: '1,5' }), NOW);
      const dot = validateProductForm(makeInput({ quantity: '1.5' }), NOW);
      expect(comma.isValid && comma.value.quantity).toBe(1.5);
      expect(dot.isValid && dot.value.quantity).toBe(1.5);
    });

    it.each([undefined, '', '   '])('срок годности необязателен (%p)', (expiryDate) => {
      const result = validateProductForm(makeInput({ expiryDate }), NOW);
      expect(result.isValid && result.value.expiryDate).toBeNull();
    });
  });

  describe('название', () => {
    it.each(['', '   '])('отклоняет пустое название (%p)', (name) => {
      expect(getErrors(makeInput({ name })).name).toBe(PRODUCT_FORM_MESSAGES.nameRequired);
    });

    it('принимает название максимальной длины', () => {
      const name = 'а'.repeat(MAX_NAME_LENGTH);
      expect(validateProductForm(makeInput({ name }), NOW).isValid).toBe(true);
    });

    it('отклоняет название длиннее максимума', () => {
      const name = 'а'.repeat(MAX_NAME_LENGTH + 1);
      expect(getErrors(makeInput({ name })).name).toBe(PRODUCT_FORM_MESSAGES.nameTooLong);
    });
  });

  describe('количество', () => {
    it.each(['', 'abc', '1e3', '-1', '1.2.3', '1 000'])(
      'отклоняет нечисловой ввод (%p)',
      (quantity) => {
        expect(getErrors(makeInput({ quantity })).quantity).toBe(
          PRODUCT_FORM_MESSAGES.quantityInvalid,
        );
      },
    );

    it.each(['0', '0,0'])('отклоняет ноль (%p)', (quantity) => {
      expect(getErrors(makeInput({ quantity })).quantity).toBe(
        PRODUCT_FORM_MESSAGES.quantityNotPositive,
      );
    });

    it('принимает максимальное количество', () => {
      const quantity = String(MAX_QUANTITY);
      expect(validateProductForm(makeInput({ quantity }), NOW).isValid).toBe(true);
    });

    it('отклоняет количество выше максимума', () => {
      const quantity = String(MAX_QUANTITY + 1);
      expect(getErrors(makeInput({ quantity })).quantity).toBe(
        PRODUCT_FORM_MESSAGES.quantityTooLarge,
      );
    });
  });

  describe('единица измерения', () => {
    it.each(['шт', 'г', 'кг', 'мл', 'л'])('принимает %s', (unit) => {
      expect(validateProductForm(makeInput({ unit }), NOW).isValid).toBe(true);
    });

    it.each(['', 'штук', 'KG'])('отклоняет неизвестную единицу (%p)', (unit) => {
      expect(getErrors(makeInput({ unit })).unit).toBe(PRODUCT_FORM_MESSAGES.unitInvalid);
    });
  });

  describe('срок годности', () => {
    it('принимает сегодняшнюю дату (граница)', () => {
      expect(validateProductForm(makeInput({ expiryDate: '2026-10-15' }), NOW).isValid).toBe(
        true,
      );
    });

    it('отклоняет вчерашнюю дату (граница)', () => {
      expect(getErrors(makeInput({ expiryDate: '2026-10-14' })).expiryDate).toBe(
        PRODUCT_FORM_MESSAGES.expiryInPast,
      );
    });

    it.each(['15.10.2026', '2026-10-5', 'завтра', '2026-02-30', '2026-13-01'])(
      'отклоняет неверный формат или несуществующую дату (%p)',
      (expiryDate) => {
        expect(getErrors(makeInput({ expiryDate })).expiryDate).toBe(
          PRODUCT_FORM_MESSAGES.expiryInvalid,
        );
      },
    );
  });

  it('возвращает ошибки по всем невалидным полям сразу', () => {
    const errors = getErrors({ name: '', quantity: 'x', unit: '?', expiryDate: '2020-01-01' });
    expect(Object.keys(errors).sort()).toEqual(['expiryDate', 'name', 'quantity', 'unit']);
  });

  it('не изменяет входной объект', () => {
    const input = makeInput({ name: '  Сыр ' });
    const copy = { ...input };
    validateProductForm(input, NOW);
    expect(input).toEqual(copy);
  });
});
