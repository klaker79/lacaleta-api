/**
 * recipes Routes — Extracted from server.js  
 * Recipe variants (bottle/glass) + Recipes CRUD
 */
const { Router } = require('express');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { requirePlan } = require('../middleware/planGate');
const { log } = require('../utils/logger');
const { sanitizeString, validatePrecio, validateNumber, validateId } = require('../utils/validators');

/**
 * @param {Pool} pool - PostgreSQL connection pool
 */
module.exports = function (pool) {
    const router = Router();

    // ========== VARIANTES DE RECETA (Botella/Copa) ==========

    // GET /api/recipes-variants - Obtener TODAS las variantes del restaurante
    router.get('/recipes-variants', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT * FROM recetas_variantes 
             WHERE restaurante_id = $1 
             ORDER BY receta_id, precio_venta DESC`,
                [req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo todas las variantes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // GET /api/recipes/:id/variants - Obtener variantes de una receta
    router.get('/recipes/:id/variants', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(
                `SELECT * FROM recetas_variantes 
             WHERE receta_id = $1 AND restaurante_id = $2 
             ORDER BY precio_venta DESC`,
                [id, req.restauranteId]
            );
            res.json(result.rows);
        } catch (err) {
            log('error', 'Error obteniendo variantes', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // POST /api/recipes/:id/variants - Crear variante
    router.post('/recipes/:id/variants', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const { id } = req.params;
            const { nombre, factor, precio_venta, codigo } = req.body;

            if (!nombre || precio_venta === undefined) {
                return res.status(400).json({ error: 'nombre y precio_venta son requeridos' });
            }

            // Verificar que la receta existe
            const checkReceta = await pool.query(
                'SELECT id FROM recetas WHERE id = $1 AND restaurante_id = $2 AND deleted_at IS NULL',
                [id, req.restauranteId]
            );
            if (checkReceta.rows.length === 0) {
                return res.status(404).json({ error: 'Receta no encontrada' });
            }

            const result = await pool.query(
                `INSERT INTO recetas_variantes (receta_id, nombre, factor, precio_venta, codigo, restaurante_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (receta_id, nombre) DO UPDATE SET factor = $3, precio_venta = $4, codigo = $5
             RETURNING *`,
                [id, sanitizeString(nombre), validateNumber(factor, 1, 0.01, 100), validatePrecio(precio_venta), sanitizeString(codigo) || null, req.restauranteId]
            );

            log('info', 'Variante creada', { receta_id: id, nombre, precio_venta });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando variante', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // PUT /api/recipes/:id/variants/:variantId - Actualizar variante
    router.put('/recipes/:id/variants/:variantId', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            const variantCheck = validateId(req.params.variantId);
            if (!idCheck.valid || !variantCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const { id, variantId } = { id: idCheck.value, variantId: variantCheck.value };
            const { nombre, factor, precio_venta, codigo, activo } = req.body;

            const result = await pool.query(
                `UPDATE recetas_variantes 
             SET nombre = COALESCE($1, nombre),
                 factor = COALESCE($2, factor),
                 precio_venta = COALESCE($3, precio_venta),
                 codigo = COALESCE($4, codigo),
                 activo = COALESCE($5, activo)
             WHERE id = $6 AND receta_id = $7 AND restaurante_id = $8
             RETURNING *`,
                [sanitizeString(nombre), factor != null ? validateNumber(factor, undefined, 0.01, 100) : undefined, precio_venta != null ? validatePrecio(precio_venta) : undefined, sanitizeString(codigo), activo, variantId, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Variante no encontrada' });
            }

            log('info', 'Variante actualizada', { variant_id: variantId });
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando variante', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // DELETE /api/recipes/:id/variants/:variantId - Eliminar variante
    router.delete('/recipes/:id/variants/:variantId', authMiddleware, requirePlan('profesional'), async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            const variantCheck = validateId(req.params.variantId);
            if (!idCheck.valid || !variantCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const { id, variantId } = { id: idCheck.value, variantId: variantCheck.value };

            const result = await pool.query(
                'DELETE FROM recetas_variantes WHERE id = $1 AND receta_id = $2 AND restaurante_id = $3 RETURNING id',
                [variantId, id, req.restauranteId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Variante no encontrada' });
            }

            log('info', 'Variante eliminada', { variant_id: variantId });
            res.json({ success: true });
        } catch (err) {
            log('error', 'Error eliminando variante', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    // ========== RECETAS ==========
    // ✅ PRODUCCIÓN: Rutas inline activas. Controllers deshabilitados.

    /**
     * Valida que todos los ingredientes de una receta existen, pertenecen al tenant
     * y no están borrados. Soporta subrecetas (ingredienteId >= 100000). Devuelve
     * { valid: true } o { valid: false, error, details }.
     */
    async function validarIngredientesReceta(items, restauranteId) {
        if (!Array.isArray(items) || items.length === 0) return { valid: true };
        const ingredienteIds = new Set();
        const recetaIds = new Set();
        for (const it of items) {
            const rawId = it.ingredienteId ?? it.ingrediente_id ?? it.id;
            const id = parseInt(rawId);
            if (!Number.isFinite(id) || id <= 0) {
                return { valid: false, error: 'Ingrediente sin ID válido en la receta' };
            }
            if (id >= 100000) recetaIds.add(id - 100000);
            else ingredienteIds.add(id);
        }
        if (ingredienteIds.size > 0) {
            const r = await pool.query(
                'SELECT id FROM ingredientes WHERE id = ANY($1::int[]) AND restaurante_id = $2 AND deleted_at IS NULL',
                [Array.from(ingredienteIds), restauranteId]
            );
            const encontrados = new Set(r.rows.map(row => row.id));
            const faltan = [...ingredienteIds].filter(id => !encontrados.has(id));
            if (faltan.length > 0) {
                return { valid: false, error: 'Hay ingredientes inexistentes, de otro restaurante o borrados', details: { ingredientes: faltan } };
            }
        }
        if (recetaIds.size > 0) {
            const r = await pool.query(
                'SELECT id FROM recetas WHERE id = ANY($1::int[]) AND restaurante_id = $2 AND deleted_at IS NULL',
                [Array.from(recetaIds), restauranteId]
            );
            const encontradas = new Set(r.rows.map(row => row.id));
            const faltan = [...recetaIds].filter(id => !encontradas.has(id));
            if (faltan.length > 0) {
                return { valid: false, error: 'Subrecetas inexistentes, de otro restaurante o borradas', details: { subrecetas: faltan } };
            }
        }
        return { valid: true };
    }

    router.get('/recipes', authMiddleware, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM recetas WHERE restaurante_id=$1 AND deleted_at IS NULL ORDER BY id', [req.restauranteId]);
            res.json(result.rows || []);
        } catch (err) {
            log('error', 'Error obteniendo recetas', { error: err.message });
            res.status(500).json({ error: 'Error interno', data: [] });
        }
    });

    router.post('/recipes', authMiddleware, async (req, res) => {
        try {
            const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;

            if (!nombre || !nombre.trim()) {
                return res.status(400).json({ error: 'El nombre de la receta es requerido' });
            }

            // 🔒 Validación: cada ingrediente/subreceta debe existir y ser del mismo tenant
            const vIngs = await validarIngredientesReceta(ingredientes, req.restauranteId);
            if (!vIngs.valid) {
                return res.status(400).json({ error: vIngs.error, details: vIngs.details });
            }

            const result = await pool.query(
                'INSERT INTO recetas (nombre, categoria, precio_venta, porciones, ingredientes, codigo, restaurante_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                [sanitizeString(nombre), sanitizeString(categoria) || 'principal', validatePrecio(precio_venta), validateNumber(porciones, 1, 1, 1000), JSON.stringify(ingredientes || []), sanitizeString(codigo) || null, req.restauranteId]
            );
            res.status(201).json(result.rows[0]);
        } catch (err) {
            log('error', 'Error creando receta', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.put('/recipes/:id', authMiddleware, async (req, res) => {
        try {
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const id = idCheck.value;
            const { nombre, categoria, precio_venta, porciones, ingredientes, codigo } = req.body;

            // 🔒 Validación: cada ingrediente/subreceta debe existir y ser del mismo tenant
            const vIngs = await validarIngredientesReceta(ingredientes, req.restauranteId);
            if (!vIngs.valid) {
                return res.status(400).json({ error: vIngs.error, details: vIngs.details });
            }

            // 🔒 deleted_at IS NULL: no revivir recetas borradas via PUT
            const result = await pool.query(
                'UPDATE recetas SET nombre=$1, categoria=$2, precio_venta=$3, porciones=$4, ingredientes=$5, codigo=$6 WHERE id=$7 AND restaurante_id=$8 AND deleted_at IS NULL RETURNING *',
                [sanitizeString(nombre), sanitizeString(categoria), validatePrecio(precio_venta), validateNumber(porciones, 1, 1, 1000), JSON.stringify(ingredientes || []), sanitizeString(codigo) || null, id, req.restauranteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Receta no encontrada' });
            }
            res.json(result.rows[0]);
        } catch (err) {
            log('error', 'Error actualizando receta', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    router.delete('/recipes/:id', authMiddleware, requireAdmin, async (req, res) => {
        try {
            // SOFT DELETE: marca como eliminado sin borrar datos
            const idCheck = validateId(req.params.id);
            if (!idCheck.valid) return res.status(400).json({ error: 'ID inválido' });
            const result = await pool.query(
                'UPDATE recetas SET deleted_at = CURRENT_TIMESTAMP WHERE id=$1 AND restaurante_id=$2 AND deleted_at IS NULL RETURNING *',
                [idCheck.value, req.restauranteId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Receta no encontrada o ya eliminada' });
            }
            log('info', 'Receta soft deleted', { id: req.params.id });
            res.json({ message: 'Eliminado', id: result.rows[0].id });
        } catch (err) {
            log('error', 'Error eliminando receta', { error: err.message });
            res.status(500).json({ error: 'Error interno' });
        }
    });

    return router;
};
