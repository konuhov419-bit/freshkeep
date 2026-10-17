# testing.md — тест системы правил (Шаг 5)

## Условия эксперимента

- **Задача (одинаковая в обоих запусках):** «В проекте FreshKeep (мобильное приложение для учёта продуктов дома) нужна функция валидации формы добавления продукта. Поля: название, количество, единица измерения, срок годности (необязательный). Реализуй её.»
- **Запуск A («до»):** модель получила только текст задачи.
- **Запуск B («после»):** тот же текст задачи плюс полный текст `rules.md` (16 правил) в начале промпта.
- Запуски независимые (два отдельных агента без общей истории), модель одна и та же, инструменты (файлы, shell, поиск) отключены, ответ только текстом. Ответ ниже вставлен без правок по существу: только убран служебный отступ.
- Важно: так как инструменты были отключены, агент в запуске B **не мог открыть** `technical_specification.md` и `user_stories.md`, хотя правила на них ссылаются. Это повлияло на результат (см. вывод).

---

## Ответ агента ДО применения правил (запуск A, сырой ответ)

Я не видел ваш код, поэтому исхожу из допущения, что стек TypeScript (React Native или подобный). Функция чистая и не зависит от фреймворка, так что её легко перенести в Dart или Kotlin.

### Правила

- **Название**: обязательное, после trim от 1 до 100 символов.
- **Количество**: обязательное, число больше 0 и не больше 99 999. Принимается запятая как десятичный разделитель ("1,5"). Для штучных единиц допускается только целое.
- **Единица измерения**: обязательная, одно значение из фиксированного списка.
- **Срок годности**: необязательный. Если указан, это валидная дата в формате `YYYY-MM-DD`. Прошедшая дата допустима, потому что пользователь может вносить уже просроченный продукт, но формально это предупреждение, а не ошибка. Слишком далёкое будущее (больше 20 лет) считается ошибкой.

### Код

```ts
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
```

### Использование

```ts
const result = validateProductForm({
  name: '  Молоко ',
  quantity: '1,5',
  unit: 'л',
  expiryDate: '2026-10-20',
});

if (result.isValid) {
  repository.add(result.value!); // уже нормализованные данные
} else {
  setFieldErrors(result.errors);  // показать под полями
}
```

### Решения, которые стоит подтвердить

1. **Прошедшая дата** сделана предупреждением, а не ошибкой. Если нужно запретить, перенесите её в `errors`.
2. **Список единиц** и набор «целочисленных» единиц (`шт`, `уп`) придуманы мной. Подставьте ваш реальный enum.
3. **Формат даты**: если date picker отдаёт `Date`, а не строку, замените `parseIsoDate` и тип `expiryDate`.
4. **Сообщения** захардкожены на русском. При локализации замените их ключами i18n.

### Тесты, которые стоит написать

- пустое название и название из одних пробелов;
- количество "0", "-1", "abc", "1,5" (с `шт` ошибка, с `кг` успех), "100000";
- несуществующая дата "2025-02-30";
- пустой срок годности (валидно, `expiryDate: null`);
- вчерашняя дата (валидно, есть warning), дата через 21 год (ошибка).

Если пришлёте реальный стек (React Native, Flutter, Kotlin, Swift) и существующие типы модели продукта, я адаптирую код под них, включая подключение к форме.

---

## Ответ агента ПОСЛЕ применения правил (запуск B, сырой ответ)

**1. План**
- Чистая функция `validateProductForm(input, now)` в `src/domain/` без I/O. Дата `now` приходит параметром.
- Функция проверяет все поля за один проход и возвращает либо нормализованное значение, либо ошибки по полям.
- Тексты ошибок на русском лежат в экспортируемой константе.
- Тесты в Jest: позитивные, негативные, граничные.

**2. Код**

```ts
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
```

**3. Тесты**

```ts
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
```

**4. Как запустить**

```bash
npm install date-fns      # если ещё не установлен
npx jest src/domain/validate-product-form.test.ts
npx tsc --noEmit
```

Изменены только два новых файла: `src/domain/validate-product-form.ts` и `src/domain/validate-product-form.test.ts`. Остальные файлы не затронуты.

**5. Допущения и открытые вопросы**

Инструментами пользоваться было нельзя, поэтому `technical_specification.md` и `user_stories.md` я не видел. Всё ниже взято из здравого смысла, а не из FR-*/ERR-*. Ссылки на требования в комментариях я не ставил, чтобы не выдумывать номера.

1. **Срок годности в прошлом.** Я отклоняю такую дату, а сегодняшнюю принимаю. Если приложение должно разрешать добавлять уже просроченные продукты, достаточно убрать одну проверку в `checkExpiryDate`.
2. **Список единиц.** Я взял `шт, г, кг, мл, л`. Нужно сверить его со спецификацией.
3. **Лимиты.** Название не длиннее 100 символов, количество не больше 10000. Эти значения тоже нужно сверить со спецификацией.
4. **Формат даты.** Функция принимает строку `ГГГГ-ММ-ДД`. Если UI использует date picker и отдаёт `Date`, нужно будет изменить тип поля `expiryDate`.
5. **Тексты ошибок.** Сейчас они лежат в константе внутри файла. Если в проекте уже есть i18n-ресурсы или коды ERR-*, перенесу тексты туда.

Вопрос: какой срок годности разрешён, только сегодня и позже или любой, включая прошлые даты (см. п. 1)? От ответа зависит единственная неоднозначная проверка.

---

## Сравнение результатов

| Аспект (правило) | До правил (A) | После правил (B) |
|---|---|---|
| Формат ответа (F1) | Свободный: разъяснение, код, пример, список решений | Строго: план → код с путём файла → тесты → запуск → допущения |
| Тесты (K4) | Нет, только список «тестов, которые стоит написать» | Есть файл с тестами: позитивные, негативные и граничные случаи (вчера и сегодня, 100 и 101 символ, максимум количества), проверка неизменности входа |
| Текущее время (C3) | `now: Date = new Date()` — значение по умолчанию обращается к часам | `now` обязательный параметр, домен не читает часы |
| JSDoc (S3) | Нет | Есть: описание, `@param`, `@returns`, `@throws` |
| Библиотека дат (K2) | Собственный разбор через `Date.UTC` | `date-fns` (`parseISO`, `isValid`, `startOfDay`) |
| Тексты для пользователя (S5) | Строки внутри логики | Вынесены в константу `PRODUCT_FORM_MESSAGES` |
| Структура кода (S4) | Одна функция около 70 строк | Четыре короткие функции-проверки и итоговая функция |
| Типы (K1) | Один `ValidationResult` с необязательным `value`, в примере `result.value!` | Размеченный union: `value` есть только при `isValid: true`, без `!` |
| Расположение файла (F2) | Не указано | `src/domain/validate-product-form.ts` и `.test.ts` рядом |
| Уточняющий вопрос (R2) | Список решений «стоит подтвердить» | Явный вопрос про прошлые даты |
| Строки кода | 111 (без тестов) | 133 + 139 строк тестов |

### Объективные проверки

| Проверка | A | B |
|---|---|---|
| Компиляция `tsc --strict` | Пройдена | Не запускалась: нет доступа к реестру npm, пакет `date-fns` недоступен |
| Поиск `any`, `@ts-ignore` в коде | Не найдено (но в примере использования есть `result.value!`) | Не найдено |
| Запуск функции на примерах | Выполнен (корректные данные принимаются, ошибки по полям, просроченная дата даёт предупреждение) | Не выполнялся (нет `date-fns`) |
| Запуск тестов | Тестов нет | Тесты не запускались (нет `jest` и `date-fns`) |

**Что не проверено.** Тесты запуска B я не выполнял: в песочнице нет доступа к реестру npm, поэтому установить `jest`, `ts-jest` и `date-fns` не удалось. Утверждение «тесты проходят» поэтому делать нельзя; запустите команды из раздела «Как запустить» у себя.

---

## Вывод

**Что улучшилось.** Правила сделали результат ближе к стандартам проекта и пригодным к ревью. В ответе появились тесты (в запуске A их не было вовсе), JSDoc, размеченный тип результата без `!`, тексты ошибок в константе, библиотека `date-fns` вместо самописного разбора дат, обязательный параметр `now` (в A текущее время читалось из часов по умолчанию), а структура ответа стала предсказуемой: план, код с путём файла, тесты, запуск и допущения. Эти улучшения соответствуют конкретным правилам (K1, K2, K4, S3, S4, S5, C3, F1, F2) и видны в таблице выше.

**Что не улучшилось и чему это учит.** Правила не заменили знание спецификации. Агент B не мог открыть ТЗ и запретил прошедшие даты, тогда как User Story US-02 требует предупреждение «Срок уже истёк. Добавить как просроченный?»; запуск A, наоборот, пришёл к такому поведению сам. Лимиты (10000 и 99999) и список единиц в обоих запусках придуманы и не взяты из ТЗ. Вывод: файл правил должен идти вместе с доступом агента к документам, на которые он ссылается (в Claude Code или Cursor агент читает их сам), а выбор модели и тест на одной задаче с одним запуском дают лишь ориентир, а не статистику.
