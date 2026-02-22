# 🍽️ MindLoop CostOS — Backend API

Backend REST API para **MindLoop CostOS**, plataforma SaaS de gestión de costes para restaurantes.

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **Base de datos:** PostgreSQL 15+
- **Auth:** JWT (httpOnly cookies) + bcrypt
- **Monitoring:** Sentry
- **Deploy:** Docker / Dokploy (auto-deploy en push a `main`)

## Quick Start

```bash
# 1. Clonar e instalar
git clone https://github.com/klaker79/lacaleta-api.git
cd lacaleta-api
npm install

# 2. Configurar entorno
cp .env.example .env
# Editar .env con tus credenciales

# 3. Crear BD PostgreSQL
createdb lacaleta102

# 4. Arrancar (la BD se inicializa automáticamente)
node server.js
# → API corriendo en http://localhost:3001
```

## Estructura

```
├── server.js                    # Entry point — Express app, middleware, rutas legacy
├── src/
│   ├── routes/                  # Rutas principales (11 ficheros)
│   │   ├── auth.routes.js       # Login, registro, verificación email
│   │   ├── ingredients.routes.js
│   │   ├── recipes.routes.js
│   │   ├── sales.routes.js
│   │   ├── orders.routes.js
│   │   ├── balance.routes.js    # P&L mensual, estadísticas
│   │   ├── inventory.routes.js
│   │   ├── intelligence.routes.js # Frescura, plan compras, sobrestock
│   │   ├── analysis.routes.js   # Menu engineering, food cost
│   │   ├── staff.routes.js      # Empleados + horarios
│   │   └── system.routes.js     # Health check, backup
│   ├── middleware/              # Auth, rate limiting
│   ├── db/                     # Pool PostgreSQL, init schema
│   ├── utils/                  # Logger, validators, helpers
│   └── interfaces/http/        # Rutas v2 (Clean Architecture parcial)
├── tests/
│   ├── critical/               # 39 suites, 168+ tests
│   └── setup.js
└── .github/workflows/          # CI pipeline
```

## API Endpoints

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/login` | Login (devuelve JWT) |
| POST | `/api/auth/register` | Registro restaurante + usuario |
| POST | `/api/auth/verify-email` | Verificación email |

### Ingredientes
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/ingredients` | Listar todos |
| POST | `/api/ingredients` | Crear |
| PUT | `/api/ingredients/:id` | Actualizar |
| DELETE | `/api/ingredients/:id` | Soft delete |

### Recetas
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/recipes` | Listar todas |
| POST | `/api/recipes` | Crear |
| PUT | `/api/recipes/:id` | Actualizar |
| DELETE | `/api/recipes/:id` | Soft delete |

### Ventas, Pedidos, Inventario, Balance, Staff
> Ver `src/routes/*.routes.js` para la referencia completa de endpoints.

## Multi-tenancy

Cada request incluye `restaurante_id` del JWT. Todas las queries filtran por este ID. Los datos de un restaurante nunca son accesibles por otro.

## Tests

```bash
npm test                          # Todos los tests
npx jest tests/critical/ --forceExit   # Solo critical (39 suites)
```

## Deploy

Push a `main` → Dokploy auto-deploy (Docker).

```bash
git checkout -b fix/mi-cambio
# ... hacer cambios ...
git push origin fix/mi-cambio
# Crear PR en GitHub → merge a main → deploy automático
```

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa.

## Licencia

Propiedad de MindLoop IA. Todos los derechos reservados.
