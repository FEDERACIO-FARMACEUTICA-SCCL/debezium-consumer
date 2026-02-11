# Informix CDC Consumer

Consumer Kafka en Node.js + TypeScript que lee eventos CDC de Informix generados por Debezium, detecta cambios en campos concretos y construye payloads JSON para enviar a una API REST. Incluye stack de monitoring con Grafana + Loki para visualizacion en tiempo real.

## Arquitectura general

```
Informix DB
    |
    | (Change Data Capture)
    v
Debezium Server  -->  Kafka  -->  [este consumer]  -->  Ingest API (PUT/DELETE)
                                        |
                                   Trigger API (:3001)  -->  Swagger UI (/docs)
                                        |
                                   pino (JSON stdout)
                                        |
                                   Promtail --> Loki --> Grafana (:3000)
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
4. Envia el payload a la API REST via `HttpDispatcher` → `ApiClient`

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
├── Dockerfile               # Multi-stage: build TS + runtime Node
├── docker-compose.yml       # Consumer + Loki + Promtail + Grafana
├── .dockerignore
├── .gitignore
├── monitoring/
│   ├── loki-config.yml              # Loki: storage, retention 7d, schema v13
│   ├── promtail-config.yml          # Promtail: Docker SD, label filter
│   └── grafana/
│       ├── provisioning/
│       │   ├── datasources/loki.yml # Datasource auto-provisionado
│       │   └── dashboards/dashboard.yml
│       └── dashboards/
│           └── informix-consumer.json  # Dashboard pre-construido (5 paneles)
└── src/
    ├── index.ts                     # Composition root: wiring de todos los modulos
    ├── config.ts                    # Variables de entorno con defaults (kafka + api + http)
    ├── logger.ts                    # initLogger() + singleton mutable pino
    │
    ├── types/
    │   ├── debezium.ts              # Tipos para eventos CDC de Debezium
    │   └── payloads.ts              # Interfaces Supplier, SupplierContact, PayloadType
    │
    ├── domain/
    │   ├── table-registry.ts        # Fuente unica de verdad para tablas y mappings
    │   ├── store.ts                 # InMemoryStore data-driven desde registry
    │   ├── watched-fields.ts        # Deteccion de cambios en campos monitorizados
    │   └── country-codes.ts         # Mapping ISO3 → ISO2 para codigos de pais
    │
    ├── payloads/
    │   ├── payload-builder.ts       # Interface PayloadBuilder + PayloadRegistry
    │   ├── supplier.ts              # SupplierBuilder implements PayloadBuilder
    │   └── supplier-contact.ts      # SupplierContactBuilder implements PayloadBuilder
    │
    ├── kafka/
    │   ├── consumer.ts              # Infra Kafka pura (connect, subscribe, run)
    │   ├── snapshot-tracker.ts      # Maquina de estados del snapshot
    │   └── message-handler.ts       # Orquestador eachMessage
    │
    ├── dispatch/
    │   ├── pending-buffer.ts        # Reintentos para payloads con datos incompletos
    │   ├── dispatcher.ts            # Interface PayloadDispatcher + HttpDispatcher + LogDispatcher
    │   └── http-client.ts           # ApiClient: JWT auth + renovacion automatica + HTTP calls
    │
    └── http/
        ├── server.ts               # Fastify server: Trigger API + Swagger UI + health
        └── schemas.ts              # JSON Schemas OpenAPI para todas las rutas
```

### Capas y responsabilidades

| Capa | Directorio | Responsabilidad |
|------|-----------|-----------------|
| **Types** | `types/` | Interfaces compartidas (Debezium events, payload shapes) |
| **Domain** | `domain/` | Table registry (fuente unica de verdad), store en memoria, deteccion de cambios |
| **Payloads** | `payloads/` | Builders de payloads (patron Strategy via `PayloadBuilder` interface) |
| **Kafka** | `kafka/` | Infraestructura Kafka pura, snapshot state machine, orquestacion de mensajes |
| **Dispatch** | `dispatch/` | Envio de payloads via HTTP (`HttpDispatcher` + `ApiClient`), buffer de reintentos |
| **HTTP** | `http/` | Trigger API (Fastify): bulk sync/delete endpoints, Swagger UI, health check |

### Como añadir un nuevo payload type

Para añadir, por ejemplo, un payload `warehouse` alimentado por `ctercero` + `calmacen`:

1. Añadir fila en `TABLE_REGISTRY` (`domain/table-registry.ts`) para `calmacen` + añadir `"warehouse"` al array `payloads` de los campos de `ctercero` que apliquen
2. Añadir `"warehouse"` al tipo `PayloadType` en `types/payloads.ts`
3. Crear `payloads/warehouse.ts` implementando `PayloadBuilder`
4. Registrar en `index.ts`: `registry.register(new WarehouseBuilder())`

**Zero cambios** en consumer, message handler, pending buffer, store o watched fields.

## Flujo del consumer (paso a paso)

```
Mensaje Kafka llega
  |
  v
kafka/consumer.ts delega a MessageCallback
  |
  v
kafka/message-handler.ts:
  |
  v
Parsear evento Debezium (extraer payload de {schema, payload})
  |
  v
Actualizar store en memoria (siempre, para todas las tablas)
  |
  v
snapshot-tracker: Es snapshot (op: "r") o estamos en fase de rebuild?
  |-- Si --> Solo actualizar store, no procesar como cambio
  |-- No --> Continuar (es un cambio CDC en vivo)
  |
  v
Algun campo monitorizado cambio? (domain/watched-fields.ts)
  |-- No --> Ignorar
  |-- Si --> Continuar
  |
  v
FIELD_TO_PAYLOADS: para cada campo cambiado, que payload types afecta?
  (acumula un Set<PayloadType> con la union de todos los campos cambiados)
  |
  v
PayloadRegistry: ejecutar builder para cada type resultante
  |
  v
Payload construido?
  |-- Si --> HttpDispatcher.dispatch() --> ApiClient.request() --> API externa
  |-- No --> Encolar en pending-buffer para reintento (max 5 retries, 60s TTL)
```

## Campos monitorizados y dispatch de payloads

Solo se procesan cambios cuando estos campos especificos se modifican. La decision de que payloads enviar se toma a **nivel de campo**, no de tabla. Cada campo en el registry declara que payload types alimenta. Definido en `domain/table-registry.ts`:

| Campo cambiado | Supplier | Contact | Se envia |
|---|---|---|---|
| `ctercero.codigo` | Si | Si | Ambos |
| `ctercero.nombre` | Si | Si | Ambos |
| `ctercero.cif` | Si | Si | Ambos |
| `gproveed.fecalt` | Si | No | Solo Supplier |
| `gproveed.fecbaj` | Si | Si | Ambos |
| `cterdire.direcc` | No | Si | Solo Contact |
| `cterdire.poblac` | No | Si | Solo Contact |
| `cterdire.codnac` | No | Si | Solo Contact |
| `cterdire.codpos` | No | Si | Solo Contact |
| `cterdire.telef1` | No | Si | Solo Contact |
| `cterdire.email` | No | Si | Solo Contact |

### Resumen por escenario

| Que cambia | Payloads enviados | Por que |
|---|---|---|
| Cualquier campo de **ctercero** | Supplier + Contact | nombre/cif se usan en ambos payloads |
| Solo **gproveed.fecalt** | Solo Supplier | fecalt solo afecta a StartDate (Supplier) |
| Solo **gproveed.fecbaj** | Supplier + Contact | fecbaj determina Status en ambos payloads |
| **gproveed.fecalt + fecbaj** | Supplier + Contact | fecbaj arrastra Contact |
| Cualquier campo de **cterdire** | Solo Contact | direcciones solo existen en SupplierContact |

Si cambian campos de varias tablas en la misma transaccion, cada evento CDC se procesa por separado y solo dispara los payloads que le corresponden.

## Payloads

Los payloads se envian como arrays directamente a la API (sin wrapper), alineados con la especificacion OpenAPI (`src/external-api-documentation/openapi.json`).

### Supplier

Se construye cuando cambian campos que lo alimentan (`ctercero.*`, `gproveed.fecalt`, `gproveed.fecbaj`). Cruza datos de `ctercero` y `gproveed` por `codigo`. Se envia a `PUT /ingest-api/suppliers`.

```json
[
  {
    "CodSupplier": "P01868",
    "Supplier": "Proveedor Demo S.A.",
    "NIF": "A12345678",
    "StartDate": "2023-05-10",
    "Status": "ACTIVE"
  }
]
```

| Campo | Origen | Notas |
|---|---|---|
| `CodSupplier` | `ctercero.codigo` | Requerido |
| `Supplier` | `ctercero.nombre` | Requerido, trimmed |
| `NIF` | `ctercero.cif` | Nullable, trimmed (empty string → null) |
| `StartDate` | `gproveed.fecalt` | Debezium envia dias desde epoch → YYYY-MM-DD |
| `Status` | `gproveed.fecbaj` | `null` → ACTIVE, con valor → INACTIVE |

### SupplierContact

Se construye cuando cambian campos que lo alimentan (`ctercero.*`, `gproveed.fecbaj`, `cterdire.*`). Nota: un cambio solo en `gproveed.fecalt` **no** dispara este payload. Genera una entrada por cada direccion del proveedor. Se envia a `PUT /ingest-api/suppliers-contacts`.

```json
[
  {
    "CodSupplier": "P01881",
    "Name": "KONCARE BIOTECH SL.",
    "NIF": "B19325638",
    "Adress": "CALLE RIO MANZANARES 1359",
    "City": "EL CASAR GUADALAJARA",
    "Country": "ES",
    "Postal_Code": "19170",
    "Phone": null,
    "E_Mail": "pedidos@koncare.es",
    "Status": "ACTIVE"
  }
]
```

| Campo | Origen | Notas |
|---|---|---|
| `CodSupplier` | `ctercero.codigo` | Requerido |
| `Name` | `ctercero.nombre` | Requerido, trimmed |
| `NIF` | `ctercero.cif` | Nullable, trimmed |
| `Adress` | `cterdire.direcc` | Nullable, trimmed (una entrada por direccion) |
| `City` | `cterdire.poblac` | Nullable, trimmed |
| `Country` | `cterdire.codnac` | ISO3 → ISO2 (ej: ESP → ES) |
| `Postal_Code` | `cterdire.codpos` | Nullable, trimmed |
| `Phone` | `cterdire.telef1` | Nullable, trimmed |
| `E_Mail` | `cterdire.email` | Nullable, trimmed |
| `Status` | `gproveed.fecbaj` | `null` → ACTIVE, con valor → INACTIVE |

### Pending buffer

Si al construir un payload faltan datos (ej: llega un evento de `cterdire` pero aun no se ha recibido `ctercero` para ese `codigo`), el codigo se encola en un buffer de reintentos:

- Reintento cada 2 segundos
- Maximo 5 reintentos o 60 segundos de antiguedad
- Capacidad maxima: 10.000 entradas (evicta las mas antiguas)

## Trigger API (bulk sync/delete)

Servidor Fastify en puerto 3001 que permite lanzar operaciones bulk de sincronizacion y borrado contra la Ingest API. Protegido con Bearer token (`TRIGGER_API_KEY`).

### Endpoints

| Metodo | Ruta | Descripcion |
|---|---|---|
| `GET` | `/health` | Health check (sin auth) |
| `POST` | `/triggers/sync/suppliers` | Sync bulk de todos los suppliers del store |
| `POST` | `/triggers/sync/contacts` | Sync bulk de todos los contacts del store |
| `POST` | `/triggers/delete/suppliers` | Delete bulk de todos los suppliers |
| `POST` | `/triggers/delete/contacts` | Delete bulk de todos los contacts |

Todas las rutas `/triggers/*` requieren header `Authorization: Bearer <TRIGGER_API_KEY>`. Si ya hay una operacion bulk en curso, devuelve `409 Conflict`.

### Respuesta (BulkResult)

```json
{
  "operation": "sync",
  "target": "supplier",
  "totalCodigos": 11234,
  "totalItems": 11200,
  "batches": 12,
  "successBatches": 12,
  "failedBatches": 0,
  "skipped": 34,
  "durationMs": 8432
}
```

### Swagger UI (documentacion interactiva)

La API incluye documentacion OpenAPI 3.0.3 auto-generada con `@fastify/swagger` + `@fastify/swagger-ui`. Los schemas se definen inline en cada ruta — cuando se añadan o modifiquen rutas, la documentacion se actualiza automaticamente.

| URL | Auth | Proposito |
|---|---|---|
| `http://localhost:3001/docs` | No | Swagger UI interactivo |
| `http://localhost:3001/docs/json` | No | OpenAPI spec JSON (importable en Postman) |
| `http://localhost:3001/docs/yaml` | No | OpenAPI spec YAML |

Para ejecutar llamadas desde Swagger UI:

1. Abrir `http://localhost:3001/docs`
2. Click en el boton **Authorize** (icono candado)
3. Introducir el Bearer token (valor de `TRIGGER_API_KEY`)
4. Click **Authorize** → el token se guarda en localStorage entre recargas (`persistAuthorization: true`)
5. Expandir cualquier endpoint y click **Try it out** → **Execute**

## Requisitos previos

El stack de Kafka + Debezium debe estar levantado:

```bash
cd ../informix-debezium
docker compose up -d
```

## Uso

### Desarrollo (con hot-reload)

```bash
# Levantar consumer + monitoring stack
docker compose up -d --build

# Ver logs del consumer
docker compose logs -f consumer
```

El `docker-compose.yml` monta `./src` como volumen y usa `tsx --watch`. Los cambios en codigo se aplican automaticamente sin rebuild.

### Monitoring (Grafana)

Abrir `http://localhost:3000` en el navegador. Login: anonymous (viewer) o admin/admin.

El dashboard "Informix Consumer" se provisiona automaticamente con 5 paneles:

1. **Log stream** - Timeline de todos los logs (filtrable por tag)
2. **CDC events/min** - Rate de eventos por tabla (timeseries)
3. **Errors** - Logs de nivel error/fatal
4. **Store rebuild progress** - Progreso de la reconstruccion del store
5. **Pending buffer** - Reintentos y codigos descartados

Queries utiles en Grafana Explore:

```
# Todos los logs
{container="informix-consumer"}

# Solo eventos CDC
{container="informix-consumer"} | json | tag = `CDC`

# Solo errores (pino level 50=error, 60=fatal)
{container="informix-consumer"} | json | level >= 50

# Buscar texto en cualquier campo (ej: nombre de proveedor)
{container="informix-consumer"} |= `BIOTECH`

# Ver payloads Supplier completos (requiere LOG_LEVEL=debug)
{container="informix-consumer"} | json | msg = "Supplier payload details"

# Ver payloads SupplierContact completos (requiere LOG_LEVEL=debug)
{container="informix-consumer"} | json | msg = "SupplierContact payload details"

# Llamadas a la API externa
{container="informix-consumer"} | json | tag = `API`

# Errores API
{container="informix-consumer"} | json | tag = `API` | level >= 50

# Autenticaciones JWT
{container="informix-consumer"} | json | tag = `API` | action = `authenticate`

# Llamadas API lentas (>1s)
{container="informix-consumer"} | json | tag = `API` | durationMs > 1000
```

### Produccion

Usar el Dockerfile directamente con `CMD ["node", "dist/index.js"]` (sin el override de `command` del compose).

## Variables de entorno

| Variable | Default | Descripcion |
|---|---|---|
| `KAFKA_BROKERS` | `kafka:29092` | Bootstrap servers de Kafka |
| `KAFKA_GROUP_ID` | `informix-consumer` | Consumer group ID |
| `KAFKA_TOPICS` | (derivado del registry) | Topics a consumir (comma-separated) |
| `KAFKA_AUTO_OFFSET_RESET` | `earliest` | Offset reset policy |
| `INGEST_API_BASE_URL` | **(requerido)** | URL base de la Ingest API (ej: `https://api.example.com`) |
| `INGEST_API_USERNAME` | **(requerido)** | Usuario para autenticacion JWT |
| `INGEST_API_PASSWORD` | **(requerido)** | Password para autenticacion JWT |
| `LOG_LEVEL` | `info` | Nivel de log pino (`debug`, `info`, `warn`, `error`, `fatal`) |
| `HTTP_PORT` | `3001` | Puerto del servidor Trigger API |
| `HTTP_ENABLED` | `false` | Habilitar servidor Trigger API |
| `TRIGGER_API_KEY` | **(requerido si HTTP_ENABLED)** | Bearer token para autenticar llamadas a la Trigger API |

**Nota sobre LOG_LEVEL**: Con `info` solo se loguean metadatos (tabla, operacion, campos cambiados, codigo). Con `debug` se incluyen payloads completos y valores PII (nombres, NIFs, direcciones). Usar `debug` solo en desarrollo. Cambiar `LOG_LEVEL` requiere recrear el container (`docker compose up -d consumer`).

## Topics Kafka

Los topics siguen el patron `informix.informix.{tabla}` y se derivan automaticamente del `TABLE_REGISTRY`:

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
- **HTTP server**: Fastify 5 + `@fastify/swagger` + `@fastify/swagger-ui` (OpenAPI 3.0.3)
- **Logging**: `pino` (JSON estructurado, zero-dep)
- **Monitoring**: Grafana 11.5 + Loki 3.4 + Promtail 3.4
- **Plataforma Docker**: `linux/amd64` (requerido por librdkafka en Apple Silicon)

## Proximos pasos

1. ~~Implementar `HttpDispatcher` para enviar payloads a la API REST destino~~ ✓
2. ~~Implementar servidor HTTP con Trigger API (bulk sync/delete endpoints)~~ ✓
3. ~~Documentacion Swagger/OpenAPI auto-generada para la Trigger API~~ ✓
4. Manejo de reintentos HTTP y dead letter queue
5. Filtrado por tipo de operacion si es necesario
6. Alertas en Grafana (errores sostenidos, pending buffer creciendo)
