/**
 * Seed Template — Default ingredients for new restaurants
 * Called during registration and superadmin restaurant creation
 */

const TEMPLATE_INGREDIENTS = [
    // Carnes
    { nombre: 'Pollo', categoria: 'Carnes', unidad: 'kg' },
    { nombre: 'Ternera', categoria: 'Carnes', unidad: 'kg' },
    { nombre: 'Cerdo', categoria: 'Carnes', unidad: 'kg' },
    // Pescados
    { nombre: 'Merluza', categoria: 'Pescados', unidad: 'kg' },
    { nombre: 'Salmón', categoria: 'Pescados', unidad: 'kg' },
    { nombre: 'Gambas', categoria: 'Pescados', unidad: 'kg' },
    // Verduras
    { nombre: 'Cebolla', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Tomate', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Pimiento', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Patata', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Lechuga', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Ajo', categoria: 'Verduras', unidad: 'kg' },
    { nombre: 'Zanahoria', categoria: 'Verduras', unidad: 'kg' },
    // Lácteos
    { nombre: 'Leche', categoria: 'Lácteos', unidad: 'L' },
    { nombre: 'Nata', categoria: 'Lácteos', unidad: 'L' },
    { nombre: 'Queso', categoria: 'Lácteos', unidad: 'kg' },
    { nombre: 'Mantequilla', categoria: 'Lácteos', unidad: 'kg' },
    { nombre: 'Huevos', categoria: 'Lácteos', unidad: 'docena' },
    // Despensa
    { nombre: 'Aceite de Oliva', categoria: 'Despensa', unidad: 'L' },
    { nombre: 'Sal', categoria: 'Despensa', unidad: 'kg' },
    { nombre: 'Pimienta', categoria: 'Despensa', unidad: 'kg' },
    { nombre: 'Harina', categoria: 'Despensa', unidad: 'kg' },
    { nombre: 'Azúcar', categoria: 'Despensa', unidad: 'kg' },
    { nombre: 'Arroz', categoria: 'Despensa', unidad: 'kg' },
    { nombre: 'Pasta', categoria: 'Despensa', unidad: 'kg' },
    // Bebidas
    { nombre: 'Vino Tinto (casa)', categoria: 'Bebidas', unidad: 'L' },
    { nombre: 'Vino Blanco (casa)', categoria: 'Bebidas', unidad: 'L' },
    { nombre: 'Cerveza', categoria: 'Bebidas', unidad: 'L' },
    { nombre: 'Agua mineral', categoria: 'Bebidas', unidad: 'L' },
    { nombre: 'Refrescos', categoria: 'Bebidas', unidad: 'L' },
];

/**
 * Seeds template ingredients for a new restaurant
 * @param {object} client - PostgreSQL client (within a transaction) or pool
 * @param {number} restauranteId - The restaurant ID to seed for
 */
async function seedTemplateIngredients(client, restauranteId) {
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const ing of TEMPLATE_INGREDIENTS) {
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, 0, 0)`);
        params.push(restauranteId, ing.nombre, ing.categoria, ing.unidad);
    }

    if (values.length > 0) {
        await client.query(
            `INSERT INTO ingredientes (restaurante_id, nombre, categoria, unidad, precio_actual, stock_actual)
             VALUES ${values.join(', ')}`,
            params
        );
    }
}

module.exports = { seedTemplateIngredients };
