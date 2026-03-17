// eslint-disable-next-line no-unused-vars
const fs = require('fs');

// Configuración de la demo
// 1/11/2025 al 18/2/2026
const RESTAURANTE_ID = 1;
const START_DATE = new Date('2025-11-01');
const END_DATE = new Date('2026-02-18');

// Mapeo de Recetas (IDs de la BD demo) a Cantidades Reales (del log del usuario)
const RECIPES = [
    { id: 1, name: 'Ensaladilla Rusa', count: 98, price: 9.00 },
    { id: 2, name: 'Coca de Escalivada', count: 43, price: 12.00 },
    { id: 3, name: 'Tataki de Atún Rojo Bluefin', count: 60, price: 18.00 },
    { id: 4, name: 'Rabo de Toro', count: 10, price: 18.00 },
    { id: 5, name: 'Texturas de Chocolate', count: 21, price: 10.00 },
    { id: 6, name: 'Crema Catalana', count: 25, price: 9.00 },
    { id: 7, name: 'Bravas La Caleta', count: 118, price: 7.00 },
    { id: 8, name: 'Croquetas de la Casa', count: 145, price: 12.00 },
    { id: 9, name: 'Pan de Cristal con Tomate', count: 368, price: 3.50 },
    { id: 10, name: 'Canelón Meloso', count: 89, price: 16.00 }
];

function randomDate(start, end) {
    let date;
    let valid = false;
    while (!valid) {
        date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
        const day = date.getDay();
        const weight = (day === 5 || day === 6 || day === 0) ? 0.8 : 0.3; // Más peso viernes/sab/dom
        if (Math.random() < weight) valid = true;
    }
    // Hora aleatoria (lunch vs dinner)
    const service = Math.random() > 0.5 ? 'dinner' : 'lunch';
    if (service === 'lunch') {
        date.setHours(13 + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60));
    } else {
        date.setHours(20 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60));
    }
    return date;
}

function formatDate(date) {
    return date.toISOString().replace('T', ' ').substring(0, 19);
}

let sql = `
-- Limpiar ventas anteriores
TRUNCATE TABLE ventas CASCADE;

BEGIN;

INSERT INTO ventas (restaurante_id, receta_id, cantidad, precio_unitario, total, fecha)
VALUES 
`;

let values = [];

RECIPES.forEach(recipe => {
    for (let i = 0; i < recipe.count; i++) {
        const date = randomDate(START_DATE, END_DATE);
        const dateStr = formatDate(date);
        // qty=1 siempre para clavar los numeros exactos del usuario
        const qty = 1;

        values.push(`(${RESTAURANTE_ID}, ${recipe.id}, ${qty}, ${recipe.price}, ${qty * recipe.price}, '${dateStr}')`);
    }
});

// Barajar cronológicamente no es necesario para el insert, pero queda mejor
// Sort opcional
// values.sort() --> no, el insert da igual

sql += values.join(',\n') + ';';

sql += `
COMMIT;
ANALYZE ventas;
`;

console.log(sql);
