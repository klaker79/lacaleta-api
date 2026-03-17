-- ============================================
-- Migration 005: Add FK constraints on restaurante_id
-- 
-- PREREQUISITE: Before running, check for orphaned records:
--   SELECT 'ingredientes' as tabla, count(*) FROM ingredientes WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'recetas', count(*) FROM recetas WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'proveedores', count(*) FROM proveedores WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'pedidos', count(*) FROM pedidos WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'ventas', count(*) FROM ventas WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'mermas', count(*) FROM mermas WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'empleados', count(*) FROM empleados WHERE restaurante_id NOT IN (SELECT id FROM restaurantes)
--   UNION ALL SELECT 'gastos_fijos', count(*) FROM gastos_fijos WHERE restaurante_id NOT IN (SELECT id FROM restaurantes);
--
-- If any count > 0, fix orphans BEFORE running this migration.
-- NO ON DELETE CASCADE — restaurant deletion must be deliberate.
-- ============================================

-- ingredientes
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_ingredientes_restaurante' AND table_name = 'ingredientes') THEN
        ALTER TABLE ingredientes ADD CONSTRAINT fk_ingredientes_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- recetas
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_recetas_restaurante' AND table_name = 'recetas') THEN
        ALTER TABLE recetas ADD CONSTRAINT fk_recetas_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- proveedores
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_proveedores_restaurante' AND table_name = 'proveedores') THEN
        ALTER TABLE proveedores ADD CONSTRAINT fk_proveedores_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- pedidos
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_pedidos_restaurante' AND table_name = 'pedidos') THEN
        ALTER TABLE pedidos ADD CONSTRAINT fk_pedidos_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- ventas
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_ventas_restaurante' AND table_name = 'ventas') THEN
        ALTER TABLE ventas ADD CONSTRAINT fk_ventas_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- mermas
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_mermas_restaurante' AND table_name = 'mermas') THEN
        ALTER TABLE mermas ADD CONSTRAINT fk_mermas_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- empleados
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_empleados_restaurante' AND table_name = 'empleados') THEN
        ALTER TABLE empleados ADD CONSTRAINT fk_empleados_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;

-- gastos_fijos
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints 
                   WHERE constraint_name = 'fk_gastos_fijos_restaurante' AND table_name = 'gastos_fijos') THEN
        ALTER TABLE gastos_fijos ADD CONSTRAINT fk_gastos_fijos_restaurante 
            FOREIGN KEY (restaurante_id) REFERENCES restaurantes(id);
    END IF;
END $$;
