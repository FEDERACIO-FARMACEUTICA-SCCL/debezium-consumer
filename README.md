# Informix CDC Consumer

Consumer Kafka en Node.js + TypeScript que lee eventos CDC de Informix generados por Debezium, detecta cambios en campos concretos y construye payloads JSON para enviar a una API REST. Incluye stack de monitoring con Grafana + Loki para visualizacion en tiempo real.

## Arquitectura general

```
Informix DB
    |
    | (Change Data Capture)
    v
Debezium Server  -->  Kafka  -->  [este consumer]  --debounce-->  Ingest API (PUT/DELETE)
                                        |
                                   Trigger API (:3001)  -->  Swagger UI (/docs)
                                        |                -->  Store Viewer (/store)
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

Cuando Debezium arranca por primera vez, lee **todos los registros existentes** de las tablas monitorizadas (`ctercero`, `gproveed`, `cterdire`, `cterasoc`) y los envia como eventos de tipo snapshot (`op: "r"`) a Kafka. Cada registro de cada tabla se convierte en un mensaje Kafka con todos sus campos.

Es decir: si `ctercero` tiene 11.000 registros y `gproveed` tiene 7.000, Kafka recibe 18.000 mensajes con la foto completa de ambas tablas.

### Paso 2: El consumer reconstruye los datos en memoria

Cada vez que el consumer arranca, **lee todos los mensajes de Kafka desde el principio** (offset 0). Esto incluye tanto los snapshots como los cambios CDC posteriores. Con cada mensaje:

- Si es de `ctercero` --> lo guarda en un Map en memoria con clave `codigo`
- Si es de `gproveed` --> lo guarda en otro Map en memoria con clave `codigo`

Al terminar de re-leer todo el historico, el consumer tiene una **copia en memoria** de las tablas relevantes, equivalente a hacer un `SELECT * FROM ctercero` y `SELECT * FROM gproveed`.

**Optimizacion de memoria (`storeFields`)**: Debezium tiene un bug que impide filtrar columnas en origen — siempre envia TODAS las columnas de cada tabla Informix (que puede tener 30+ campos). Para evitar almacenar campos innecesarios, cada tabla en el registry declara `storeFields`: la lista de campos a conservar. Los campos no listados se descartan al escribir en el store (`pickFields()`). Ejemplo: `ctercero` solo conserva `codigo`, `nombre`, `cif` y `codare` de los 30+ campos que envia Debezium.

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
3. Si hay cambios relevantes, **encola el codigo en el debouncer** con los tipos de payload afectados
4. Tras la ventana de debounce (1s por defecto), **construye los payloads** cruzando datos de `ctercero` y `gproveed` usando el campo `codigo` como clave comun
5. Envia los payloads agrupados por tipo en batches a la API REST via `HttpDispatcher` → `ApiClient`

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
├── vitest.config.ts            # Config vitest (globals, root: src)
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
    ├── config.ts                    # Variables de entorno con defaults (kafka + api + http + debounce)
    ├── logger.ts                    # initLogger() + singleton mutable pino
    │
    ├── types/
    │   ├── debezium.ts              # Tipos para eventos CDC de Debezium
    │   ├── payloads.ts              # Interfaces Supplier, SupplierContact, PayloadType
    │   └── deletions.ts             # Interfaces de borrado, SkippedDetail, BulkResult
    │
    ├── domain/
    │   ├── table-registry.ts        # Fuente unica de verdad para TABLAS, mappings CDC y storeFields
    │   ├── entity-registry.ts       # Fuente unica de verdad para ENTIDADES (API, triggers, labels)
    │   ├── codare-registry.ts       # Filtro de negocio: codare → PayloadType[] (que terceros disparan cada entidad)
    │   ├── store.ts                 # InMemoryStore data-driven desde table-registry (con filtrado de campos)
    │   ├── watched-fields.ts        # Deteccion de cambios en campos monitorizados
    │   └── country-codes.ts         # Mapping ISO3 → ISO2 para codigos de pais
    │
    ├── payloads/
    │   ├── payload-builder.ts       # Interface PayloadBuilder + PayloadRegistry
    │   ├── payload-utils.ts         # Helpers compartidos: trimOrNull, isActive, formatDate
    │   ├── supplier.ts              # SupplierBuilder implements PayloadBuilder
    │   └── supplier-contact.ts      # SupplierContactBuilder implements PayloadBuilder
    │
    ├── kafka/
    │   ├── consumer.ts              # Infra Kafka pura (connect, subscribe, run)
    │   ├── snapshot-tracker.ts      # Maquina de estados del snapshot
    │   └── message-handler.ts       # Orquestador eachMessage
    │
    ├── dispatch/
    │   ├── cdc-debouncer.ts         # Debounce + aggregation de CDCs antes de enviar a la API
    │   ├── pending-buffer.ts        # Reintentos para payloads con datos incompletos
    │   ├── dispatcher.ts            # Interface PayloadDispatcher + HttpDispatcher + LogDispatcher
    │   └── http-client.ts           # ApiClient: JWT auth + renovacion automatica + HTTP calls
    │
    ├── bulk/
    │   ├── bulk-handler.ts          # Interface BulkHandler (syncAll/deleteAll por entidad)
    │   ├── bulk-service.ts          # Motor generico: sync(type)/delete(type) + batching + mutex
    │   └── handlers/
    │       ├── supplier-handler.ts  # SupplierBulkHandler implements BulkHandler
    │       └── contact-handler.ts   # ContactBulkHandler implements BulkHandler
    │
    └── http/
        ├── server.ts               # Fastify server: rutas dinamicas desde ENTITY_REGISTRY + Swagger
        ├── schemas.ts              # makeTriggerSchema() factory + schemas compartidos
        └── store-viewer.ts         # Store Viewer: endpoints JSON + pagina HTML autocontenida
```

### Capas y responsabilidades

| Capa | Directorio | Responsabilidad |
|------|-----------|-----------------|
| **Types** | `types/` | Interfaces compartidas (Debezium events, payload shapes, deletion shapes) |
| **Domain** | `domain/` | Table registry (tablas CDC), entity registry (entidades API), store en memoria, deteccion de cambios |
| **Payloads** | `payloads/` | Builders de payloads (patron Strategy via `PayloadBuilder` interface) + helpers compartidos (`payload-utils.ts`) |
| **Kafka** | `kafka/` | Infraestructura Kafka pura, snapshot state machine, orquestacion de mensajes |
| **Dispatch** | `dispatch/` | CDC debounce + aggregation, envio via HTTP (`HttpDispatcher` + `ApiClient`), buffer de reintentos |
| **Bulk** | `bulk/` | Operaciones bulk para la Trigger API: `BulkHandler` por entidad + `BulkService` generico |
| **HTTP** | `http/` | Trigger API (Fastify): rutas dinamicas desde entity-registry, Swagger UI, Store Viewer, health check |

### Dos registries: tablas vs entidades

El proyecto tiene dos registries data-driven complementarios:

- **`domain/table-registry.ts`** — define las **tablas** del pipeline CDC: que campos monitorizar, como almacenar en el store, que payload types alimenta cada campo, que campos conservar en memoria (`storeFields`), y que campo usar como clave de agrupacion (`keyField`, default `"codigo"`). Es la fuente de verdad para `store.ts`, `watched-fields.ts`, `message-handler.ts`.

- **`domain/entity-registry.ts`** — define las **entidades** de la capa API/Trigger: tipo, label para logs, ruta HTTP del trigger, endpoint de la API externa, y metadatos Swagger. Es la fuente de verdad para `server.ts`, `schemas.ts`, `dispatcher.ts`, `cdc-debouncer.ts`, `pending-buffer.ts`, `bulk-service.ts`.

Ambos registries se importan como arrays constantes con lookups derivados computados una vez al cargar el modulo.

### Como añadir una nueva entidad

Para añadir, por ejemplo, una entidad `warehouse`:

1. Añadir entrada en `ENTITY_REGISTRY` (`domain/entity-registry.ts`) — type, label, triggerPath, apiPath, swagger
2. Añadir fila en `TABLE_REGISTRY` (`domain/table-registry.ts`) para la nueva tabla + añadir el tipo a `feedsPayloads` de tablas existentes si aplica
3. Añadir `"warehouse"` al union `PayloadType` en `types/payloads.ts`
4. Crear `payloads/warehouse.ts` implementando `PayloadBuilder`
5. Crear `bulk/handlers/warehouse-handler.ts` implementando `BulkHandler` (metodos `syncAll` + `deleteAll`)
6. Registrar en `index.ts`:
   - `registry.register(new WarehouseBuilder())`
   - `bulkService.registerHandler(new WarehouseBulkHandler(registry))`

**Zero cambios** en server.ts, schemas.ts, bulk-service.ts, dispatcher.ts, debouncer.ts, pending-buffer.ts, consumer, message handler, store o watched fields. Las rutas HTTP, los schemas Swagger y el routing de endpoints se generan automaticamente desde los registries.

## Tests

Suite de tests unitarios con [vitest](https://vitest.dev/). **184 tests** en 14 ficheros, ejecucion en ~400ms. Sin dependencias externas (sin Kafka, sin HTTP real).

```bash
npm test              # ejecutar toda la suite una vez
npm run test:watch    # modo watch (re-ejecuta al guardar)
```

Los tests estan colocados junto al codigo fuente (`*.test.ts`), excluidos del build de TypeScript.

### Que se testea

**Tier 1 — Funciones puras** (sin mocks, sin side effects):

| Fichero | Que testea | Tests |
|---|---|---|
| `payloads/payload-utils.test.ts` | `trimOrNull`, `isActive`, `formatDate` | 26 |
| `domain/country-codes.test.ts` | `toISO2` (ISO3→ISO2 mapping) | 11 |
| `domain/watched-fields.test.ts` | `detectChanges` (deteccion de campos cambiados) | 10 |
| `kafka/snapshot-tracker.test.ts` | `SnapshotTracker` (maquina de estados) | 11 |
| `domain/entity-registry.test.ts` | `ENTITY_REGISTRY`, lookups derivados, unicidad | 7 |
| `domain/codare-registry.test.ts` | `CODARE_REGISTRY`, `getAllowedTypes` (PRO mapping, null, whitespace) | 9 |

**Tier 2 — Logica de negocio** (con mocks de store, logger, timers):

| Fichero | Que testea | Tests |
|---|---|---|
| `domain/store.test.ts` | `InMemoryStore` (CRUD single/array, storeFields filtering, stats, clear) | 28 |
| `payloads/supplier.test.ts` | `SupplierBuilder` (build, datos incompletos, Status) | 11 |
| `payloads/supplier-contact.test.ts` | `SupplierContactBuilder` (N direcciones, Country, null fields) | 12 |
| `dispatch/cdc-debouncer.test.ts` | `CdcDebouncer` (debounce, merge, batching, stop) | 12 |
| `dispatch/pending-buffer.test.ts` | Pending buffer (retry, eviction, anti-overlap) | 11 |
| `bulk/bulk-service.test.ts` | `BulkService` generico (sync/delete por tipo, batching, mutex) | 14 |
| `bulk/handlers/supplier-handler.test.ts` | `SupplierBulkHandler` (syncAll/deleteAll, skippedDetails, codare filter) | 10 |
| `bulk/handlers/contact-handler.test.ts` | `ContactBulkHandler` (syncAll/deleteAll, skippedDetails, codare filter) | 12 |

### Ejecutar un solo fichero

```bash
npx vitest run src/payloads/supplier.test.ts
```

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
Filtro codare: intersectar payloadTypes con getAllowedTypes(codare)
  |-- codare no registrado --> Ignorar (no se genera payload)
  |-- codare valido (ej: PRO) --> Continuar con tipos permitidos
  |
  v
CdcDebouncer.enqueue(codigo, payloadTypes)
  |
  v
... mas CDCs llegan, se acumulan en Map<codigo, Set<PayloadType>> ...
  |
  v
flush() (por timer o por tamaño de buffer)
  |
  v
Para cada (codigo, types): builder.build(codigo) desde el store (estado final)
  |
  v
Agrupar items por tipo (supplier[], contact[])
  |-- Batch dispatch: un PUT por tipo/batch --> ApiClient.request() --> API externa
  |-- Build null --> Encolar en pending-buffer para reintento (max 5 retries, 60s TTL)
```

## Campos monitorizados y dispatch de payloads

Solo se procesan cambios cuando estos campos especificos se modifican. La decision de que payloads enviar se toma a **nivel de campo**, no de tabla. Cada campo en el registry declara que payload types alimenta. Definido en `domain/table-registry.ts`:

| Campo cambiado | Supplier | Contact | Se envia |
|---|---|---|---|
| `ctercero.codigo` | Si | Si | Ambos |
| `ctercero.nombre` | Si | Si | Ambos |
| `ctercero.cif` | Si | Si | Ambos |
| `ctercero.codare` | Si | Si | Ambos |
| `gproveed.fecalt` | Si | No | Solo Supplier |
| `gproveed.fecbaj` | Si | Si | Ambos |
| `cterdire.direcc` | No | Si | Solo Contact |
| `cterdire.poblac` | No | Si | Solo Contact |
| `cterdire.codnac` | No | Si | Solo Contact |
| `cterdire.codpos` | No | Si | Solo Contact |
| `cterdire.telef1` | No | Si | Solo Contact |
| `cterdire.email` | No | Si | Solo Contact |
| `cterasoc.*` | — | — | Sin watched fields (solo almacenamiento en store) |

### Resumen por escenario

| Que cambia | Payloads enviados | Por que |
|---|---|---|
| Cualquier campo de **ctercero** | Supplier + Contact | nombre/cif se usan en ambos payloads |
| Solo **gproveed.fecalt** | Solo Supplier | fecalt solo afecta a StartDate (Supplier) |
| Solo **gproveed.fecbaj** | Supplier + Contact | fecbaj determina Status en ambos payloads |
| **gproveed.fecalt + fecbaj** | Supplier + Contact | fecbaj arrastra Contact |
| Cualquier campo de **cterdire** | Solo Contact | direcciones solo existen en SupplierContact |

Si cambian campos de varias tablas en la misma transaccion, cada evento CDC se procesa por separado y solo dispara los payloads que le corresponden.

### Filtro por codare (tipo de tercero)

Las tablas `ctercero`, `gproveed` y `cterdire` contienen distintos tipos de terceros (proveedores, clientes, laboratorios...). El campo `codare` de `ctercero` indica el tipo. Solo los codigos con un `codare` registrado generan payloads. Actualmente solo `"PRO"` (proveedor) esta registrado, habilitando Supplier y SupplierContact.

El filtro se aplica en dos puntos:
- **CDC en tiempo real** (`message-handler.ts`): se intersectan los payload types con los tipos permitidos por el codare antes de encolar al debouncer
- **Trigger API** (bulk handlers): cada `syncAll`/`deleteAll` valida el codare y reporta `"codare 'XXX' not applicable"` en `skippedDetails`

El store almacena TODOS los registros sin filtrar — el codare solo filtra el dispatch. Configurado en `domain/codare-registry.ts`.

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
- Capacidad maxima: 10.000 entradas (evicta las mas antiguas con warning)
- Anti-overlap: un flag `retrying` impide que un nuevo ciclo de `setInterval` arranque mientras el anterior sigue ejecutando dispatches async
- Los dispatch se hacen con `await` + try/catch; un fallo en un tipo no bloquea los demas

## CDC Debouncer (agregacion antes del dispatch)

Cuando el consumer re-arranca, lee todo el historico de Kafka desde offset 0. Tras el snapshot, los CDCs pendientes se procesan como "live" — sin debounce, esto generaria un PUT HTTP por cada evento individual.

El `CdcDebouncer` (`dispatch/cdc-debouncer.ts`) resuelve esto acumulando eventos en una ventana de tiempo antes de enviarlos:

1. **Enqueue**: cada CDC live encola `codigo → Set<PayloadType>` en un buffer en memoria
2. **Merge**: si el mismo codigo recibe multiples CDCs, los tipos se unen (no se duplican)
3. **Flush**: al expirar el timer (`DEBOUNCE_WINDOW_MS`, default 1s) o al alcanzar el tamaño maximo (`DEBOUNCE_MAX_BUFFER_SIZE`, default 500 codigos):
   - Construye payloads desde el store (que ya tiene el estado final de cada registro)
   - Agrupa items por tipo (`supplier[]`, `contact[]`)
   - Envia un PUT por tipo/batch (particionado en lotes de `BULK_BATCH_SIZE`)
4. **Null builds**: si un builder retorna null, el codigo va al pending-buffer como antes

### Ejemplo numerico

| Escenario | Sin debounce | Con debounce (window=1s) |
|---|---|---|
| 1.000 CDCs en 3s | 1.000+ PUTs individuales | ~4 PUTs (2 flushes x 2 tipos) |
| 1 CDC aislado | 1 PUT inmediato | 1 PUT tras 1s de delay |

El delay maximo para un evento individual es `DEBOUNCE_WINDOW_MS` (1s por defecto). En escenarios de carga masiva, el ahorro es de ordenes de magnitud.

## Trigger API (bulk sync/delete)

Servidor Fastify en puerto 3001 que permite lanzar operaciones bulk de sincronizacion y borrado contra la Ingest API. Protegido con Bearer token (`TRIGGER_API_KEY`).

### Arquitectura de la Trigger API

Las rutas se generan **automaticamente** desde `ENTITY_REGISTRY` (`domain/entity-registry.ts`). Para cada entidad registrada se crean 2 rutas:
- `POST /triggers/{triggerPath}` → sync bulk
- `DELETE /triggers/{triggerPath}` → delete bulk

Los schemas OpenAPI se generan via la factory `makeTriggerSchema()` usando los metadatos swagger de cada entidad. Esto significa que al añadir una nueva entidad al registry, las rutas y la documentacion Swagger se crean automaticamente sin tocar `server.ts` ni `schemas.ts`.

Cada entidad tiene un `BulkHandler` dedicado (`bulk/handlers/`) que implementa la logica de `syncAll` y `deleteAll`. El `BulkService` es un motor generico que delega en el handler correcto segun el tipo.

### Endpoints

| Metodo | Ruta | Descripcion |
|---|---|---|
| `GET` | `/health` | Health check (sin auth) |
| `POST` | `/triggers/suppliers` | Sync bulk de suppliers |
| `DELETE` | `/triggers/suppliers` | Delete bulk de suppliers |
| `POST` | `/triggers/contacts` | Sync bulk de contacts |
| `DELETE` | `/triggers/contacts` | Delete bulk de contacts |

Todas las rutas `/triggers/*` requieren header `Authorization: Bearer <TRIGGER_API_KEY>`. Si ya hay una operacion bulk en curso, devuelve `409 Conflict`.

### Filtro por codigos (body opcional)

Los endpoints de trigger aceptan un body JSON opcional para limitar la operacion a un subconjunto de codigos de proveedor:

```json
{
  "CodSupplier": ["P001", "P002"]
}
```

| Escenario | Comportamiento |
|---|---|
| Sin body | Procesa todos los codigos del store |
| Body vacio `{}` | Procesa todos los codigos del store |
| `{ "CodSupplier": [] }` | 0 items procesados |
| `{ "CodSupplier": ["P001"] }` | Solo procesa P001 |

El campo se llama `CodSupplier` para ser consistente con el nombre usado en los payloads Supplier y SupplierContact.

**Ejemplos con curl:**

```bash
# Sync todos los suppliers (comportamiento por defecto)
curl -X POST http://localhost:3001/triggers/suppliers \
  -H "Authorization: Bearer <TRIGGER_API_KEY>"

# Sync solo codigos especificos
curl -X POST http://localhost:3001/triggers/suppliers \
  -H "Authorization: Bearer <TRIGGER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"CodSupplier": ["P001", "P002"]}'

# Delete solo un supplier concreto
curl -X DELETE http://localhost:3001/triggers/suppliers \
  -H "Authorization: Bearer <TRIGGER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"CodSupplier": ["P001"]}'
```

### Respuesta (BulkResult)

```json
{
  "operation": "sync",
  "target": "supplier",
  "totalCodsuppliers": 11234,
  "totalItems": 11200,
  "batches": 12,
  "successBatches": 12,
  "failedBatches": 0,
  "skipped": 34,
  "skippedDetails": [
    { "CodSupplier": "ZZZZ", "reason": "Not found in store (ctercero)" },
    { "CodSupplier": "P099", "reason": "Incomplete data: missing gproveed" }
  ],
  "durationMs": 8432
}
```

El campo `skippedDetails` es un array con una entrada por cada codigo que no se pudo procesar. Cada entrada indica el `CodSupplier` y el motivo concreto del skip. Los motivos posibles dependen del handler y la operacion:

| Handler | Operacion | Condicion | Reason |
|---|---|---|---|
| `SupplierBulkHandler` | sync | `ctercero` no existe en store | `"Not found in store (ctercero)"` |
| `SupplierBulkHandler` | sync | codare no aplicable | `"codare 'XXX' not applicable"` |
| `SupplierBulkHandler` | sync | `gproveed` no existe en store | `"Incomplete data: missing gproveed"` |
| `SupplierBulkHandler` | sync | builder retorna null | `"Builder returned null"` |
| `SupplierBulkHandler` | delete | `ctercero` no existe en store | `"Not found in store (ctercero)"` |
| `SupplierBulkHandler` | delete | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | sync | `ctercero` no existe en store | `"Not found in store (ctercero)"` |
| `ContactBulkHandler` | sync | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | sync | `gproveed` no existe en store | `"Incomplete data: missing gproveed"` |
| `ContactBulkHandler` | sync | sin direcciones en store | `"No addresses found (cterdire)"` |
| `ContactBulkHandler` | sync | builder retorna null | `"Builder returned null"` |
| `ContactBulkHandler` | delete | `ctercero` no existe en store | `"Not found in store (ctercero)"` |
| `ContactBulkHandler` | delete | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | delete | NIF nulo o vacio | `"Missing NIF (cif)"` |

### Swagger UI (documentacion interactiva)

La API incluye documentacion OpenAPI 3.0.3 auto-generada con `@fastify/swagger` + `@fastify/swagger-ui`. Los schemas se generan via la factory `makeTriggerSchema()` a partir de los metadatos swagger del entity-registry — cuando se añaden nuevas entidades, la documentacion se actualiza automaticamente.

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

## Store Viewer (visor web del store en memoria)

Pagina HTML interactiva para explorar el contenido del `InMemoryStore` sin necesidad de buscar en logs. Accesible en `http://localhost:3001/store`.

### Como usarlo

1. Abrir `http://localhost:3001/store`
2. Introducir el Bearer token (mismo valor de `TRIGGER_API_KEY`)
3. Click en **Connect** — se cargan las stats y las tablas son navegables
4. Seleccionar una tabla → aparece la lista de codigos
5. Click en un codigo → muestra datos de **todas las tablas** (ctercero + gproveed + cterdire + cterasoc) para ese codigo

El token se guarda en `localStorage` entre recargas (mismo patron que Swagger UI).

### Endpoints JSON

Los datos de la pagina se obtienen via endpoints JSON protegidos con Bearer token. Tambien aparecen en Swagger UI bajo el tag "Store Viewer".

| Metodo | Ruta | Descripcion |
|---|---|---|
| `GET` | `/store` | Pagina HTML (sin auth) |
| `GET` | `/store/api/stats` | Counts + memoria estimada por tabla |
| `GET` | `/store/api/tables/:table` | Lista de codigos de una tabla |
| `GET` | `/store/api/tables/:table/:codigo` | Datos de un registro (single o array segun storeKind) |
| `GET` | `/store/api/search?q=xxx` | Busqueda de codigos por substring (max 200 resultados) |

**Ejemplos con curl:**

```bash
# Stats del store
curl http://localhost:3001/store/api/stats \
  -H "Authorization: Bearer <TRIGGER_API_KEY>"

# Listar codigos de ctercero
curl http://localhost:3001/store/api/tables/ctercero \
  -H "Authorization: Bearer <TRIGGER_API_KEY>"

# Ver datos de un codigo concreto
curl http://localhost:3001/store/api/tables/ctercero/P01868 \
  -H "Authorization: Bearer <TRIGGER_API_KEY>"

# Buscar codigos
curl "http://localhost:3001/store/api/search?q=P018" \
  -H "Authorization: Bearer <TRIGGER_API_KEY>"
```

### Funcionalidades de la UI

- **Stats dashboard**: cards con contadores por tabla + total, incluyendo memoria estimada en heap
- **Explorador de tabla**: selector de tabla + lista de codigos con filtro local
- **Vista unificada por codigo**: carga ctercero + gproveed + cterdire del mismo codigo en un solo panel
- **Busqueda global**: busca substring de codigo en todas las tablas
- **JSON syntax highlighting**: tema oscuro con colores para keys, strings, numbers, booleans, nulls
- **Refresh manual**: boton para refrescar datos (sin polling automatico)

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

# Tests
npm test              # suite completa
npm run test:watch    # modo watch
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

# Debouncer: flushes
{container="informix-consumer"} | json | tag = `Debounce` | msg =~ `Flushed.*`

# Debouncer: errores de batch dispatch
{container="informix-consumer"} | json | tag = `Debounce` | level >= 50
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
| `DEBOUNCE_WINDOW_MS` | `1000` | Ventana de debounce en ms (tiempo que se acumulan CDCs antes de flush) |
| `DEBOUNCE_MAX_BUFFER_SIZE` | `500` | Numero maximo de codigos en el buffer antes de flush anticipado |
| `BULK_BATCH_SIZE` | `500` | Tamaño maximo de items por PUT (usado por debouncer y Trigger API) |

**Nota sobre LOG_LEVEL**: Con `info` solo se loguean metadatos (tabla, operacion, campos cambiados, codigo). Con `debug` se incluyen payloads completos y valores PII (nombres, NIFs, direcciones). Usar `debug` solo en desarrollo. Cambiar `LOG_LEVEL` requiere recrear el container (`docker compose up -d consumer`).

## Topics Kafka

Los topics siguen el patron `informix.informix.{tabla}` y se derivan automaticamente del `TABLE_REGISTRY`:

| Topic | Tabla Informix |
|---|---|
| `informix.informix.ctercero` | ctercero |
| `informix.informix.cterdire` | cterdire |
| `informix.informix.gproveed` | gproveed |
| `informix.informix.cterasoc` | cterasoc |

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
- **Testing**: `vitest` (184 tests, ~400ms)
- **Plataforma Docker**: `linux/amd64` (requerido por librdkafka en Apple Silicon)

## Seguridad y resiliencia

- **Auth timing-safe**: La Trigger API compara el Bearer token con `crypto.timingSafeEqual` (previene timing attacks)
- **HTTP timeout**: Todas las llamadas al Ingest API usan `AbortSignal.timeout(30_000)` — sin posibilidad de hang indefinido
- **Token refresh dedup**: Si varias llamadas concurrentes detectan token expirado, `authPromise` garantiza una sola peticion de autenticacion
- **Error body a debug**: Los bodies de error de la API se loguean solo a nivel `debug`, evitando leaks de informacion sensible en produccion
- **Shutdown con timeout**: `Promise.race` entre shutdown graceful (stopRetryLoop + debouncer.stop + server.close + consumer.disconnect) y un timeout de 10s — `debouncer.stop()` hace flush final para no perder eventos encolados
- **Schema validation**: `CodSupplier` en el body de los triggers tiene `maxItems: 10_000` y `maxLength: 50` por item (Fastify valida automaticamente)
- **Docker resource limits**: Todos los servicios tienen limites de memoria y CPU para evitar que un servicio desbocado consuma todos los recursos del host
- **Dockerfile produccion**: `npm ci --omit=dev` (sin devDependencies), `USER node` (no root)

## Proximos pasos

1. ~~Implementar `HttpDispatcher` para enviar payloads a la API REST destino~~ ✓
2. ~~Implementar servidor HTTP con Trigger API (bulk sync/delete endpoints)~~ ✓
3. ~~Documentacion Swagger/OpenAPI auto-generada para la Trigger API~~ ✓
4. ~~Tests unitarios (Tier 1 + Tier 2)~~ ✓
5. ~~Refactoring entity-registry para escalabilidad~~ ✓
6. ~~Store Viewer — visor web del InMemoryStore~~ ✓
7. Manejo de reintentos HTTP y dead letter queue
8. Filtrado por tipo de operacion si es necesario
9. Alertas en Grafana (errores sostenidos, pending buffer creciendo)
