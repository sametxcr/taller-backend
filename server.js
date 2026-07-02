require('dotenv').config();
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// CORS BIEN HECHO - 1 SOLO
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://inventario-sistema-murex.vercel.app', // ← Tu URL de Vercel
    process.env.FRONTEND_URL
  ].filter(Boolean),
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], // ← AGREGA PATCH CTM
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
// Crear carpeta uploads si no existe
const uploadDir = './uploads/productos';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Config de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const sku = req.params.sku; // ← CAMBIO: id → sku
    const extension = path.extname(file.originalname);
    cb(null, `${sku}${extension}`); // Resultado: FRE5.jpg
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // ← 5MB DE VERDAD
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = /jpeg|jpg|png|webp/;
    const esValido = tiposPermitidos.test(path.extname(file.originalname).toLowerCase());
    if (esValido) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG, PNG, WEBP'));
  }
});

app.use(express.json({ limit: '10mb' }));

const pool = process.env.DATABASE_URL 
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASS,
      port: process.env.DB_PORT,
    });
pool.on('error', (err) => console.error('Error inesperado en pool PG', err));

const handleError = (res, err) => {
  console.error('ERROR:', err);
  res.status(500).json({ error: err.message });
};

// ✅ FUNCIÓN CORRECTA - MISMA LÓGICA QUE FRONTEND
const parsearFechaChile = (fechaStr) => {
  if (!fechaStr) return null;
  if (fechaStr instanceof Date) return fechaStr;

  const soloFecha = String(fechaStr).split('T')[0].split(' ')[0];
  const separador = soloFecha.includes('/')? '/' : '-';
  const partes = soloFecha.split(separador).map(Number);

  if (partes.length!== 3 || partes.some(isNaN)) return null;

  let anio, mes, dia;

  if (partes[0] > 31) {
    [anio, mes, dia] = partes; // YYYY-MM-DD
  }
  else if (partes[2] > 31) {
    [dia, mes, anio] = partes; // DD-MM-YYYY
  }
  else if (partes[2] >= 0 && partes[2] <= 99) {
    [dia, mes, anio] = partes;
    anio = anio <= 30? 2000 + anio : 1900 + anio; // DD-MM-YY
  }
  else {
    [anio, mes, dia] = partes;
  }

  if (!anio ||!mes ||!dia || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

  return new Date(anio, mes - 1, dia, 12, 0, 0);
};

// Formatea Date a DD-MM-YYYY - SOLO PARA MOSTRAR
const formatearFecha = (fecha) => {
  if (!fecha) return null;
  // Si ya viene como DD-MM-YYYY no tocar
  if (typeof fecha === 'string' && fecha.match(/^\d{2}-\d{2}-\d{4}$/)) return fecha;
  const d = new Date(fecha);
  return d.toLocaleDateString('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).split('/').join('-');
};

const obtenerFechaHoraChileISO = () => {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'America/Santiago'
  }).replace(' ', 'T') + '.000-04:00';
};

// Parsea campos JSONB - NO TOCA FECHAS
const parsearOT = (ot) => {
  return {
...ot,
    servicios: typeof ot.servicios === 'string'? JSON.parse(ot.servicios) : ot.servicios || [],
	obs_servicios: typeof ot.obs_servicios === 'string'? JSON.parse(ot.obs_servicios) : ot.obs_servicios || {}, // ← AGREGA ESTA LÍNEA CTM
    repuestos_usados: typeof ot.repuestos_usados === 'string'? JSON.parse(ot.repuestos_usados) : ot.repuestos_usados || [],
    mano_obra: typeof ot.mano_obra === 'string'? JSON.parse(ot.mano_obra) : ot.mano_obra || [],
    checklist_recepcion: typeof ot.checklist_recepcion === 'string'? JSON.parse(ot.checklist_recepcion) : ot.checklist_recepcion || [],
    abono: Number(ot.abono) || 0
  };
};

// SIEMPRE DESDE fecha_creacion, MÍNIMO 1
const calcularDiasTaller = (ot) => {
  if (ot.estado_ot === 'Entregado' && ot.dias_taller) {
    return ot.dias_taller;
  }

  const inicio = parsearFechaChile(ot.fecha_creacion);
  if (!inicio) {
    console.error('FECHA CREACION INVALIDA:', ot.patente, ot.fecha_creacion);
    return 1;
  }

  const fin = ot.estado_ot === 'Entregado' && ot.fecha_entrega
 ? parsearFechaChile(ot.fecha_entrega)
    : new Date();

  if (!fin) {
    console.error('FECHA ENTREGA INVALIDA:', ot.patente, ot.fecha_entrega);
    return 1;
  }

  const inicioUTC = Date.UTC(inicio.getFullYear(), inicio.getMonth(), inicio.getDate());
  const finUTC = Date.UTC(fin.getFullYear(), fin.getMonth(), fin.getDate());

  const dias = Math.floor((finUTC - inicioUTC) / 86400000) + 1;
  return dias < 1? 1 : dias;
};

// Formatea OT antes de enviar al frontend - PISA dias_en_taller
const formatearOTParaFrontend = (ot) => {
  const otParseada = parsearOT(ot);
  const diasCalculados = calcularDiasTaller(otParseada);

  return {
...otParseada,
    dias_en_taller: diasCalculados,
    //fecha_creacion: formatearFecha(ot.fecha_creacion),
    //fecha_inicio_taller: formatearFecha(ot.fecha_inicio_taller),
    //fecha_entrega: formatearFecha(ot.fecha_entrega)
  };
};

// ========== PRODUCTOS ==========
app.get('/api/productos', async (req, res) => {
  try {
    const { search } = req.query;
    if (search) {
      const { rows } = await pool.query(
        `SELECT * FROM productos
         WHERE sku ILIKE $1 OR nombre ILIKE $1
         ORDER BY id DESC LIMIT 8`,
        [`%${search}%`]
      );
      return res.json(rows);
    }
    const { rows } = await pool.query('SELECT * FROM productos ORDER BY id DESC');
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.get('/api/productos/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM productos WHERE id=$1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) { handleError(res, err); }
});

app.post('/api/productos', async (req, res) => {
  try {
    const p = req.body;
    const neto_final = (p.neto_compra || 0) * (1 - (p.descuento_prov_porcentaje || 0) / 100);

    const { rows } = await pool.query(
      `INSERT INTO productos (
        sku, nombre, familia, stock_local, stock_bodega, stock_minimo,
        neto_compra, descuento_prov_porcentaje, neto_final, precio_venta,
        descripcion, proveedor, ubicacion, ventas_totales
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        p.sku, p.nombre, p.familia,
        p.stock_local || 0, p.stock_bodega || 0, p.stock_minimo || 5,
        p.neto_compra || 0, p.descuento_prov_porcentaje || 0, neto_final, p.precio_venta || 0,
        p.descripcion, p.proveedor, p.ubicacion, p.ventas_totales || 0
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('ERROR POST productos:', err);
    if (err.code === '23505' && err.constraint === 'productos_sku_key') {
      return res.status(400).json({ error: `El SKU "${req.body.sku}" ya existe. Usa otro código.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Subir foto de producto
app.post('/api/productos/:sku/foto', upload.single('foto'), async (req, res) => {
  try {
    const { sku } = req.params; // ← CAMBIO: id → sku
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });
    
    const fotoUrl = `/uploads/productos/${req.file.filename}`;
    
    const result = await pool.query(
      'UPDATE productos SET imagen_url = $1 WHERE sku = $2 RETURNING *', // ← CAMBIO: foto_url→imagen_url, codigo→sku
      [fotoUrl, sku]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    console.log(`FOTO GUARDADA: ${fotoUrl} para producto ${sku}`);
    res.json({ mensaje: 'Foto subida', foto_url: fotoUrl });
  } catch (error) {
    console.error('ERROR SUBIENDO FOTO:', error);
    res.status(500).json({ error: 'Error al subir foto' });
  }
});

// ELIMINAR FOTO DE PRODUCTO
app.delete('/api/productos/:sku/foto', async (req, res) => {
  try {
    const { sku } = req.params;
    console.log('=== DELETE FOTO === SKU:', sku);
    
    const { rows } = await pool.query(
      'SELECT imagen_url FROM productos WHERE sku = $1', 
      [sku]
    );
    
    console.log('Filas encontradas:', rows.length);
    
    if (rows.length === 0) {
      console.log('❌ Producto no encontrado');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    const imagenUrl = rows[0].imagen_url;
    console.log('imagen_url en BD:', imagenUrl);
    
    if (!imagenUrl) {
      console.log('⚠️ Producto sin foto');
      return res.status(200).json({ mensaje: 'El producto no tenía foto' });
    }
    
    // Borra archivo físico
    const rutaArchivo = path.join(__dirname, imagenUrl);
    console.log('Ruta archivo:', rutaArchivo);
    if (fs.existsSync(rutaArchivo)) {
      fs.unlinkSync(rutaArchivo);
      console.log('✅ Archivo borrado');
    } else {
      console.log('⚠️ Archivo no existe físicamente');
    }
    
    // Limpia BD
    await pool.query(
      'UPDATE productos SET imagen_url = NULL WHERE sku = $1',
      [sku]
    );
    
    console.log('✅ BD actualizada');
    res.json({ mensaje: 'Foto eliminada' });
  } catch (error) {
    console.error('ERROR BORRANDO FOTO:', error);
    res.status(500).json({ error: 'Error al borrar foto' });
  }
});

// Servir las imágenes estáticas - PONLO ANTES DEL app.listen
app.use('/api/uploads', express.static('uploads'));

app.put('/api/productos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('=== PUT PRODUCTO ===');
    console.log('ID:', id);
    console.log('BODY:', req.body);

    const {
      sku, nombre, familia, stock_local, stock_bodega, stock_minimo,
      neto_compra, descuento_prov_porcentaje, precio_venta, motivo,
      imagen_url, descripcion, proveedor, ubicacion // ← AGREGAR ESTOS 4
    } = req.body;

    const antiguo = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
    console.log('PRODUCTO ENCONTRADO:', antiguo.rows.length);

    if (antiguo.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });

    const prodAntiguo = antiguo.rows[0];
    const neto_final = (neto_compra || 0) * (1 - (descuento_prov_porcentaje || 0) / 100);

    if (prodAntiguo.neto_final!== neto_final || prodAntiguo.precio_venta!== precio_venta) {
      await pool.query(`
        INSERT INTO historial_precios (sku, neto_anterior, neto_nuevo, venta_anterior, venta_nuevo, motivo)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        sku, prodAntiguo.neto_final, neto_final,
        prodAntiguo.precio_venta, precio_venta,
        motivo || 'Actualización sin motivo'
      ]);
    }

    const result = await pool.query(`
      UPDATE productos
      SET sku = $1, nombre = $2, familia = $3, stock_local = $4, stock_bodega = $5,
          stock_minimo = $6, neto_compra = $7, descuento_prov_porcentaje = $8,
          neto_final = $9, precio_venta = $10,
          imagen_url = $11, descripcion = $12, proveedor = $13, ubicacion = $14, -- ← AGREGAR
          actualizado = NOW()
      WHERE id = $15 -- ← Cambiar de $11 a $15
      RETURNING *
    `, [sku, nombre, familia, stock_local, stock_bodega, stock_minimo,
        neto_compra, descuento_prov_porcentaje, neto_final, precio_venta,
        imagen_url, descripcion, proveedor, ubicacion, // ← AGREGAR
        id]);

    console.log('FILAS ACTUALIZADAS:', result.rowCount);
    console.log('DATOS DEVUELTOS:', result.rows[0]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('ERROR PUT:', err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

app.delete('/api/productos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM productos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

app.delete('/api/retiros/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    // 1. Busca el retiro
    const retiroRes = await client.query('SELECT * FROM retiros_inventario WHERE id = $1', [id]);
    if (retiroRes.rows.length === 0) throw new Error('Retiro no encontrado');
    const retiro = retiroRes.rows[0];

    // 2. Devuelve stock
    const campoStock = retiro.bodega === 'bodega'? 'stock_bodega' : 'stock_local';
    await client.query(
      `UPDATE productos SET ${campoStock} = ${campoStock} + $1 WHERE id = $2`,
      [retiro.cantidad, retiro.producto_id]
    );

    // 3. Si tiene OT, borra el item, limpia JSON y recalcula
    if (retiro.ot_id) {
  // 3.1 Borra de ot_items si usas esa tabla
  await client.query('DELETE FROM ot_items WHERE retiro_id = $1', [id]);

  // 3.2 Limpia el JSON repuestos_usados - VERSIÓN CORREGIDA
  await client.query(`
    UPDATE ordenes_trabajo
    SET repuestos_usados = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(repuestos_usados) elem
      WHERE (elem->>'retiro_id') IS NULL 
         OR (elem->>'retiro_id')::int != $2
    )
    WHERE id = $1
  `, [retiro.ot_id, id]);

  // 3.3 Recalcula desde el JSON actualizado
  await client.query(`
  UPDATE ordenes_trabajo
  SET total_repuestos = (
    SELECT COALESCE(SUM((elem->>'cantidad')::int * (elem->>'precio_venta')::numeric), 0)
    FROM jsonb_array_elements(repuestos_usados) elem
  ),
  monto_final = total_repuestos + COALESCE(total_mano_obra, 0) + COALESCE(total_servicios, 0),
  monto_estimado = total_repuestos + COALESCE(total_mano_obra, 0) + COALESCE(total_servicios, 0)
  WHERE id = $1
`, [retiro.ot_id]);
}

    // 4. Elimina el retiro
    await client.query('DELETE FROM retiros_inventario WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({
      mensaje: 'Retiro eliminado, stock devuelto y OT actualizada',
      ot_actualizada:!!retiro.ot_id
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR DELETE /api/retiros:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
// ========== HISTORIAL PRECIOS ==========
app.get('/api/historial/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const result = await pool.query(
      'SELECT * FROM historial_precios WHERE sku = $1 ORDER BY fecha DESC', // ← CAMBIADO
      [sku]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

app.get('/api/retiros', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.*,
        ot.numero as ot_numero
      FROM retiros_inventario r
      LEFT JOIN ordenes_trabajo ot ON r.ot_id = ot.id
      ORDER BY r.creado DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('ERROR /api/retiros:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ot/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Trae la OT con datos del cliente y auto
    const otResult = await pool.query(`
      SELECT 
        ot.*,
        c.nombre AS cliente_nombre,
        c.rut AS cliente_rut,
        c.celular AS cliente_telefono,
        c.email AS cliente_email,
        c.marca AS vehiculo_marca,
        c.modelo AS vehiculo_modelo,
        c.anio AS vehiculo_anio,
        c.vin AS vehiculo_vin
      FROM ordenes_trabajo ot
      LEFT JOIN clientes c ON ot.cliente_id = c.id
      WHERE ot.id = $1
    `, [id]);
    
    if (otResult.rows.length === 0) {
      return res.status(404).json({ error: 'OT no encontrada' });
    }
    
    // 2. Trae todos los items: repuestos, mano obra, servicios
    const itemsResult = await pool.query(`
      SELECT * FROM ot_items 
      WHERE ot_id = $1 
      ORDER BY tipo, creado ASC
    `, [id]);
    
    res.json({
   ...otResult.rows[0],
      items: itemsResult.rows
    });
  } catch (err) {
    console.error('ERROR GET /api/ot/:id:', err);
    res.status(500).json({ error: err.message });
  }
});
// ========== CLIENTES CON ULTIMO INGRESO ==========
app.get('/api/clientes', async (req, res) => {
  try {
    const { search } = req.query;
    if (search) {
      const searchTerm = `%${search}%`;
      const { rows } = await pool.query(`
        SELECT
          c.*,
          MAX(ot.fecha_creacion) as ultimo_ingreso,
          COUNT(DISTINCT ot.id) as total_ots,
          COUNT(DISTINCT CASE WHEN ot.estado_ot IN ('Pendiente','En Proceso','Esperando Repuesto','Finalizado') THEN ot.id END) as ots_activas
        FROM clientes c
        LEFT JOIN ordenes_trabajo ot ON c.patente = ot.patente
        WHERE 
          LOWER(c.nombre) LIKE LOWER($1) OR 
          LOWER(c.razon_social) LIKE LOWER($1) OR
          LOWER(c.patente) LIKE LOWER($1) OR 
          LOWER(c.celular) LIKE LOWER($1) OR 
          LOWER(c.rut) LIKE LOWER($1) OR
          LOWER(c.marca) LIKE LOWER($1) OR
          LOWER(c.modelo) LIKE LOWER($1)
        GROUP BY c.id
        ORDER BY
          CASE WHEN c.tipo_cliente = 'empresa' THEN 1 ELSE 2 END,
          c.nombre ASC
        LIMIT 10
      `, [searchTerm]);
      return res.json(rows);
    }
    const { rows } = await pool.query(`
      SELECT
        c.*,
        MAX(ot.fecha_creacion) as ultimo_ingreso,
        COUNT(DISTINCT ot.id) as total_ots,
        COUNT(DISTINCT CASE WHEN ot.estado_ot IN ('Pendiente','En Proceso','Esperando Repuesto','Finalizado') THEN ot.id END) as ots_activas
      FROM clientes c
      LEFT JOIN ordenes_trabajo ot ON c.patente = ot.patente
      GROUP BY c.id
      ORDER BY c.id DESC
    `);
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.get('/api/clientes/validar-patente/:patente', async (req, res) => {
  try {
    const { patente } = req.params;
    const result = await pool.query('SELECT * FROM clientes WHERE patente = $1', [patente.toUpperCase()]);
    res.json({ existe: result.rows.length > 0, cliente: result.rows[0] || null });
  } catch (err) { handleError(res, err); }
});

app.post('/api/clientes', async (req, res) => {
  try {
    const c = req.body;
    const { rows } = await pool.query(
      `INSERT INTO clientes (rut, nombre, celular, email, patente, marca, modelo, anio, vin, fecha_recepcion, observaciones, tipo_cliente, razon_social, giro, direccion_facturacion, correo_facturacion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [c.rut, c.nombre, c.celular, c.email, c.patente, c.marca, c.modelo, c.anio, c.vin, c.fecha_recepcion, c.observaciones, c.tipo_cliente || 'natural', c.razon_social || '', c.giro || '', c.direccion_facturacion || '', c.correo_facturacion || '']
    );
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.post('/api/retiros', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      producto_id, sku, nombre_producto, cantidad, motivo, 
      tipo_retiro, responsable, bodega, ot_id 
    } = req.body;

    // 1. Busca producto y valida stock
    const prodRes = await client.query('SELECT * FROM productos WHERE id = $1', [producto_id]);
    if (prodRes.rows.length === 0) throw new Error('Producto no encontrado');
    const prod = prodRes.rows[0];

    const costoUnitarioEntero = parseInt(prod.neto_final || prod.neto_compra || 0);
    const precioVentaEntero = parseInt(prod.precio_venta || 0);
    const stockActual = bodega === 'bodega'? prod.stock_bodega : prod.stock_local;
    
    if (stockActual < parseInt(cantidad)) {
      throw new Error(`Stock insuficiente. Disponible: ${stockActual}`);
    }

    // 2. Descuenta stock
    const campoStock = bodega === 'bodega'? 'stock_bodega' : 'stock_local';
    await client.query(
      `UPDATE productos SET ${campoStock} = ${campoStock} - $1 WHERE id = $2`,
      [parseInt(cantidad), producto_id]
    );

    // 3. Registra retiro
	
    const retiroResult = await client.query(`
  INSERT INTO retiros_inventario 
  (producto_id, sku, nombre_producto, cantidad, motivo, tipo_retiro, responsable, costo_unitario, precio_venta, bodega, ot_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  RETURNING *
`, [
  producto_id, sku, nombre_producto, parseInt(cantidad), motivo, 
  tipo_retiro, responsable || 'Sistema', costoUnitarioEntero, precioVentaEntero, // ← AGREGAR ESTA LÍNEA
  bodega || 'local', ot_id? parseInt(ot_id) : null
]);
    
    const retiro = retiroResult.rows[0];

// 4. SI TIENE OT_ID, AGREGA ITEM A LA OT
    if (ot_id) {
      const subtotal = precioVentaEntero * parseInt(cantidad);

      await client.query(`
        INSERT INTO ot_items
        (ot_id, retiro_id, sku, descripcion, cantidad, precio_unitario, subtotal, tipo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'repuesto')
      `, [
        parseInt(ot_id),
        retiro.id,
        sku,
        nombre_producto,
        parseInt(cantidad),
        precioVentaEntero,
        subtotal
      ]);

      // ACTUALIZA TAMBIÉN EL CAMPO repuestos_usados EN ordenes_trabajo
      const otActual = await client.query('SELECT repuestos_usados FROM ordenes_trabajo WHERE id = $1', [parseInt(ot_id)]);

      let repuestosActuales = [];
      if (otActual.rows[0]?.repuestos_usados) {
        repuestosActuales = typeof otActual.rows[0].repuestos_usados === 'string'
         ? JSON.parse(otActual.rows[0].repuestos_usados)
          : otActual.rows[0].repuestos_usados;
      }

      const nuevoRepuesto = {
        sku: sku,
        nombre: nombre_producto,
        cantidad: parseInt(cantidad),
        precio_unitario: precioVentaEntero,
        subtotal: subtotal,
        desde_inventario: true,
        retiro_id: retiro.id
      };

      repuestosActuales.push(nuevoRepuesto);

      await client.query(`
        UPDATE ordenes_trabajo
        SET repuestos_usados = $1,
            total_repuestos = (
              SELECT COALESCE(SUM(subtotal), 0)
              FROM ot_items
              WHERE ot_id = $2 AND tipo = 'repuesto'
            ),
            total = COALESCE(total_repuestos, 0) + COALESCE(total_mano_obra, 0) + COALESCE(total_servicios, 0)
        WHERE id = $2
      `, [JSON.stringify(repuestosActuales), parseInt(ot_id)]);
    }
    
    await client.query('COMMIT');
    res.json(retiro);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR POST /api/retiros:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


app.put('/api/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const c = req.body;
    const { rows } = await pool.query(
      `UPDATE clientes SET rut=$1, nombre=$2, celular=$3, email=$4, patente=$5, marca=$6, modelo=$7, anio=$8, vin=$9, fecha_recepcion=$10, observaciones=$11, tipo_cliente=$12, razon_social=$13, giro=$14, direccion_facturacion=$15, correo_facturacion=$16 WHERE id=$17 RETURNING *`,
      [c.rut, c.nombre, c.celular, c.email, c.patente, c.marca, c.modelo, c.anio, c.vin, c.fecha_recepcion, c.observaciones, c.tipo_cliente || 'natural', c.razon_social || '', c.giro || '', c.direccion_facturacion || '', c.correo_facturacion || '', id]
    );
    res.json(rows);
  } catch (err) { handleError(res, err); }
});

app.delete('/api/clientes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});


// ========== ENDPOINT PARA CLIENTE HISTORIAL MODAL ==========
app.get('/api/clientes/rut/:rut/historial', async (req, res) => {
  try {
    const { rut } = req.params;

    const ingresosRes = await pool.query(
      'SELECT * FROM clientes WHERE rut = $1 ORDER BY id DESC',
      [rut]
    );

    // ✅ NO FORMATEES, DEJA EL DATE COMO VIENE
    const ingresos = ingresosRes.rows;

    if (ingresos.length === 0) {
      return res.json({
        ingresos: [],
        ots: [],
        stats: { totalVisitas: 0, totalGastado: 0, ultimaVisita: null, totalOT: 0, diasPromedio: 0 }
      });
    }

    const otsRes = await pool.query(
      'SELECT * FROM ordenes_trabajo WHERE rut_cliente = $1 ORDER BY id DESC',
      [rut]
    );

    // ✅ NO USES formatearOTParaFrontend AQUÍ, SOLO PARSEA
    const ots = otsRes.rows.map(formatearOTParaFrontend);

    const otsConVehiculo = ots.map(ot => {
      const vehiculo = ingresos.find(i => i.patente === ot.patente);
      return {
...ot,
        marca: (vehiculo?.marca || '').toUpperCase(),
        modelo: (vehiculo?.modelo || '').toUpperCase()
      };
    });

    const totalVisitas = ingresos.length;
    const totalOT = ots.length;

    const totalGastado = ots.reduce((sum, ot) => {
      return sum + (ot.monto_final || ot.monto_estimado || 0);
    }, 0);

    // ✅ MANDA ISO O NULL, NO FORMATEES
    const creadoDate = ingresos[0].creado? new Date(ingresos[0].creado) : null;
    const ultimaVisita = creadoDate &&!isNaN(creadoDate.getTime())? creadoDate.toISOString() : null;

    const otsEntregadas = ots.filter(ot => ot.estado_ot === 'Entregado');
    const diasPromedio = otsEntregadas.length > 0
 ? Math.round(otsEntregadas.reduce((sum, ot) => {
          const dias = calcularDiasTaller(ot);
          return sum + dias;
        }, 0) / otsEntregadas.length)
      : 0;

    res.json({
      ingresos, // ← SIN TOCAR
      ots: otsConVehiculo, // ← SIN TOCAR FECHAS
      stats: { totalVisitas, totalGastado, ultimaVisita, totalOT, diasPromedio }
    });

  } catch (err) { handleError(res, err); }
});

// ========== ORDENES_TRABAJO - RECALCULA SIEMPRE ==========
app.get('/api/ordenes_trabajo', async (req, res) => {
  try {
    const { estado, para_retiro, limit } = req.query;
    
    let conditions = [];
    
    // Solo pa retiros: OTs con número y activas
    if (para_retiro === 'true') {
      //conditions.push(`ot.numero IS NOT NULL`);
      //conditions.push(`ot.numero != ''`);
      conditions.push(`ot.estado_ot IN ('Pendiente', 'En Proceso', 'Esperando Repuesto')`);
    } 
    // Filtro normal de activas, sin tocar numero
    else if (estado === 'activa') {
      conditions.push(`ot.estado_ot IN ('Pendiente', 'En Proceso', 'Esperando Repuesto')`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = para_retiro === 'true' ? 'LIMIT 20' : limit ? `LIMIT ${parseInt(limit)}` : '';

    const { rows } = await pool.query(`
      SELECT
        ot.*,
        COALESCE(cl.rut, ot.rut_cliente) as rut_cliente,
        COALESCE(cl.nombre, '') as nombre_cliente,
        COALESCE(cl.patente, ot.patente) as patente,
        COALESCE(cl.marca, '') as marca,
        COALESCE(cl.modelo, '') as modelo,
        COALESCE(cl.anio, 0) as anio,
        COALESCE(cl.celular, '') as celular
      FROM ordenes_trabajo ot
      LEFT JOIN clientes cl ON ot.patente = cl.patente
      ${whereClause}
      ORDER BY ot.id DESC
      ${limitClause}
    `);
    
    const otsParseadas = rows.map(formatearOTParaFrontend);
    res.json(otsParseadas);
  } catch (err) { 
    handleError(res, err); 
  }
});


app.get('/api/ordenes_trabajo/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ot.*,
        COALESCE(cl.rut, ot.rut_cliente) as rut_cliente,
        COALESCE(cl.nombre, '') as nombre_cliente,
        COALESCE(cl.patente, ot.patente) as patente,
        COALESCE(cl.marca, '') as marca,
        COALESCE(cl.modelo, '') as modelo,
        COALESCE(cl.anio, 0) as anio,
        COALESCE(cl.celular, '') as celular
      FROM ordenes_trabajo ot
      LEFT JOIN clientes cl ON ot.patente = cl.patente
      WHERE ot.id = $1
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'OT no encontrada' });
    res.json(formatearOTParaFrontend(rows[0]));
  } catch (err) { handleError(res, err); }
});


app.post('/api/ordenes_trabajo/:id/agregar-repuesto-desde-retiro', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id);
    const { sku, descripcion, cantidad, valor_unitario, retiro_id } = req.body;

    const cantNum = Number(cantidad);
    const valorNum = Number(valor_unitario);

    if (!sku ||!descripcion ||!Number.isFinite(cantNum) ||!Number.isFinite(valorNum)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Datos inválidos' });
    }

    const { rows } = await client.query(`
      SELECT repuestos_usados, mano_obra, servicios
      FROM ordenes_trabajo WHERE id = $1 FOR UPDATE
    `, [id]);

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'OT no encontrada' });
    }

    let repuestos = rows[0].repuestos_usados || [];
    if (typeof repuestos === 'string') repuestos = JSON.parse(repuestos);
    if (!Array.isArray(repuestos)) repuestos = [];

    // ✅ SI YA EXISTE EL RETIRO_ID, SUMA LA CANTIDAD EN VEZ DE TIRAR 409
    const idxExistente = repuestos.findIndex(r => parseInt(r.retiro_id) === parseInt(retiro_id));
    if (idxExistente >= 0) {
      repuestos[idxExistente].cantidad = cantNum;
      repuestos[idxExistente].precio_venta = valorNum;
      repuestos[idxExistente].valor_unitario = valorNum;
      repuestos[idxExistente].precio_unitario = valorNum;
      const subtotalActualizado = repuestos[idxExistente].cantidad * valorNum;
      repuestos[idxExistente].costo_total = subtotalActualizado;
      repuestos[idxExistente].valor_total = subtotalActualizado;
      repuestos[idxExistente].subtotal = subtotalActualizado;
    } else {
      // ✅ SI NO EXISTE, LO AGREGA NORMAL
      const subtotalNuevo = cantNum * valorNum;
      repuestos.push({
        sku: String(sku),
        descripcion: String(descripcion),
        nombre: String(descripcion),
        cantidad: cantNum,
        valor_unitario: valorNum,
        precio_unitario: valorNum,
        precio_venta: valorNum,
        costo_total: subtotalNuevo,
        valor_total: subtotalNuevo,
        subtotal: subtotalNuevo,
        desde_retiro: true,
        retiro_id: parseInt(retiro_id) || null,
        desde_inventario: true
      });
    }

    // ✅ SUMA CORREGIDA - calcula subtotal si no existe
    const totalRepuestos = repuestos.reduce((sum, r) => {
      const precioUnit = Number(r.precio_venta || r.valor_unitario || r.precio_unitario || 0);
      const cant = Number(r.cantidad || 0);
      const subtotal = Number(r.valor_total || r.subtotal || 0) || (precioUnit * cant);
      return sum + (Number.isFinite(subtotal)? subtotal : 0);
    }, 0);

    let manoObra = rows[0].mano_obra || [];
    if (typeof manoObra === 'string') manoObra = JSON.parse(manoObra);
    const totalManoObra = (Array.isArray(manoObra)? manoObra : []).reduce((sum, m) => {
      const precio = Number(m.valor_unit || m.precio || m.valor_total || 0);
      const cant = Number(m.cantidad || 1);
      return sum + (precio * cant);
    }, 0);

    let servicios = rows[0].servicios || [];
    if (typeof servicios === 'string') servicios = JSON.parse(servicios);
    const totalServicios = (Array.isArray(servicios)? servicios : []).reduce((sum, s) => {
      return sum + Number(s.valor || s.precio || 0);
    }, 0);

    const totalFinal = totalRepuestos + totalManoObra + totalServicios;

    await client.query(`
      UPDATE ordenes_trabajo
      SET repuestos_usados = $1::jsonb,
          total_repuestos = $2::numeric,
          total_mano_obra = $3::numeric,
          total_servicios = $4::numeric,
          total = $5::numeric,
          monto_final = $5::numeric,
          valor_trabajo = $5::numeric,
          actualizado = NOW()
      WHERE id = $6
    `, [
      JSON.stringify(repuestos),
      totalRepuestos,
      totalManoObra,
      totalServicios,
      totalFinal,
      id
    ]);

    await client.query('COMMIT');

    // ✅ DEVUELVE LA OT COMPLETA PA QUE EL FRONTEND LA TENGA
    const { rows: [otActualizada] } = await client.query(
      'SELECT * FROM ordenes_trabajo WHERE id = $1',
      [id]
    );

    res.json(formatearOTParaFrontend(otActualizada));

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR agregar-repuesto-desde-retiro:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/ordenes_trabajo/:id/quitar-repuesto-desde-retiro', async (req, res) => {
  try {
    const { id } = req.params;
    const { sku, retiro_id } = req.body;

    const ot = await pool.query('SELECT repuestos_usados, mano_obra, servicios FROM ordenes_trabajo WHERE id = $1', [id]);
    if (ot.rows.length === 0) return res.status(404).json({ error: 'OT no encontrada' });

    let repuestos = ot.rows[0].repuestos_usados || [];
    if (typeof repuestos === 'string') repuestos = JSON.parse(repuestos);
    if (!Array.isArray(repuestos)) repuestos = [];

    // Filtra y saca el repuesto con ese retiro_id y sku
    repuestos = repuestos.filter(r =>!(r.sku === sku && parseInt(r.retiro_id) === parseInt(retiro_id)));

    // Recalcula totales
    const total_repuestos = repuestos.reduce((sum, r) => {
      const precio = Number(r.precio_venta || r.valor_unitario || r.precio_unitario || 0);
      const cant = Number(r.cantidad || 0);
      const subtotal = Number(r.costo_total || r.subtotal || r.valor_total || 0) || (precio * cant);
      return sum + subtotal;
    }, 0);

    let manoObra = ot.rows[0].mano_obra || [];
    if (typeof manoObra === 'string') manoObra = JSON.parse(manoObra);
    const total_mano_obra = (Array.isArray(manoObra)? manoObra : []).reduce((sum, m) => {
      return sum + Number(m.valor_unit || m.precio || m.valor_total || 0);
    }, 0);

    let servicios = ot.rows[0].servicios || [];
    if (typeof servicios === 'string') servicios = JSON.parse(servicios);
    const total_servicios = (Array.isArray(servicios)? servicios : []).reduce((sum, s) => {
      return sum + Number(s.valor || s.precio || 0);
    }, 0);

    const total = total_repuestos + total_mano_obra + total_servicios;

    await pool.query(`
      UPDATE ordenes_trabajo
      SET repuestos_usados = $1::jsonb,
          total_repuestos = $2::numeric,
          total_mano_obra = $3::numeric,
          total_servicios = $4::numeric,
          total = $5::numeric,
          monto_final = $5::numeric,
          valor_trabajo = $5::numeric,
          actualizado = NOW()
      WHERE id = $6
    `, [JSON.stringify(repuestos), total_repuestos, total_mano_obra, total_servicios, total, id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error quitando repuesto:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ordenes_trabajo', async (req, res) => {
  try {
    const ot = req.body;
    const fechaCreacion = ot.fecha_creacion || obtenerFechaHoraChileISO();
    const fechaInicio = obtenerFechaHoraChileISO();

    const { rows } = await pool.query(
      `INSERT INTO ordenes_trabajo (
        rut_cliente, patente, fecha_creacion, fecha_inicio_taller, fecha_entrega,
        estado_ot, servicios, obs_servicios, repuestos_usados, mano_obra, abono,
        monto_estimado, monto_final, dias_en_taller, tecnico_asignado,
        kilometraje, descripcion_servicio, checklist_recepcion, notas_internas
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        ot.rut_cliente, ot.patente, fechaCreacion, fechaInicio, null,
        ot.estado_ot || 'Pendiente',
        JSON.stringify(ot.servicios || []),
        JSON.stringify(ot.obs_servicios || {}), // ← AGREGADO ACÁ
        JSON.stringify(ot.repuestos_usados || []),
        JSON.stringify(ot.mano_obra || []),
        ot.abono || 0,
        ot.monto_estimado || 0, ot.monto_final || 0,
        1, ot.tecnico_asignado,
        ot.kilometraje || 0, ot.descripcion_servicio,
        JSON.stringify(ot.checklist_recepcion || []), ot.notas_internas
      ]
    );
    res.json(formatearOTParaFrontend(rows[0]));
  } catch (err) {
    console.error('ERROR POST:', err);
    handleError(res, err);
  }
});

app.patch('/api/ordenes_trabajo/:id/estado', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { estado, fecha_entrega, tecnico_asignado, dias_taller } = req.body;

    const otRes = await client.query(
      'SELECT ot.*, c.marca, c.modelo, c.patente FROM ordenes_trabajo ot LEFT JOIN clientes c ON ot.patente = c.patente WHERE ot.id = $1',
      [id]
    );
    if (!otRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'OT no encontrada' });
    }

    const ot = otRes.rows[0];
    const estadoAnterior = ot.estado_ot;
    const estadosTaller = ['Pendiente', 'En Proceso', 'Esperando Repuesto'];

    if (estado === 'Entregado' && estadoAnterior!== 'Finalizado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '⚠ Debe FINALIZAR antes de ENTREGAR' });
    }

    // ✅ FIX ZONA HORARIA CHILE
    let fechaEntregaFinal = fecha_entrega;
let usarFechaDB = false;
if (estado === 'Entregado' &&!fecha_entrega) {
  usarFechaDB = true;
}

    await client.query(
      `UPDATE ordenes_trabajo SET
        estado_ot = $1,
        fecha_entrega = $2,
        tecnico_asignado = COALESCE($3, tecnico_asignado),
        dias_taller = COALESCE($4, dias_taller)
       WHERE id = $5`,
      [estado, fechaEntregaFinal, tecnico_asignado, dias_taller, id]
    );

    const getRepuestos = () => {
      const r = ot.repuestos_usados;
      if (!r) return [];
      if (Array.isArray(r)) return r;
      if (typeof r === 'object') return r;
      try { return JSON.parse(r); } catch { return []; }
    };

    // 1⃣ FINALIZADO → VALIDA STOCK Y DESCUENTA
    if (estado === 'Finalizado' && estadosTaller.includes(estadoAnterior)) {
      const repuestos = getRepuestos().filter(r => r.desde_inventario);

      for (const rep of repuestos) {
        const prod = await client.query('SELECT stock_local, nombre FROM productos WHERE sku = $1', [rep.sku]);
        if (!prod.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `❌ SKU ${rep.sku} no existe en inventario` });
        }
        const stock = prod.rows[0].stock_local;
        if (stock < rep.cantidad) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `❌ NO SE PUEDE FINALIZAR OT\n📦 ${rep.sku} - ${prod.rows[0].nombre}\nStock disponible: ${stock}\nNecesitas: ${rep.cantidad}\n\nCompra o ajusta el repuesto primero.`
          });
        }
      }

      for (const rep of repuestos) {
        await client.query(
          'UPDATE productos SET stock_local = stock_local - $1, ventas_totales = ventas_totales + $1 WHERE sku = $2',
          [rep.cantidad, rep.sku]
        );
      }
      await client.query('COMMIT');
      return res.json({
        mensaje: `✅ OT FINALIZADA\n\n🚗 ${ot.marca} ${ot.modelo} (${ot.patente})\n📦 ${repuestos.length} repuesto(s) descontado(s)\n⏱ Sigue contando días en taller\n👉 Ya puedes ENTREGAR`
      });
    }

    // 2⃣ REABRIR → DEVUELVE
    if ((estadoAnterior === 'Finalizado' || estadoAnterior === 'Entregado') && estadosTaller.includes(estado)) {
      const repuestos = getRepuestos().filter(r => r.desde_inventario);
      for (const rep of repuestos) {
        await client.query(
          'UPDATE productos SET stock_local = stock_local + $1, ventas_totales = ventas_totales - $1 WHERE sku = $2',
          [rep.cantidad, rep.sku]
        );
      }
      await client.query('UPDATE ordenes_trabajo SET fecha_entrega = NULL WHERE id = $1', [id]);
      await client.query('COMMIT');
      return res.json({
        mensaje: `🔄 OT REABIERTA A ${estado.toUpperCase()}\n\n🚗 ${ot.marca} ${ot.modelo}\n↩ Stock devuelto: ${repuestos.length} item(s)\n📅 Días contando desde ${formatearFecha(ot.fecha_creacion)}`
      });
    }

    // 3⃣ ENTREGADO
    if (estado === 'Entregado') {
      const inicio = parsearFechaChile(ot.fecha_creacion);
      const fin = parsearFechaChile(fechaEntregaFinal);
      const diasCalculados = Math.max(1, Math.ceil((fin - inicio) / 86400000));

      await client.query('UPDATE ordenes_trabajo SET dias_taller = $1 WHERE id = $2', [diasCalculados, id]);

      await client.query('COMMIT');
      return res.json({
        mensaje: `🎉 AUTO ENTREGADO\n\n🚗 ${ot.marca} ${ot.modelo}\n🔖 Patente: ${ot.patente}\n⏱ ${diasCalculados} día${diasCalculados>1?'s':''} en taller\n\n✅ OT cerrada correctamente`
      });
    }

    await client.query('COMMIT');
    res.json({ mensaje: '✓ Estado actualizado' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR PATCH:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});





// PUT - CALCULA DÍAS DESDE fecha_creacion, NO RESETEA
app.put('/api/ordenes_trabajo/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const otNueva = req.body;

    const otAntiguaRes = await client.query('SELECT * FROM ordenes_trabajo WHERE id=$1', [id]);
    if (otAntiguaRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'OT no encontrada' });
    }
    const otAntigua = otAntiguaRes.rows[0];

    const vehiculoRes = await client.query('SELECT * FROM clientes WHERE patente=$1', [otAntigua.patente]);
    const vehiculo = vehiculoRes.rows[0] || {};
    const marca = (vehiculo.marca || 'SIN MARCA').toUpperCase();
    const modelo = (vehiculo.modelo || 'SIN MODELO').toUpperCase();
    const patente = otAntigua.patente;

    const estadosTaller = ['Pendiente', 'En Proceso', 'Esperando Repuesto'];
    const estadosFinales = ['Finalizado', 'Entregado'];

    if (otNueva.estado_ot === 'Entregado' && otAntigua.estado_ot!== 'Finalizado' && otAntigua.estado_ot!== 'Entregado') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Solo puedes entregar una OT que esté en estado Finalizado'
      });
    }

    let repuestosAfectados = [];

    if (otNueva.estado_ot === 'Finalizado' &&!estadosFinales.includes(otAntigua.estado_ot)) {
      const repuestosInventario = (otNueva.repuestos_usados || []).filter(r => r.desde_inventario === true);

      for (const rep of repuestosInventario) {
        const prodRes = await client.query('SELECT * FROM productos WHERE sku = $1', [rep.sku]);
        if (prodRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `SKU ${rep.sku} no existe en inventario` });
        }

        const producto = prodRes.rows[0];
        const nuevoStock = producto.stock_local - rep.cantidad;

        if (nuevoStock < 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Stock insuficiente para ${rep.sku} - ${producto.nombre}. Stock actual: ${producto.stock_local}, Se necesita: ${rep.cantidad}`
          });
        }

        await client.query(
          'UPDATE productos SET stock_local = $1, ventas_totales = ventas_totales + $2 WHERE id = $3',
          [nuevoStock, rep.cantidad, producto.id]
        );

        repuestosAfectados.push(`${rep.sku}: -${rep.cantidad}`);
      }
    }

    if (estadosFinales.includes(otAntigua.estado_ot) && estadosTaller.includes(otNueva.estado_ot)) {
      const repuestosAntiguos = typeof otAntigua.repuestos_usados === 'string'
       ? JSON.parse(otAntigua.repuestos_usados)
        : otAntigua.repuestos_usados || [];
      const repuestosInventario = repuestosAntiguos.filter(r => r.desde_inventario === true);

      for (const rep of repuestosInventario) {
        await client.query(
          'UPDATE productos SET stock_local = stock_local + $1, ventas_totales = ventas_totales - $1 WHERE sku = $2',
          [rep.cantidad, rep.sku]
        );
        repuestosAfectados.push(`${rep.sku}: +${rep.cantidad}`);
      }

      otNueva.fecha_entrega = null;
    }

    const fechaFin = otNueva.estado_ot === 'Entregado'
     ? (otNueva.fecha_entrega || otAntigua.fecha_entrega || new Date().toISOString())
      : null;

    const diasTaller = calcularDiasTaller({...otAntigua, fecha_entrega: fechaFin});
    otNueva.dias_en_taller = diasTaller;

    if (otNueva.estado_ot === 'Entregado' &&!otAntigua.fecha_entrega) {
  const { rows: fechaRows } = await client.query(`SELECT (NOW() AT TIME ZONE 'America/Santiago') as fecha_chile`);
  otNueva.fecha_entrega = fechaRows[0].fecha_chile;
}

    const { rows } = await client.query(
      `UPDATE ordenes_trabajo SET
       estado_ot=$1, monto_final=$2, fecha_inicio_taller=$3, fecha_entrega=$4,
       dias_en_taller=$5, repuestos_usados=$6, servicios=$7, obs_servicios=$8, mano_obra=$9, abono=$10,
       tecnico_asignado=$11, kilometraje=$12, descripcion_servicio=$13,
       checklist_recepcion=$14, notas_internas=$15, actualizado=NOW()
       WHERE id=$16 RETURNING *`,
      [
        otNueva.estado_ot, otNueva.monto_final, otNueva.fecha_inicio_taller, otNueva.fecha_entrega,
        diasTaller,
        JSON.stringify(otNueva.repuestos_usados || []),
        JSON.stringify(otNueva.servicios || []),
        JSON.stringify(otNueva.obs_servicios || {}), // ← AGREGADO ACÁ
        JSON.stringify(otNueva.mano_obra || []),
        otNueva.abono || 0,
        otNueva.tecnico_asignado, otNueva.kilometraje, otNueva.descripcion_servicio,
        JSON.stringify(otNueva.checklist_recepcion || []), otNueva.notas_internas, id
      ]
    );

    await client.query('COMMIT');

    let mensaje = 'OT actualizada';
    const otFinal = formatearOTParaFrontend(rows[0]);

    if (otNueva.estado_ot === 'Finalizado' &&!estadosFinales.includes(otAntigua.estado_ot)) {
      mensaje = repuestosAfectados.length > 0
       ? `OT finalizada. Stock descontado: ${repuestosAfectados.join(', ')}. Contador sigue corriendo.`
        : `OT finalizada. No había repuestos de inventario. Contador sigue corriendo.`;
    }
    else if (estadosFinales.includes(otAntigua.estado_ot) && estadosTaller.includes(otNueva.estado_ot)) {
      mensaje = `OT devuelta a taller. Stock devuelto: ${repuestosAfectados.join(', ')}. Días siguen contando.`;
    }
    else if (otNueva.estado_ot === 'Entregado') {
      mensaje = `AUTO ENTREGADO\n\n${marca} ${modelo}\nPatente: ${patente}\n\nEstuvo ${otFinal.dias_en_taller} día${otFinal.dias_en_taller!== 1? 's' : ''} en taller\nGracias por preferirnos!`;
    }

    res.json({
     ...otFinal,
      mensaje
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR PUT ordenes_trabajo:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});



// DELETE - NO DEVUELVE STOCK
app.delete('/api/ordenes_trabajo/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM ordenes_trabajo WHERE id=$1', [id]);

    res.json({
      ok: true,
      mensaje: 'OT eliminada.'
    });

  } catch (err) {
    console.error('ERROR DELETE ordenes_trabajo:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== HISTORIAL COT - LISTAR CON FILTROS ==========
app.get('/api/cotizaciones/historial', async (req, res) => {
  try {
    const { search, estado } = req.query;

    let query = `
      SELECT
        c.id,
		c.convertida,
        c.ot_id,
        COALESCE(c.rut_cliente, cl.rut) as rut_cliente,
        COALESCE(c.nombre_cliente, cl.nombre) as nombre_cliente,
        COALESCE(cl.patente, c.patente) as patente,
        COALESCE(cl.marca, c.marca) as marca,
	COALESCE(cl.modelo, c.modelo) as modelo,
        COALESCE(cl.anio, c.anio) as anio,
        COALESCE(c.celular, cl.celular) as celular,
        c.subtotal_neto,
        c.iva,
        c.total,
        c.observaciones,
        c.estado,
        c.items,
        c.creado_at,
        c.validez_hasta
      FROM cotizaciones c
      LEFT JOIN clientes cl ON c.patente = cl.patente
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (search) {
      query += ` AND (c.rut_cliente ILIKE $${paramCount} OR c.nombre_cliente ILIKE $${paramCount} OR c.patente ILIKE $${paramCount} OR CAST(c.id AS TEXT) ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    if (estado && estado!== 'Todos') {
      query += ` AND c.estado = $${paramCount}`;
      params.push(estado);
      paramCount++;
    }

    query += ' ORDER BY c.id DESC LIMIT 100';

    const { rows } = await pool.query(query, params);

    const cotizaciones = rows.map(c => ({
...c,
	  convertida: c.convertida || false,
      nombre_cliente: c.nombre_cliente || 'Cliente General',
      items: typeof c.items === 'string'? JSON.parse(c.items) : c.items || [],
      creado_at: c.creado_at? formatearFecha(c.creado_at) : '-',
      validez_hasta: c.validez_hasta? formatearFecha(c.validez_hasta) : null
    }));

    res.json(cotizaciones);
  } catch (err) {
    console.error('ERROR HISTORIAL:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== COTIZACIONES ==========
app.get('/api/cotizaciones', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.*,
        COALESCE((SELECT COUNT(*) FROM jsonb_array_elements_text(c.items) elem
          WHERE (elem::jsonb->>'tipo' IS NULL OR elem::jsonb->>'tipo' = 'repuesto')), 0) as total_items
      FROM cotizaciones c
      ORDER BY c.id DESC
    `);
    const cotizaciones = rows.map(c => ({
...c,
      items: typeof c.items === 'string'? JSON.parse(c.items) : c.items || [],
      creado_at: c.creado_at? new Date(c.creado_at).toLocaleDateString('es-CL') : '',
      validez_hasta: c.validez_hasta? new Date(c.validez_hasta).toLocaleDateString('es-CL') : ''
    }));
    res.json(cotizaciones);
  } catch (err) { handleError(res, err); }
});

app.get('/api/cotizaciones/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.*,
        cl.nombre as cliente_nombre_real,
        cl.celular as cliente_celular_real,
        cl.marca as cliente_marca_real,
        cl.modelo as cliente_modelo_real,
        cl.anio as cliente_anio_real
      FROM cotizaciones c
      LEFT JOIN clientes cl ON c.patente = cl.patente
      WHERE c.id = $1
    `, [req.params.id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Cotización no encontrada' });

    const cot = rows[0];
    res.json({
...cot,
      nombre_cliente: cot.cliente_nombre_real || cot.nombre_cliente || 'Cliente General',
      celular: cot.cliente_celular_real || cot.celular,
      marca: cot.cliente_marca_real || cot.marca,
      modelo: cot.cliente_modelo_real || cot.modelo,
      anio: cot.cliente_anio_real || cot.anio,
      items: typeof cot.items === 'string'? JSON.parse(cot.items) : cot.items || [],
      // FIX: devolver ISO, no DD-MM-YYYY
      creado_at: cot.creado_at,
      validez_hasta: cot.validez_hasta
    });
  } catch (err) { handleError(res, err); }
});

// CREAR COTIZACIÓN - FALTABA ESTE ENDPOINT
app.post('/api/cotizaciones', async (req, res) => {
  try {
    const {
      rut_cliente,
      patente,
      items,
      total_repuestos,
      total_mano_obra,
      subtotal_neto,
      iva,
      total,
      abono,
      observaciones,
      validez_hasta,
      estado
    } = req.body;

    if (!rut_cliente ||!patente) {
      return res.status(400).json({ error: 'RUT y patente son obligatorios' });
    }

    const itemsArray = typeof items === 'string'? JSON.parse(items) : items || [];
    const fecha_creacion = obtenerFechaHoraChileISO();

    const result = await pool.query(
      `INSERT INTO cotizaciones (
        rut_cliente, patente, items,
        total_repuestos, total_mano_obra, subtotal_neto, iva, total,
        abono, observaciones, estado, validez_hasta, creado_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        rut_cliente,
        patente,
        JSON.stringify(itemsArray),
        total_repuestos || 0,
        total_mano_obra || 0,
        subtotal_neto || 0,
        iva || 0,
        total || 0,
        abono || 0,
        observaciones || '',
        estado || 'Pendiente',
        validez_hasta || null,
        fecha_creacion
      ]
    );

    const cot = result.rows[0];
    res.json({
   ...cot,
      items: itemsArray
    });

  } catch (err) {
    console.error('ERROR POST COTIZACION:', err);
    res.status(500).json({ error: 'Error al guardar: ' + err.message });
  }
});


app.put('/api/cotizaciones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const c = req.body;
    const { rows } = await pool.query(
      `UPDATE cotizaciones SET
       cliente_id=$1, rut_cliente=$2, nombre_cliente=$3, patente=$4, marca=$5, modelo=$6, anio=$7, celular=$8,
       total_repuestos=$9, total_mano_obra=$10, subtotal_neto=$11, iva=$12, total=$13,
       observaciones=$14, validez_hasta=$15, estado=$16, items=$17, actualizado=NOW()
       WHERE id=$18 RETURNING *`,
      [
        c.cliente_id, c.rut_cliente, c.nombre_cliente, c.patente, c.marca, c.modelo, c.anio, c.celular,
        c.total_repuestos, c.total_mano_obra, c.subtotal_neto, c.iva, c.total,
        c.observaciones, c.validez_hasta, c.estado,
        JSON.stringify(c.items || []), id
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cotización no encontrada' });
    const cot = rows[0];
    res.json({
...cot,
      items: typeof cot.items === 'string'? JSON.parse(cot.items) : cot.items
    });
  } catch (err) { handleError(res, err); }
});

// MARCAR COTIZACIÓN COMO CONVERTIDA - EVITA DUPLICADOS
app.put('/api/cotizaciones/:id/marcar-convertida', async (req, res) => {
  try {
    const { id } = req.params;
    const { ot_id } = req.body;

    // 1. Valida que existe y no esté convertida
    const { rows } = await pool.query(
      'SELECT id, convertida FROM cotizaciones WHERE id = $1',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    if (rows[0].convertida) {
      return res.status(400).json({ error: 'Esta cotización ya fue convertida a OT' });
    }

    // 2. Marca como convertida
    const result = await pool.query(
      `UPDATE cotizaciones 
       SET convertida = true, 
           ot_id = $1, 
           fecha_conversion = NOW() 
       WHERE id = $2 
       RETURNING id, convertida, ot_id, fecha_conversion`,
      [ot_id, id]
    );

    console.log(`✅ COT ${id} marcada como convertida a OT ${ot_id}`);
    res.json({ 
      success: true, 
      message: 'Cotización marcada como convertida',
      cotizacion: result.rows[0] 
    });

  } catch (err) {
    console.error('ERROR marcar-convertida:', err);
    res.status(500).json({ error: 'Error al marcar cotización' });
  }
});

app.delete('/api/cotizaciones/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM cotizaciones WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
});

// CONVERTIR COTIZACIÓN A OT - VERSIÓN PRO
app.post('/api/cotizaciones/:id/crear-ot', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { kilometraje, tecnico_asignado, notas_internas } = req.body; // ← Datos opcionales del frontend

    // 1. BUSCA LA COTIZACIÓN
    const cotRes = await client.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
    if (cotRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    const cot = cotRes.rows[0];

    // 2. VALIDA QUE NO ESTÉ CONVERTIDA YA
    if (cot.estado === 'Convertida') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta cotización ya fue convertida a OT' });
    }

    // 3. VALIDA PATENTE
    if (!cot.patente) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La cotización no tiene patente asignada' });
    }

    // 4. PROCESA ITEMS
    const items = typeof cot.items === 'string'? JSON.parse(cot.items) : cot.items || [];
    
    // Separa repuestos vs mano de obra
const repuestos = items
.filter(i => i.tipo !== 'mano_obra')
.map(i => ({
sku: i.sku || 'MANUAL',
nombre: i.nombre,
cantidad: Number(i.cantidad) || 1,
precio_unitario: Number(i.precio_venta) || 0,
descuento: Number(i.descuento) || 0,
desde_inventario: i.desde_inventario || false
}));

const manoObra = items
.filter(i => i.tipo === 'mano_obra')
.map(i => ({
descripcion: i.nombre,
cantidad: Number(i.cantidad) || 1,
precio: Number(i.precio_venta) || 0,
descuento: Number(i.descuento) || 0
}));

    // Arma array de servicios pa mostrar
    const serviciosDeCotizacion = items.map(item => {
      const desc = item.descuento > 0? ` (-${item.descuento}%)` : '';
      if (item.tipo === 'mano_obra') {
        return `M.O: ${item.nombre} x${item.cantidad}${desc}`;
      }
      return `${item.nombre} x${item.cantidad}${desc}`;
    });

    // 5. CREA LA OT CON TODOS LOS DATOS
    const fechaCreacion = obtenerFechaHoraChileISO();
    const fechaInicio = obtenerFechaHoraChileISO();

    const otRes = await client.query(
      `INSERT INTO ordenes_trabajo (
        rut_cliente, patente, fecha_creacion, fecha_inicio_taller, fecha_entrega,
        estado_ot, servicios, obs_servicios, repuestos_usados, mano_obra, abono,
        monto_estimado, monto_final, dias_en_taller, tecnico_asignado,
        kilometraje, descripcion_servicio, checklist_recepcion, notas_internas, cotizacion_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        cot.rut_cliente,
        cot.patente,
        fechaCreacion,
        fechaInicio,
        null, // fecha_entrega
        'Pendiente',
        JSON.stringify(serviciosDeCotizacion.length > 0? serviciosDeCotizacion : ['Diagnóstico inicial']),
        JSON.stringify({}), // obs_servicios vacío
        JSON.stringify(repuestos),
        JSON.stringify(manoObra),
        cot.abono || 0, // ← PASA EL ABONO DE LA COT
        cot.total, // monto_estimado
        cot.total, // monto_final
        1, // dias_en_taller
        tecnico_asignado || null, // ← DEL FRONTEND SI LO MANDAN
        kilometraje || 0, // ← DEL FRONTEND SI LO MANDAN
        cot.observaciones || `OT creada desde cotización #${id}`,
        JSON.stringify([]), // checklist_recepcion vacío
        notas_internas || '', // ← DEL FRONTEND SI LO MANDAN
		id
      ]
    );

    // 6. MARCA LA COTIZACIÓN COMO CONVERTIDA
    await client.query('UPDATE cotizaciones SET estado = $1 WHERE id = $2', ['Convertida', id]);

    await client.query('COMMIT');
    
    const otFormateada = formatearOTParaFrontend(otRes.rows[0]);
    res.json({ 
      mensaje: `✅ OT #${otFormateada.id} creada desde COT #${id}`, 
      ot: otFormateada 
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR CREAR OT DESDE COT:', err);
    res.status(500).json({ error: 'Error al crear OT: ' + err.message });
  } finally {
    client.release();
  }
});

// ========== HEALTHCHECK ==========
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', time: new Date() });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', error: err.message });
  }
});

// ========== INGRESOS - SOLO LECTURA ==========
app.get('/api/ingresos', async (req, res) => {
  try {
    const { ot_id, cliente_rut, desde, hasta, limit = 100 } = req.query;
    let query = `
      SELECT 
        i.*,
        ot.patente,
        ot.marca,
        ot.modelo
      FROM ingresos i
      LEFT JOIN ordenes_trabajo ot ON i.ot_id = ot.id
      WHERE 1=1
    `;
    const params = [];
    
    if (ot_id) {
      params.push(parseInt(ot_id));
      query += ` AND i.ot_id = $${params.length}`;
    }
    
    if (cliente_rut) {
      params.push(cliente_rut);
      query += ` AND i.cliente_rut = $${params.length}`;
    }
    
    if (desde) {
      params.push(desde);
      query += ` AND i.fecha >= $${params.length}`;
    }
    
    if (hasta) {
      params.push(hasta + ' 23:59:59');
      query += ` AND i.fecha <= $${params.length}`;
    }
    
    query += ` ORDER BY i.fecha DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));
    
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { 
    handleError(res, err); 
  }
});


app.post('/api/ingresos', async (req, res) => {
  try {
    const { ot_id, cliente_rut, cliente_nombre, monto, tipo, metodo_pago, responsable, observaciones, fecha } = req.body;
    
    if (!monto || parseInt(monto) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    
    const { rows } = await pool.query(`
      INSERT INTO ingresos (ot_id, cliente_rut, cliente_nombre, monto, tipo, metodo_pago, responsable, observaciones, fecha)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [
      ot_id? parseInt(ot_id) : null,
      cliente_rut || null,
      cliente_nombre || null,
      parseInt(monto),
      tipo || 'pago_total',
      metodo_pago || 'efectivo',
      responsable || 'Sistema',
      observaciones || null,
      fecha || null
    ]);
    
    res.status(201).json(rows[0]);
  } catch (err) { 
    handleError(res, err); 
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API Taller corriendo en puerto ${PORT}`);
  console.log(`Health: /api/health`);
});
