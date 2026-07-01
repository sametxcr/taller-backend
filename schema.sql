-- TABLA CLIENTES
CREATE TABLE clientes (
    id_cliente SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    rut VARCHAR(12) UNIQUE NOT NULL,
    telefono VARCHAR(20),
    email VARCHAR(100),
    direccion TEXT,
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- TABLA MECANICOS
CREATE TABLE mecanicos (
    id_mecanico SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    especialidad VARCHAR(100),
    telefono VARCHAR(20),
    email VARCHAR(100),
    activo BOOLEAN DEFAULT true
);

-- TABLA VEHICULOS
CREATE TABLE vehiculos (
    id_vehiculo SERIAL PRIMARY KEY,
    patente VARCHAR(10) UNIQUE NOT NULL,
    marca VARCHAR(50),
    modelo VARCHAR(50),
    año INTEGER,
    id_cliente INTEGER REFERENCES clientes(id_cliente) ON DELETE CASCADE
);

-- TABLA SERVICIOS
CREATE TABLE servicios (
    id_servicio SERIAL PRIMARY KEY,
    id_vehiculo INTEGER REFERENCES vehiculos(id_vehiculo) ON DELETE CASCADE,
    id_mecanico INTEGER REFERENCES mecanicos(id_mecanico),
    fecha_ingreso DATE NOT NULL,
    fecha_salida DATE,
    descripcion TEXT,
    costo DECIMAL(10,2),
    estado VARCHAR(20) DEFAULT 'En proceso'
);

-- DATOS DE PRUEBA PA QUE NO ESTÉ VACÍO
INSERT INTO clientes (nombre, rut, telefono, email) VALUES 
('Juan Pérez', '12.345.678-9', '+56912345678', 'juan@test.com'),
('María González', '98.765.432-1', '+56987654321', 'maria@test.com');

INSERT INTO mecanicos (nombre, especialidad, telefono) VALUES 
('Carlos Mecánico', 'Motor', '+56911111111'),
('Pedro Frenos', 'Frenos y suspensión', '+56922222222');