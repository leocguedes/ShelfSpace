const test = require('node:test');
const assert = require('node:assert/strict');
const { unitLabel, formatQuantity } = require('../.test-dist/domain.js');
const {
  convertRecipeQuantity,
  getRecipeIngredientStatuses,
  matchesRecipeIngredient,
} = require('../.test-dist/recipes.js');

function recipe(ingredient) {
  return { id: 'test', name: 'Teste', description: '', minutes: 5, servings: 1, ingredients: [ingredient], instructions: [] };
}

function ingredient(name, quantity, unit, aliases = []) {
  return { name, aliases, quantity, unit };
}

test('matches ingredient names regardless of accents and case', () => {
  assert.equal(matchesRecipeIngredient(ingredient('Queijo', 30, 'g', ['muçarela']), 'MUÇARELA'), true);
  assert.equal(matchesRecipeIngredient(ingredient('Leite', 1, 'L'), 'leite integral'), true);
  assert.equal(matchesRecipeIngredient(ingredient('Arroz', 1, 'kg'), 'feijão'), false);
});

test('matches singular and plural ingredient names', () => {
  assert.equal(matchesRecipeIngredient(ingredient('Batata', 2, 'unidades', ['batatas']), 'Batatas médias'), true);
  assert.equal(matchesRecipeIngredient(ingredient('Ovo', 2, 'unidades', ['ovos']), 'Ovos caipiras'), true);
});

test('converts compatible mass and volume units', () => {
  assert.equal(convertRecipeQuantity(0.5, 'kg', 'g'), 500);
  assert.equal(convertRecipeQuantity(250, 'ml', 'L'), 0.25);
  assert.equal(convertRecipeQuantity(2, 'latas', 'unidades'), null);
});

test('sums inventory across multiple matching records', () => {
  const statuses = getRecipeIngredientStatuses(
    recipe(ingredient('Queijo', 100, 'g', ['muçarela'])),
    [
      { id: 'a', name: 'Muçarela fatiada', quantity: 0.05, unit: 'kg' },
      { id: 'b', name: 'Queijo', quantity: 50, unit: 'g' },
    ],
  );
  assert.equal(statuses[0].availableQuantity, 100);
  assert.equal(statuses[0].enough, true);
  assert.equal(statuses[0].missingQuantity, 0);
});

test('expired ingredients do not count as available stock', () => {
  const statuses = getRecipeIngredientStatuses(
    recipe(ingredient('Leite', 250, 'ml', ['leite integral'])),
    [
      { id: 'expired', name: 'Leite integral', quantity: 1, unit: 'L', expires_on: '2000-01-01' },
      { id: 'current', name: 'Leite', quantity: 100, unit: 'ml' },
    ],
  );
  assert.equal(statuses[0].expiredMatches.length, 1);
  assert.equal(statuses[0].enough, false);
  assert.equal(statuses[0].missingQuantity, 150);
});

test('marks quantities with incompatible units as unknown instead of guessing', () => {
  const statuses = getRecipeIngredientStatuses(
    recipe(ingredient('Arroz', 500, 'g')),
    [{ id: 'a', name: 'Arroz', quantity: 2, unit: 'pacotes' }],
  );
  assert.equal(statuses[0].enough, true);
  assert.equal(statuses[0].comparable, false);
});

test('counts packaged salt and bottled olive oil as present without guessing quantities', () => {
  const recipeWithPantryStaples = {
    ...recipe(ingredient('Sal', 2, 'g', ['sal refinado'])),
    ingredients: [
      ingredient('Sal', 2, 'g', ['sal refinado', 'sal marinho']),
      ingredient('Azeite ou óleo', 10, 'ml', ['azeite', 'óleo', 'oleo']),
    ],
  };
  const statuses = getRecipeIngredientStatuses(recipeWithPantryStaples, [
    { id: 'salt', name: 'Sal de cozinha', quantity: 1, unit: 'pacotes' },
    { id: 'oil', name: 'Azeite extra virgem', quantity: 1, unit: 'garrafas' },
  ]);
  assert.equal(statuses[0].enough, true);
  assert.equal(statuses[0].comparable, false);
  assert.equal(statuses[1].enough, true);
  assert.equal(statuses[1].comparable, false);
});

test('reports absent ingredients as missing', () => {
  const statuses = getRecipeIngredientStatuses(
    recipe(ingredient('Ovos', 2, 'unidades', ['ovo'])),
    [],
  );
  assert.equal(statuses[0].enough, false);
  assert.equal(statuses[0].missingQuantity, 2);
});


test('external recipes match ingredients by presence without guessing quantities', () => {
  const externalRecipe = {
    ...recipe(ingredient('Chicken', 1, 'unidades', ['frango'])),
    presenceOnly: true,
  };
  const statuses = getRecipeIngredientStatuses(externalRecipe, [
    { id: 'a', name: 'Frango congelado', quantity: 500, unit: 'g' },
  ]);
  assert.equal(statuses[0].enough, true);
  assert.equal(statuses[0].comparable, false);
  assert.equal(statuses[0].missingQuantity, 0);
});


test('localizes unit labels and quantity formatting without changing stored unit values', () => {
  assert.equal(unitLabel('unidades', 'en', 1), 'unit');
  assert.equal(unitLabel('unidades', 'en', 3), 'units');
  assert.equal(unitLabel('caixas', 'en', 1), 'box');
  assert.equal(unitLabel('caixas', 'en', 2), 'boxes');
  assert.equal(unitLabel('garrafas', 'en', 1), 'bottle');
  assert.equal(unitLabel('garrafas', 'en', 2), 'bottles');
  assert.equal(unitLabel('caixas', 'pt-BR', 1), 'caixa');
  assert.equal(unitLabel('caixas', 'pt-BR', 2), 'caixas');
  assert.equal(formatQuantity(1, 'caixas', 'en'), '1 box');
  assert.equal(formatQuantity(3, 'caixas', 'en'), '3 boxes');
  assert.equal(formatQuantity(3, 'caixas', 'pt-BR'), '3 caixas');
});
