/**
 * Schemas de validación para recetas
 */

const Joi = require('joi');

const calculateCostSchema = Joi.object({
    params: Joi.object({
        id: Joi.number().integer().positive().required()
            .messages({
                'number.base': 'ID de receta debe ser un número',
                'number.positive': 'ID de receta debe ser positivo'
            })
    })
});

const createRecipeSchema = Joi.object({
    body: Joi.object({
        nombre: Joi.string().min(2).max(100).required()
            .messages({
                'string.min': 'Nombre debe tener al menos 2 caracteres',
                'any.required': 'Nombre es obligatorio'
            }),
        descripcion: Joi.string().max(500).allow('', null),
        categoria_id: Joi.number().integer().positive().allow(null),
        raciones: Joi.number().integer().min(1).max(100).default(1),
        precio_venta: Joi.number().positive().precision(2).required()
            .messages({
                'number.positive': 'Precio debe ser positivo',
                'any.required': 'Precio de venta es obligatorio'
            }),
        ingredientes: Joi.array().items(
            Joi.object({
                ingrediente_id: Joi.number().integer().positive().required(),
                cantidad: Joi.number().positive().required(),
                unidad: Joi.string().valid('g', 'kg', 'ml', 'l', 'ud').default('g')
            })
        ).default([])
    })
});

const updateRecipeSchema = Joi.object({
    params: Joi.object({
        id: Joi.number().integer().positive().required()
    }),
    body: Joi.object({
        nombre: Joi.string().min(2).max(100),
        descripcion: Joi.string().max(500).allow('', null),
        categoria_id: Joi.number().integer().positive().allow(null),
        raciones: Joi.number().integer().min(1).max(100),
        precio_venta: Joi.number().positive().precision(2),
        ingredientes: Joi.array().items(
            Joi.object({
                ingrediente_id: Joi.number().integer().positive().required(),
                cantidad: Joi.number().positive().required(),
                unidad: Joi.string().valid('g', 'kg', 'ml', 'l', 'ud').default('g')
            })
        ),
        activo: Joi.boolean()
    }).min(1)
});

module.exports = {
    calculateCostSchema,
    createRecipeSchema,
    updateRecipeSchema
};
