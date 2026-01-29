/**
 * Middleware de validación con Joi
 */

function validate(schema) {
    return async (req, res, next) => {
        try {
            // Construir objeto a validar
            const toValidate = {};
            const schemaDesc = schema.describe();

            if (schemaDesc.keys && schemaDesc.keys.params) {
                toValidate.params = req.params;
            }
            if (schemaDesc.keys && schemaDesc.keys.body) {
                toValidate.body = req.body;
            }
            if (schemaDesc.keys && schemaDesc.keys.query) {
                toValidate.query = req.query;
            }

            // Validar
            const { error, value } = schema.validate(toValidate, {
                abortEarly: false,
                stripUnknown: true
            });

            if (error) {
                const errors = error.details.map(detail => ({
                    field: detail.path.join('.'),
                    message: detail.message
                }));

                return res.status(400).json({
                    success: false,
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Datos de entrada inválidos',
                        errors
                    }
                });
            }

            // Reemplazar con valores validados/transformados
            if (value.params) req.params = value.params;
            if (value.body) req.body = value.body;
            if (value.query) req.query = value.query;

            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = validate;
