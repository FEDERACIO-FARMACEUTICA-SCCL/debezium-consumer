# Informix CDC Consumer

Consumer Kafka en Node.js + TypeScript que lee eventos CDC de Informix generados por Debezium, detecta cambios en campos concretos y construye payloads JSON para enviar a una API REST.

## Arquitectura general

```
Informix DB
    |
    | (Change Data Capture)
    v
Debezium Server  -->  Kafka  -->  [este consumer]  -->  API REST (futuro)
```

Forma parte del stack CDC de Fedefarma pero se despliega de forma independiente. Se conecta a la red Docker del stack principal (`informix-debezium_default`) para alcanzar Kafka.

El stack de infraestructura (Kafka, Debezium Server, Redpanda Console) vive en `../informix-debezium/`.

## Como obtiene los datos (sin conexion directa a Informix)

Este consumer **NO se conecta a la base de datos Informix**. Todos los datos que necesita los obtiene de los propios eventos CDC que llegan por Kafka. Esto funciona asi:

### Paso 1: Debezium hace el snapshot inicial

Cuando Debezium arranca por primera vez, lee **todos los registros existentes** de las tablas monitorizadas (`ctercero`, `gproveed`, `cterdire`) y los envia como eventos de tipo snapshot (`op: "r"`) a Kafka. Cada registro de cada tabla se convierte en un mensaje Kafka con todos sus campos.

Es decir: si `ctercero` tiene 11.000 registros y `gproveed` tiene 7.000, Kafka recibe 18.000 mensajes con la foto completa de ambas tablas.

### Paso 2: El consumer reconstruye los datos en memoria

Cada vez que el consumer arranca, **lee todos los mensajes de Kafka desde el principio** (offset 0). Esto incluye tanto los snapshots como los cambios CDC posteriores. Con cada mensaje:

- Si es de `ctercero` --> lo guarda en un Map en memoria con clave `codigo`
- Si es de `gproveed` --> lo guarda en otro Map en memoria con clave `codigo`

Al terminar de re-leer todo el historico, el consumer tiene una **copia en memoria** de las tablas relevantes, equivalente a hacer un `SELECT * FROM ctercero` y `SELECT * FROM gproveed`.

```
Kafka (historico completo)          In-memory Store
+----------------------------+      +---------------------------+
| snapshot ctercero reg 1    | ---> | cterceroStore.set("P001") |
| snapshot ctercero reg 2    | ---> | cterceroStore.set("P002") |
| ...                        |      | ...                       |
| snapshot gproveed reg 1    | ---> | gproveedStore.set("P001") |
| ...                        |      | ...                       |
| CDC: update ctercero P001  | ---> | cterceroStore.set("P001") | (sobreescribe)
+----------------------------+      +---------------------------+
```

### Paso 3: Cambios en tiempo real

Una vez cargado el historico, el consumer queda escuchando cambios en vivo. Cuando llega un UPDATE de Debezium (por ejemplo, alguien modifica el nombre de un proveedor en Informix):

1. **Actualiza el store** con los nuevos datos
2. **Detecta si algun campo monitorizado cambio** (ej: `nombre`, `cif`, `fecalt`...)
3. Si hay cambios relevantes, **construye el payload Supplier** cruzando datos de `ctercero` y `gproveed` usando el campo `codigo` como clave comun
4. (Futuro) Envia el payload a la API REST

### Por que no necesita conectarse a Informix?

Porque Kafka conserva todo el historico de mensajes. El consumer re-lee el historico completo en cada arranque y reconstruye el estado de las tablas. Es como tener una "base de datos" en memoria alimentada por el stream de eventos. A efectos practicos:

- El snapshot de Debezium equivale a un `SELECT * FROM tabla`
- Cada evento CDC posterior equivale a un `INSERT/UPDATE/DELETE` aplicado sobre esa copia
- El consumer siempre tiene los datos actualizados sin consultar Informix

## Estructura del proyecto

```
informix-consumer/
├── package.json
├── tsconfig.json
├── Dockerfile            # Multi-stage: build TS + runtime Node
├── docker-compose.yml    # Despliegue con hot-reload
├── .dockerignore
├── .gitignore
└── src/
    ├── index.ts          # Entry point + graceful shutdown
    ├── config.ts         # Variables de entorno con defaults
    ├── consumer.ts       # Logica del consumer Kafka + orquestacion
    ├── store.ts          # Cache en memoria (Maps por tabla)
    ├── supplier.ts       # Construccion del payload Supplier
    ├── watched-fields.ts # Campos monitorizados + deteccion de cambios
    └── types/
        └── debezium.ts   # Tipos para eventos CDC de Debezium
```

## Flujo del consumer (paso a paso)

```
Mensaje Kafka llega
  |
  v
Parsear evento Debezium (extraer payload de {schema, payload})
  |
  v
Actualizar store en memoria (siempre, para todas las tablas)
  |
  v
Es snapshot (op: "r") o estamos en fase de rebuild?
  |-- Si --> Solo actualizar store, no procesar como cambio
  |-- No --> Continuar (es un cambio CDC en vivo)
  |
  v
Algun campo monitorizado cambio? (watched-fields.ts)
  |-- No --> Ignorar
  |-- Si --> Continuar
  |
  v
Es una tabla de Supplier? (ctercero o gproveed)
  |-- No --> Ignorar (por ahora, futuro: cterdire para otro endpoint)
  |-- Si --> Construir payload Supplier
  |
  v
Buscar datos en store por "codigo":
  - ctercero: nombre, cif
  - gproveed: fecalt, fecbaj
  |
  v
Construir JSON Supplier --> Log (futuro: enviar a API REST)
```

## Campos monitorizados

Solo se procesan cambios cuando estos campos especificos se modifican:

| Tabla | Campos |
|---|---|
| `ctercero` | `codigo`, `nombre`, `cif` |
| `gproveed` | `fecalt`, `fecbaj` |
| `cterdire` | `direcc`, `poblac`, `codnac`, `codpos`, `telef1`, `email` |

## Payload Supplier (ejemplo)

Cuando se detecta un cambio en `ctercero` o `gproveed`, se construye:

```json
{
  "Suppliers": [
    {
      "IdSupplier": "P01868-FC-UUID",
      "CodSupplier": "P01868",
      "Supplier": "Proveedor Demo S.A.",
      "NIF": "A12345678",
      "StartDate": "2023-05-10",
      "Status": "ACTIVO"
    }
  ]
}
```

Origen de cada campo:

| Campo | Origen | Notas |
|---|---|---|
| `IdSupplier` | `ctercero.codigo` + sufijo | Placeholder, se definira formato final |
| `CodSupplier` | `ctercero.codigo` | |
| `Supplier` | `ctercero.nombre` | Trimmed |
| `NIF` | `ctercero.cif` | Trimmed |
| `StartDate` | `gproveed.fecalt` | Debezium envia dias desde epoch, se convierte a YYYY-MM-DD |
| `Status` | `gproveed.fecbaj` | `null` = ACTIVO, con valor = BAJA |

## Requisitos previos

El stack de Kafka + Debezium debe estar levantado:

```bash
cd ../informix-debezium
docker compose up -d
```

## Uso

### Desarrollo (con hot-reload)

```bash
docker compose up -d --build
docker compose logs -f
```

El `docker-compose.yml` monta `./src` como volumen y usa `tsx --watch`. Los cambios en codigo se aplican automaticamente sin rebuild.

### Produccion

Usar el Dockerfile directamente con `CMD ["node", "dist/index.js"]` (sin el override de `command` del compose).

## Variables de entorno

| Variable | Default | Descripcion |
|---|---|---|
| `KAFKA_BROKERS` | `kafka:29092` | Bootstrap servers de Kafka |
| `KAFKA_GROUP_ID` | `informix-consumer` | Consumer group ID |
| `KAFKA_TOPICS` | `ctercero,cterdire,gproveed` | Topics a consumir (comma-separated) |
| `KAFKA_AUTO_OFFSET_RESET` | `earliest` | Offset reset policy |

## Topics Kafka

Los topics siguen el patron `informix.informix.{tabla}`:

| Topic | Tabla Informix |
|---|---|
| `informix.informix.ctercero` | ctercero |
| `informix.informix.cterdire` | cterdire |
| `informix.informix.gproveed` | gproveed |

## Formato de mensajes CDC

Debezium envuelve cada evento en `{schema, payload}`. El consumer extrae el `payload`:

```json
{
  "before": null,
  "after": { "codigo": "P01868", "nombre": "..." },
  "source": { "table": "ctercero", "db": "testdb" },
  "op": "c",
  "ts_ms": 1770626302328
}
```

Operaciones (`op`):
- `r` = SNAPSHOT (lectura inicial de todos los registros)
- `c` = INSERT
- `u` = UPDATE (incluye `before` y `after`)
- `d` = DELETE (datos en `before`, `after` es null)

Nota: los campos `CHAR` de Informix vienen con espacios al final (padding). El consumer hace `trim()` en las claves y valores relevantes.

## Stack tecnologico

- **Runtime**: Node.js 20
- **Lenguaje**: TypeScript 5
- **Cliente Kafka**: `@confluentinc/kafka-javascript` (basado en librdkafka, API compatible KafkaJS)
- **Plataforma Docker**: `linux/amd64` (requerido por librdkafka en Apple Silicon)

## Proximos pasos

1. Enviar payload Supplier a la API REST destino
2. Construir segundo payload con datos de `cterdire` (direcciones)
3. Cliente HTTP con reintentos
4. Dead letter queue para mensajes fallidos
