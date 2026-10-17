/** Мини-база рецептов (в бою — API, FR-4). */
export const RECIPES = [
  { id: 'omelet', title: 'Омлет с сыром', minutes: 15, ingredients: ['яйца', 'молоко', 'сыр'] },
  { id: 'syrniki', title: 'Сырники', minutes: 30, ingredients: ['творог', 'яйца', 'мука', 'сахар'] },
  { id: 'chicken-rice', title: 'Курица с рисом', minutes: 40, ingredients: ['курица', 'рис', 'лук'] },
  { id: 'porridge', title: 'Молочная каша', minutes: 20, ingredients: ['молоко', 'рис', 'сахар'] },
  { id: 'toast', title: 'Тосты с сыром', minutes: 10, ingredients: ['хлеб', 'сыр', 'яйца'] },
  { id: 'salad', title: 'Овощной салат', minutes: 10, ingredients: ['помидоры', 'огурцы', 'йогурт'] },
];

const has = (productName, ingredient) => productName.toLowerCase().includes(ingredient);

/**
 * FR-4.1–4.2, 4.9: подбор рецептов. Нужно ≥3 продуктов; показываем рецепты с ≥50% совпадений;
 * сортировка: доля совпадений, затем число ингредиентов из «горящих» продуктов (≤3 дней).
 */
export function matchRecipes(products, recipes, isUrgent = () => false) {
  if (products.length < 3) return { enough: false, matches: [] };
  const matches = recipes
    .map((recipe) => {
      const found = recipe.ingredients.filter((ing) => products.some((p) => has(p.name, ing)));
      const urgent = recipe.ingredients.filter((ing) => products.some((p) => has(p.name, ing) && isUrgent(p))).length;
      return { recipe, have: found.length, total: recipe.ingredients.length, missing: recipe.ingredients.filter((i) => !found.includes(i)), urgent };
    })
    .filter((m) => m.have / m.total >= 0.5)
    .sort((a, b) => b.have / b.total - a.have / a.total || b.urgent - a.urgent);
  return { enough: true, matches };
}
