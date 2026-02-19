/**
 * ═══════════════════════════════════════════════════════
 * src/db/init.js — Database Initialization & Migrations
 * Extracted from server.js for modularity.
 * 
 * Contains all CREATE TABLE, ALTER TABLE migrations,
 * index creation, and obsolete table cleanup.
 * ═══════════════════════════════════════════════════════
 */
const { log } = require('../utils/logger');

/**
 * Initialize database schema and run all migrations.
 * @param {Pool} pool - PostgreSQL connection pool
 */
async function initializeDatabase(pool) {
  // ========== CREAR TABLAS ==========
  await pool.query(`
      CREATE TABLE IF NOT EXISTS restaurantes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        nombre VARCHAR(255) NOT NULL,
        rol VARCHAR(50) DEFAULT 'usuario',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ingredientes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        proveedor_id INTEGER,
        precio DECIMAL(10, 2) DEFAULT 0,
        unidad VARCHAR(50) DEFAULT 'kg',
        stock_actual DECIMAL(10, 2) DEFAULT 0,
        stock_minimo DECIMAL(10, 2) DEFAULT 0,
        stock_real DECIMAL(10, 2),
        familia VARCHAR(50) DEFAULT 'alimento',
        ultima_actualizacion_stock TIMESTAMP,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

  // MIGRACIÓN: Añadir columna familia si no existe
  try {
    await pool.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'ingredientes' AND column_name = 'familia') THEN 
            ALTER TABLE ingredientes ADD COLUMN familia VARCHAR(50) DEFAULT 'alimento'; 
          END IF; 
        END $$;
    `);
  } catch (e) {
    log('warn', 'Error en migración de columna familia', { error: e.message });
  }

  // MIGRACIÓN: Añadir columna activo si no existe (para toggle activar/desactivar)
  try {
    await pool.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'ingredientes' AND column_name = 'activo') THEN 
            ALTER TABLE ingredientes ADD COLUMN activo BOOLEAN DEFAULT TRUE; 
          END IF; 
        END $$;
    `);
    log('info', 'Migración: columna activo verificada');
  } catch (e) {
    log('warn', 'Error en migración de columna activo', { error: e.message });
  }

  await pool.query(`
      CREATE TABLE IF NOT EXISTS recetas (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        categoria VARCHAR(100) DEFAULT 'principal',
        precio_venta DECIMAL(10, 2) DEFAULT 0,
        porciones INTEGER DEFAULT 1,
        ingredientes JSONB DEFAULT '[]',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS proveedores (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        contacto VARCHAR(255) DEFAULT '',
        telefono VARCHAR(50) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        direccion TEXT DEFAULT '',
        notas TEXT DEFAULT '',
        ingredientes INTEGER[] DEFAULT '{}',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Tabla de relación muchos a muchos: ingredientes-proveedores
      CREATE TABLE IF NOT EXISTS ingredientes_proveedores (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER NOT NULL REFERENCES ingredientes(id) ON DELETE CASCADE,
        proveedor_id INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
        precio DECIMAL(10, 2) NOT NULL,
        es_proveedor_principal BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ingrediente_id, proveedor_id)
      );
      -- Tabla de variantes de receta (ej: vino por botella o por copa)
      CREATE TABLE IF NOT EXISTS recetas_variantes (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
        nombre VARCHAR(100) NOT NULL,
        factor DECIMAL(5, 3) NOT NULL DEFAULT 1,
        precio_venta DECIMAL(10, 2) NOT NULL,
        codigo VARCHAR(20),
        activo BOOLEAN DEFAULT TRUE,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(receta_id, nombre)
      );
      -- Tabla de empleados para gestión de horarios
      CREATE TABLE IF NOT EXISTS empleados (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        color VARCHAR(7) DEFAULT '#3B82F6',
        horas_contrato INTEGER DEFAULT 40,
        coste_hora DECIMAL(10, 2) DEFAULT 10.00,
        dias_libres_fijos TEXT DEFAULT '',
        puesto VARCHAR(50) DEFAULT 'Camarero',
        activo BOOLEAN DEFAULT TRUE,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Tabla de horarios/turnos del personal
      CREATE TABLE IF NOT EXISTS horarios (
        id SERIAL PRIMARY KEY,
        empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        turno VARCHAR(20) DEFAULT 'completo',
        hora_inicio TIME,
        hora_fin TIME,
        es_extra BOOLEAN DEFAULT FALSE,
        notas TEXT,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(empleado_id, fecha)
      );
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        proveedor_id INTEGER,
        fecha DATE NOT NULL,
        ingredientes JSONB NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        estado VARCHAR(50) DEFAULT 'pendiente',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_recepcion TIMESTAMP,
        total_recibido DECIMAL(10, 2),
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ventas (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        cantidad INTEGER NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_adjustments_v2 (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        cantidad DECIMAL(10, 2) NOT NULL,
        motivo VARCHAR(100) NOT NULL,
        notas TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        usuario_id INTEGER, 
        restaurante_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_snapshots_v2 (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        stock_virtual DECIMAL(10, 2) NOT NULL,
        stock_real DECIMAL(10, 2) NOT NULL,
        diferencia DECIMAL(10, 2) NOT NULL,
        restaurante_id INTEGER NOT NULL
      );
      /* =========================================
         TABLAS QUE FALTABAN (Añadidas por auditoría)
         ========================================= */
      
      -- Tabla de perdidas_stock
      CREATE TABLE IF NOT EXISTS perdidas_stock (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id),
        cantidad NUMERIC(10,2) NOT NULL,
        motivo TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabla ingredientes_alias
      CREATE TABLE IF NOT EXISTS ingredientes_alias (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        alias VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_alias_restaurante UNIQUE (alias, restaurante_id)
      );

      -- Tabla gastos_fijos
      CREATE TABLE IF NOT EXISTS gastos_fijos (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL,
        concepto VARCHAR(255) NOT NULL,
        monto_mensual NUMERIC(10, 2) NOT NULL DEFAULT 0,
        activo BOOLEAN DEFAULT true,
        dia_pago INTEGER DEFAULT 1,
        categoria VARCHAR(50),
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabla para registro de mermas/pérdidas
      CREATE TABLE IF NOT EXISTS mermas (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        ingrediente_nombre VARCHAR(255),
        cantidad DECIMAL(10, 3) NOT NULL,
        unidad VARCHAR(20),
        valor_perdida DECIMAL(10, 2) NOT NULL,
        motivo VARCHAR(50) NOT NULL,
        nota TEXT,
        responsable_id INTEGER,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        restaurante_id INTEGER NOT NULL
      );
      -- Tabla para tokens de API (n8n, integraciones)
      CREATE TABLE IF NOT EXISTS api_tokens (
        id SERIAL PRIMARY KEY,
        restaurante_id INTEGER NOT NULL REFERENCES restaurantes(id) ON DELETE CASCADE,
        nombre VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        ultimo_uso TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
      -- NUEVAS TABLAS: Tracking Diario de Costes y Ventas
      CREATE TABLE IF NOT EXISTS precios_compra_diarios (
        id SERIAL PRIMARY KEY,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        precio_unitario DECIMAL(10, 2) NOT NULL,
        cantidad_comprada DECIMAL(10, 2) NOT NULL,
        total_compra DECIMAL(10, 2) NOT NULL,
        proveedor_id INTEGER,
        notas TEXT,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ingrediente_id, fecha, restaurante_id)
      );
      CREATE TABLE IF NOT EXISTS ventas_diarias_resumen (
        id SERIAL PRIMARY KEY,
        receta_id INTEGER REFERENCES recetas(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        cantidad_vendida INTEGER NOT NULL,
        precio_venta_unitario DECIMAL(10, 2) NOT NULL,
        coste_ingredientes DECIMAL(10, 2) NOT NULL,
        total_ingresos DECIMAL(10, 2) NOT NULL,
        beneficio_bruto DECIMAL(10, 2) NOT NULL,
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(receta_id, fecha, restaurante_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_receta ON ventas(receta_id);
      CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
      CREATE INDEX IF NOT EXISTS idx_ingredientes_restaurante ON ingredientes(restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_precios_compra_fecha ON precios_compra_diarios(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_diarias_fecha ON ventas_diarias_resumen(fecha);
      -- Cola de revisión: compras importadas por n8n que requieren aprobación
      CREATE TABLE IF NOT EXISTS compras_pendientes (
        id SERIAL PRIMARY KEY,
        batch_id UUID NOT NULL,
        ingrediente_nombre TEXT NOT NULL,
        ingrediente_id INTEGER REFERENCES ingredientes(id) ON DELETE SET NULL,
        precio DECIMAL(10,2) NOT NULL,
        cantidad DECIMAL(10,2) NOT NULL,
        fecha DATE NOT NULL,
        estado VARCHAR(20) DEFAULT 'pendiente',
        restaurante_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        aprobado_at TIMESTAMP,
        notas TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_compras_pendientes_estado ON compras_pendientes(estado, restaurante_id);
      CREATE INDEX IF NOT EXISTS idx_compras_pendientes_batch ON compras_pendientes(batch_id);

      -- Performance indexes (non-dependent on deleted_at)
      CREATE INDEX IF NOT EXISTS idx_mermas_rest_fecha ON mermas(restaurante_id, fecha);
      CREATE INDEX IF NOT EXISTS idx_precios_compra_rest_fecha ON precios_compra_diarios(restaurante_id, fecha);
    `);

  // ========== MIGRACIONES DE COLUMNAS ESTÁNDAR ==========
  log('info', 'Ejecutando migraciones de columnas estándar...');

  // Añadir columna 'codigo' a ingredientes
  try {
    await pool.query(`
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);
  } catch (e) { log('warn', 'Migración ingredientes.codigo', { error: e.message }); }

  // ⚡ FIX: Columnas faltantes detectadas en auditoría
  try {
    await pool.query(`
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS rendimiento NUMERIC(5,2) DEFAULT 100;
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS formato_compra VARCHAR(50);
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS cantidad_por_formato NUMERIC(10,3);
            
            ALTER TABLE mermas ADD COLUMN IF NOT EXISTS periodo_id INTEGER;
            ALTER TABLE mermas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
        `);
    log('info', 'Migración columnas ingredientes/mermas completada');
  } catch (e) { log('warn', 'Migración columnas ingredientes/mermas', { error: e.message }); }

  // Alerts en bloque separado (puede no existir la tabla si no se ha creado aún)
  try {
    await pool.query(`
            ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'warning';
        `);
    log('info', 'Migración columna alerts.severity completada');
  } catch (e) { log('warn', 'Migración alerts.severity (tabla puede no existir)', { error: e.message }); }

  // Añadir columna 'codigo' a recetas
  try {
    await pool.query(`
            ALTER TABLE recetas ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
            ALTER TABLE recetas ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);
  } catch (e) { log('warn', 'Migración recetas.codigo', { error: e.message }); }

  // Añadir columnas a proveedores
  try {
    await pool.query(`
            ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS codigo VARCHAR(20);
            ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS cif VARCHAR(20);
            ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);
  } catch (e) { log('warn', 'Migración proveedores.codigo', { error: e.message }); }

  // Añadir columnas para verificación de email
  try {
    await pool.query(`
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verification_token VARCHAR(64);
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP;
        `);
    // Marcar usuarios existentes como verificados (para tu cuenta)
    await pool.query(`UPDATE usuarios SET email_verified = TRUE WHERE email_verified IS NULL`);
    log('info', 'Migración email_verified completada');
  } catch (e) { log('warn', 'Migración usuarios.email_verified', { error: e.message }); }

  // Añadir columnas para reset de contraseña
  try {
    await pool.query(`
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
            ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMP;
        `);
    log('info', 'Migración reset_token completada');
  } catch (e) { log('warn', 'Migración usuarios.reset_token', { error: e.message }); }

  // ========== MIGRACIONES SOFT DELETE ==========
  log('info', 'Ejecutando migraciones de soft delete...');
  try {
    await pool.query(`
            ALTER TABLE ventas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
            ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
            ALTER TABLE recetas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
            ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
        `);
    log('info', 'Migraciones soft delete completadas');
  } catch (e) { log('warn', 'Migración soft delete', { error: e.message }); }

  // ========== PERFORMANCE INDEXES (depend on deleted_at columns above) ==========
  try {
    await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_mermas_deleted ON mermas(deleted_at) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_ingredientes_rest_active ON ingredientes(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_ventas_rest_fecha ON ventas(restaurante_id, fecha) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_pedidos_rest_deleted ON pedidos(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_recetas_rest_deleted ON recetas(restaurante_id, deleted_at) WHERE deleted_at IS NULL;
        `);
    log('info', 'Performance indexes (soft delete) creados');
  } catch (e) { log('warn', 'Migración performance indexes', { error: e.message }); }

  // ========== COMPOSITE & MISSING INDEXES (Mes 2 optimization) ==========
  try {
    await pool.query(`
            -- Menu engineering: ventas por restaurante+receta+fecha
            CREATE INDEX IF NOT EXISTS idx_ventas_restaurante_receta_fecha
              ON ventas (restaurante_id, receta_id, fecha) WHERE deleted_at IS NULL;
            -- Proveedores: lookup por proveedor_id
            CREATE INDEX IF NOT EXISTS idx_ingredientes_proveedores_proveedor
              ON ingredientes_proveedores (proveedor_id);
            -- Compras pendientes: cola de revisión
            CREATE INDEX IF NOT EXISTS idx_compras_pendientes_cola
              ON compras_pendientes (restaurante_id, created_at) WHERE estado = 'pendiente';
            -- Ventas diarias resumen: P&L mensual
            CREATE INDEX IF NOT EXISTS idx_ventas_diarias_resumen_rest_fecha
              ON ventas_diarias_resumen (restaurante_id, fecha);
            -- Gastos fijos: listado activos
            CREATE INDEX IF NOT EXISTS idx_gastos_fijos_activos
              ON gastos_fijos (restaurante_id) WHERE activo = true;
            -- API tokens: lookup por restaurante
            CREATE INDEX IF NOT EXISTS idx_api_tokens_restaurante
              ON api_tokens (restaurante_id);
            -- Precios compra: rollback por pedido_id (usado en DELETE orden)
            CREATE INDEX IF NOT EXISTS idx_precios_compra_pedido
              ON precios_compra_diarios (pedido_id) WHERE pedido_id IS NOT NULL;
            -- Alias ingredientes: match rápido
            CREATE INDEX IF NOT EXISTS idx_ingredientes_alias_rest
              ON ingredientes_alias (restaurante_id, alias);
        `);
    log('info', 'Composite & missing indexes (Mes 2) creados');
  } catch (e) { log('warn', 'Migración composite indexes', { error: e.message }); }

  // ========== MIGRACIÓN: stock_deductions para rastrear descuentos reales ==========
  try {
    await pool.query(`
            ALTER TABLE ventas ADD COLUMN IF NOT EXISTS stock_deductions JSONB;
        `);
    log('info', 'Migración stock_deductions completada');
  } catch (e) { log('warn', 'Migración stock_deductions', { error: e.message }); }

  // ========== MIGRACIÓN VARIANTES EN VENTAS ==========
  log('info', 'Ejecutando migración de variantes en ventas...');
  try {
    await pool.query(`
            ALTER TABLE ventas_diarias_resumen ADD COLUMN IF NOT EXISTS variante_id INTEGER REFERENCES recetas_variantes(id) ON DELETE SET NULL;
            ALTER TABLE ventas_diarias_resumen ADD COLUMN IF NOT EXISTS factor_aplicado DECIMAL(5, 3) DEFAULT 1;
        `);
    log('info', 'Migración variantes en ventas completada');
  } catch (e) { log('warn', 'Migración variante_id', { error: e.message }); }

  // ========== MIGRACIÓN: Tablas faltantes ==========
  log('info', 'Verificando tablas faltantes...');

  // Tabla ingredientes_alias (requerida por match y delete de ingredientes)
  try {
    await pool.query(`
            CREATE TABLE IF NOT EXISTS ingredientes_alias (
                id SERIAL PRIMARY KEY,
                ingrediente_id INTEGER NOT NULL REFERENCES ingredientes(id) ON DELETE CASCADE,
                alias VARCHAR(255) NOT NULL,
                restaurante_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(alias, restaurante_id)
            );
        `);
    log('info', 'Tabla ingredientes_alias verificada');
  } catch (e) { log('warn', 'Migración ingredientes_alias', { error: e.message }); }

  // Tabla gastos_fijos (requerida por expense routes)
  try {
    await pool.query(`
            CREATE TABLE IF NOT EXISTS gastos_fijos (
                id SERIAL PRIMARY KEY,
                concepto VARCHAR(255) NOT NULL,
                monto_mensual DECIMAL(10, 2) DEFAULT 0,
                activo BOOLEAN DEFAULT TRUE,
                restaurante_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    log('info', 'Tabla gastos_fijos verificada');
  } catch (e) { log('warn', 'Migración gastos_fijos', { error: e.message }); }

  // Columnas faltantes en ingredientes
  try {
    await pool.query(`
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS formato_compra VARCHAR(50);
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS cantidad_por_formato DECIMAL(10, 3);
            ALTER TABLE ingredientes ADD COLUMN IF NOT EXISTS rendimiento INTEGER DEFAULT 100;
        `);
    log('info', 'Columnas formato_compra/cantidad_por_formato/rendimiento verificadas');
  } catch (e) { log('warn', 'Migración columnas ingredientes', { error: e.message }); }

  // Columna pedido_id en precios_compra_diarios + migración UNIQUE constraint
  // ⚡ FIX Stabilization v1: Permitir múltiples filas por ingrediente/fecha si vienen de pedidos distintos
  try {
    await pool.query(`
            ALTER TABLE precios_compra_diarios ADD COLUMN IF NOT EXISTS pedido_id INTEGER;
        `);
    // Migrar constraint: de UNIQUE(ingrediente_id, fecha, restaurante_id) 
    // a UNIQUE INDEX que incluye pedido_id (COALESCE para NULLs)
    await pool.query(`
            ALTER TABLE precios_compra_diarios 
                DROP CONSTRAINT IF EXISTS precios_compra_diarios_ingrediente_id_fecha_restaurante_id_key;
        `);
    await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_pcd_ing_fecha_rest_pedido
                ON precios_compra_diarios (ingrediente_id, fecha, restaurante_id, (COALESCE(pedido_id, 0)));
        `);
    log('info', 'Migración UNIQUE constraint precios_compra_diarios completada (ahora incluye pedido_id)');
  } catch (e) { log('warn', 'Migración pedido_id / UNIQUE constraint', { error: e.message }); }

  // Columna periodo_id en mermas
  try {
    await pool.query(`
            ALTER TABLE mermas ADD COLUMN IF NOT EXISTS periodo_id INTEGER;
        `);
    log('info', 'Columna periodo_id en mermas verificada');
  } catch (e) { log('warn', 'Migración periodo_id mermas', { error: e.message }); }

  // ========== TABLAS OBSOLETAS (ya eliminadas) ==========
  // daily_records, lanave_ventas_tpv, producto_id_tpv, snapshots_diarios, inventory_counts
  // fueron eliminadas previamente. DROP CASCADE removido por seguridad (no ejecutar DDL destructivo en startup).

  log('info', 'Tablas y migraciones completadas');
}

module.exports = { initializeDatabase };
