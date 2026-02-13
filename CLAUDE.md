# CLAUDE.md - Informix Consumer

## Que es este proyecto

Consumer Kafka en Node.js + TypeScript que lee eventos CDC de Informix via Debezium. Transforma eventos en payloads Supplier y SupplierContact. Incluye stack de monitoring con Grafana + Loki para visualizacion en tiempo real.

## Proyecto hermano

El stack de infraestructura (Kafka, Debezium Server, Redpanda Console) vive en `../informix-debezium/`. Este proyecto se conecta a su red Docker (`informix-debezium_default`) como red externa.

## Comandos

```bash
# Levantar todo (consumer + monitoring stack)
docker compose up -d --build

# Ver logs del consumer en terminal
docker compose logs -f consumer

# Solo build
npm run build

# Tests
npm test              # ejecutar toda la suite una vez
npm run test:watch    # modo watch (re-ejecuta al guardar)

# Desarrollo local (sin Docker, requiere Kafka accesible en localhost)
npm run dev

# Store Viewer (visor web del InMemoryStore)
open http://localhost:3001/store

# Grafana UI
open http://localhost:3000
# Dashboard pre-configurado: "Informix Consumer"
# Login: anonymous (viewer) o admin/admin

# Queries utiles en Grafana Explore:
# Todos los logs:        {container="informix-consumer"}
# Solo CDC events:       {container="informix-consumer"} | json | tag = `CDC`
# Solo errores:          {container="informix-consumer"} | json | level >= 50
# Buscar texto en logs:  {container="informix-consumer"} |= `BIOTECH`
# Payloads Supplier:     {container="informix-consumer"} | json | msg = "Supplier payload details"
# Payloads Contact:      {container="informix-consumer"} | json | msg = "SupplierContact payload details"
# Llamadas API:          {container="informix-consumer"} | json | tag = `API`
# Errores API:           {container="informix-consumer"} | json | tag = `API` | level >= 50
# Autenticaciones:       {container="informix-consumer"} | json | tag = `API` | action = `authenticate`
# Llamadas lentas:       {container="informix-consumer"} | json | tag = `API` | durationMs > 1000
# Debouncer flushes:     {container="informix-consumer"} | json | tag = `Debounce` | msg =~ `Flushed.*`
# Debouncer errores:     {container="informix-consumer"} | json | tag = `Debounce` | level >= 50
```

## Arquitectura del codigo

```
src/
  index.ts                      # Composition root: wiring de todos los modulos
  config.ts                     # Configuracion (kafka + api + http + debounce)
  logger.ts                     # initLogger() + singleton mutable

  types/
    debezium.ts                 # Interfaces Debezium: DebeziumEvent, DebeziumSource, Operation, OP_LABELS
    payloads.ts                 # Interfaces Supplier, SupplierContact, PayloadType, AnyPayload
    deletions.ts                # SupplierDeletion, SupplierContactDeletion, SkippedDetail, BulkResult

  domain/
    table-registry.ts           # Fuente unica de verdad para TABLAS: watched fields, store kinds, payload mappings
    entity-registry.ts          # Fuente unica de verdad para ENTIDADES: type, label, triggerPath, apiPath, swagger
    codare-registry.ts          # Filtro de negocio: codare → PayloadType[] (que tipos de tercero disparan cada entidad)
    store.ts                    # Clase InMemoryStore (data-driven desde table-registry, con filtrado de campos via storeFields)
    watched-fields.ts           # detectChanges() lee WATCHED_FIELDS del table-registry
    country-codes.ts            # Mapping ISO3 → ISO2 para codigos de pais

  payloads/
    payload-builder.ts          # Interface PayloadBuilder + PayloadRegistry
    payload-utils.ts            # Helpers compartidos: trimOrNull, isActive, formatDate
    supplier.ts                 # SupplierBuilder implements PayloadBuilder
    supplier-contact.ts         # SupplierContactBuilder implements PayloadBuilder

  persistence/
    snapshot-manager.ts         # Save/load/delete snapshot a disco (store + offsets + registryHash)

  kafka/
    consumer.ts                 # Infra Kafka (connect, subscribe, run, seek, OffsetTracker)
    snapshot-tracker.ts         # Maquina de estados del snapshot (con startReady y reset)
    message-handler.ts          # Orquestador eachMessage (con deteccion re-snapshot)

  dispatch/
    cdc-debouncer.ts            # Debounce + aggregation de CDCs antes de enviar a la API
    pending-buffer.ts           # Buffer de reintentos para codigos con datos incompletos
    dispatcher.ts               # Interface PayloadDispatcher + LogDispatcher + HttpDispatcher
    http-client.ts              # ApiClient con auth JWT + renovacion automatica

  bulk/
    bulk-handler.ts             # Interface BulkHandler (syncAll/deleteAll) + BulkSyncResult/BulkDeletionResult
    bulk-service.ts             # Motor generico: sync(type)/delete(type) + batching + mutex
    handlers/
      supplier-handler.ts       # SupplierBulkHandler implements BulkHandler
      contact-handler.ts        # ContactBulkHandler implements BulkHandler

  http/
    server.ts                   # Fastify server: rutas dinamicas desde ENTITY_REGISTRY + Swagger UI + health
    schemas.ts                  # makeTriggerSchema() factory + healthSchema + schemas compartidos
    store-viewer.ts             # Store Viewer: endpoints JSON + pagina HTML autocontenida
```

### Dos registries: tablas vs entidades

El proyecto tiene dos registries complementarios:

- **`domain/table-registry.ts`** — define las **tablas** del pipeline CDC: que campos monitorizar, como almacenar en el store, que payload types alimenta cada campo. Es la fuente de verdad para `store.ts`, `watched-fields.ts`, `message-handler.ts`.

- **`domain/entity-registry.ts`** — define las **entidades** de la capa API/Trigger: tipo, label para logs, ruta HTTP del trigger, endpoint de la API externa, y metadatos Swagger. Es la fuente de verdad para `server.ts`, `schemas.ts`, `dispatcher.ts`, `cdc-debouncer.ts`, `pending-buffer.ts`.

Lookups derivados del entity-registry (computados una vez al cargar modulo):
- `ENTITY_MAP`: `Map<PayloadType, EntityDefinition>`
- `ENTITY_LABELS`: `Record<string, string>` — para logging (`{ supplier: "Supplier", contact: "SupplierContact" }`)
- `ENTITY_ENDPOINTS`: `Record<string, string>` — para dispatch HTTP (`{ supplier: "/ingest-api/suppliers", ... }`)

### Codare registry (filtro de negocio por tipo de tercero)

`domain/codare-registry.ts` define que valores de `codare` (campo de `ctercero`) habilitan cada `PayloadType`. Las tablas `ctercero`, `gproveed` y `cterdire` contienen distintos tipos de terceros (proveedores, clientes, laboratorios...). Solo los codigos con un `codare` registrado generan payloads.

```typescript
CODARE_REGISTRY = [
  { codare: "PRO", payloadTypes: ["supplier", "contact"] },
  // Futuro: { codare: "LAB", payloadTypes: ["supplier", "contact", "laboratory"] },
];
```

- `getAllowedTypes(codare)` → `Set<PayloadType>` (vacio si codare no esta registrado o es null)
- Usado en dos puntos:
  1. **`message-handler.ts`** — filtra payloadTypes antes de `debouncer.enqueue()` (CDC en tiempo real)
  2. **Bulk handlers** (`supplier-handler.ts`, `contact-handler.ts`) — filtra en `syncAll`/`deleteAll` (Trigger API)
- El store almacena TODOS los registros sin filtrar (el filtro solo afecta al dispatch)
- Skip reason en bulk: `"codare 'CLI' not applicable"`

Para extender (ej: laboratorios):
1. Anadir a `CODARE_REGISTRY`: `{ codare: "LAB", payloadTypes: ["supplier", "contact", "laboratory"] }`
2. Crear entidad `laboratory` siguiendo el patron habitual (entity-registry + builder + handler)
3. **Zero cambios** en message-handler, bulk-service, debouncer, server, schemas

### Flujo de datos

1. `kafka/consumer.ts` recibe mensajes y delega a `MessageCallback`
2. `kafka/message-handler.ts` parsea el envelope Debezium, actualiza el store, consulta el snapshot tracker
3. Para eventos live CDC: detecta cambios en watched fields, calcula payload types a nivel de campo via `FIELD_TO_PAYLOADS`
4. Filtra payload types por `codare` del registro ctercero (solo codares registrados pasan — `codare-registry.ts`)
5. `dispatch/cdc-debouncer.ts` acumula `codigo → Set<PayloadType>` en una ventana de tiempo (default 1s)
6. Al hacer flush: construye payloads desde el store (que ya tiene el estado final), agrupa items por tipo y envia en batches
7. Si un builder retorna null, el codigo va al `pending-buffer` para reintentos

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

**Zero cambios** en server.ts, schemas.ts, bulk-service.ts, dispatcher.ts, debouncer.ts, pending-buffer.ts, consumer, message handler, store o watched fields.

### Como añadir una nueva tabla (sin nueva entidad)

Si solo necesitas añadir una tabla que alimenta entidades existentes (ej: una tabla que aporta datos a `supplier`):

1. Añadir `TableDefinition` a `TABLE_REGISTRY` en `domain/table-registry.ts`
2. Definir `storeFields` con los campos necesarios para los builders (optimizacion de memoria)
3. Si la FK a `ctercero` no es `codigo`, definir `keyField` (ej: `keyField: "tercer"` para `cterasoc`)
4. Todos los lookups derivados (`TABLE_MAP`, `WATCHED_FIELDS`, `FIELD_TO_PAYLOADS`, `ALL_TOPICS`) se auto-actualizan

## Tests

Suite de tests con **vitest**. **207 tests** en 15 ficheros, ~400ms. Tests colocados junto al codigo fuente como `*.test.ts` (excluidos del build de TypeScript via `tsconfig.json`).

```bash
npm test              # ejecutar toda la suite una vez
npm run test:watch    # modo watch (re-ejecuta al guardar)
```

### Configuracion

- `vitest.config.ts` en raiz: `globals: true`, `root: "src"`
- `tsconfig.json` excluye `src/**/*.test.ts` del build
- `.gitignore` incluye `coverage/`

### Tier 1 — Funciones puras (6 ficheros)

| Fichero test | Modulo bajo test | Que cubre |
|---|---|---|
| `payloads/payload-utils.test.ts` | `trimOrNull`, `isActive`, `formatDate` | Null/undefined, whitespace, coercion de tipos, epoch days, ISO strings, fechas invalidas |
| `domain/country-codes.test.ts` | `toISO2` | ISO3→ISO2, lowercase, passthrough ISO2, null/undefined, codigos desconocidos |
| `domain/watched-fields.test.ts` | `detectChanges` | CREATE/READ/UPDATE/DELETE, whitespace normalization, tabla desconocida, uppercase table |
| `kafka/snapshot-tracker.test.ts` | `SnapshotTracker` | Estado inicial, transiciones por topic, flag `last`, topics vacios, duplicados, startReady, reset |
| `domain/entity-registry.test.ts` | `ENTITY_REGISTRY`, lookups | Campos requeridos, ENTITY_MAP, ENTITY_LABELS, ENTITY_ENDPOINTS, unicidad |
| `domain/codare-registry.test.ts` | `CODARE_REGISTRY`, `getAllowedTypes` | PRO mapping, unknown codare, null/undefined, whitespace trim, case-sensitivity |

### Tier 2 — Logica de negocio (9 ficheros)

| Fichero test | Modulo bajo test | Que cubre |
|---|---|---|
| `domain/store.test.ts` | `InMemoryStore` | CRUD single/array, deduplicacion, whitespace matching, getStats, getAllCodigos, storeFields filtering, serialize/hydrate, computeRegistryHash, clear |
| `persistence/snapshot-manager.test.ts` | `saveSnapshot`, `loadSnapshot`, `deleteSnapshot` | Estructura correcta, directorio padre, hash mismatch, version mismatch, JSON corrupto |
| `payloads/supplier.test.ts` | `SupplierBuilder` | Build exitoso, datos incompletos, Status ACTIVE/INACTIVE, NIF null, trimming, StartDate |
| `payloads/supplier-contact.test.ts` | `SupplierContactBuilder` | 1 y N direcciones, datos incompletos, Country ISO3→ISO2, campos null, Status |
| `dispatch/cdc-debouncer.test.ts` | `CdcDebouncer` | Debounce timer, merge types/codigos, buffer overflow, batching, builder null→pending, dispatcher error, stop() |
| `dispatch/pending-buffer.test.ts` | `addPending`, `startRetryLoop`, `stopRetryLoop` | Retry exitoso/parcial, max retries, age eviction, capacidad maxima, anti-overlap, dispatch error |
| `bulk/bulk-service.test.ts` | `BulkService` | sync/delete generico por tipo, skippedDetails, batching, batch failure, mutex, filtro codigos |
| `bulk/handlers/supplier-handler.test.ts` | `SupplierBulkHandler` | syncAll/deleteAll: happy path, ctercero missing, gproveed missing, builder null, multiples codigos |
| `bulk/handlers/contact-handler.test.ts` | `ContactBulkHandler` | syncAll/deleteAll: happy path, ctercero/gproveed missing, sin direcciones, builder null, NIF null/empty |

### Estrategia de mocking

- **Store**: `vi.mock("../domain/store")` — se controlan retornos de `getSingle`/`getArray`/`getAllCodigos`
- **Logger**: `vi.mock("../logger")` — silencia logs, stubs vacios
- **Timers**: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` para CdcDebouncer y PendingBuffer
- **PendingBuffer**: `vi.resetModules()` + `import()` dinamico en cada test para resetear estado module-level
- **PayloadRegistry/Dispatcher/ApiClient**: mocks manuales con `vi.fn()`
- **BulkHandler**: mock manual `{ type, syncAll: vi.fn(), deleteAll: vi.fn() }` para tests del BulkService generico
- **Entity Registry**: `vi.mock("../domain/entity-registry")` con ENTITY_MAP mock para tests de BulkService
- **watched-fields.test.ts**: `vi.mock("./table-registry")` para controlar `WATCHED_FIELDS` sin depender del registry real
- **store.test.ts**: instancia `new InMemoryStore(miniRegistry)` con un registry custom (no usa el singleton global). Tests de `storeFields` usan `filteredRegistry` separado

### Como añadir tests para una nueva entidad

1. Crear `payloads/nuevo.test.ts` — testear el `PayloadBuilder`
   - Mockear `store` y `logger` igual que en `supplier.test.ts`
   - Controlar retornos de `store.getSingle`/`store.getArray` por tabla
   - Verificar: build exitoso, datos incompletos → null, campos null, transformaciones
2. Crear `bulk/handlers/nuevo-handler.test.ts` — testear el `BulkHandler`
   - Mockear `store` y `logger`
   - Crear mock de `PayloadRegistry` con builder del tipo correspondiente
   - Verificar: syncAll/deleteAll con happy path, skippedDetails por cada condicion

## Detalles tecnicos importantes

### API externa (Ingest API)
- `HttpDispatcher` envia payloads usando `ENTITY_ENDPOINTS[type]` del entity-registry para determinar la ruta
- Autenticacion JWT via `POST /ingest-api/token` con `application/x-www-form-urlencoded` (username + password)
- El `ApiClient` gestiona el ciclo de vida del token: obtiene, cachea, y renueva automaticamente 60s antes de expirar
- Si una llamada recibe 401, renueva token y reintenta UNA vez
- Deduplicacion de token refresh: si varias llamadas disparan renovacion simultanea, `authPromise` garantiza una sola peticion
- Timeout de 30s (`AbortSignal.timeout`) en todas las llamadas HTTP (auth + data)
- Los bodies de error de la API se loguean a nivel `debug` (no `info`/`error`) para evitar leaks de informacion sensible
- Env vars requeridas: `INGEST_API_BASE_URL`, `INGEST_API_USERNAME`, `INGEST_API_PASSWORD`
- Tag de logging: `"API"` — todas las llamadas HTTP quedan visibles en Grafana
- `LogDispatcher` sigue disponible en el codigo como alternativa para desarrollo sin API

### Cliente Kafka
- Se usa `@confluentinc/kafka-javascript`, NO `kafkajs`. La API es compatible pero con diferencias:
  - Import: `import { KafkaJS } from "@confluentinc/kafka-javascript"`
  - Constructor: `new KafkaJS.Kafka({ kafkaJS: { brokers: [...] } })`
  - `fromBeginning` va en el consumer config, NO en `subscribe()`
  - `subscribe()` acepta `{ topics: string[] }`, no `{ topic, fromBeginning }`

### Table Registry (fuente unica de verdad para tablas)
- `domain/table-registry.ts` define `TABLE_REGISTRY` con todas las tablas, sus store kinds, watched fields (con mapping campo→payloads), topics, `storeFields` y `keyField`
- Lookups derivados computados una vez al cargar modulo: `TABLE_MAP`, `WATCHED_FIELDS`, `FIELD_TO_PAYLOADS`, `ALL_TOPICS`
- `FIELD_TO_PAYLOADS` mapea `"tabla.campo"` → `Set<PayloadType>`, permitiendo granularidad a nivel de campo
- `storeFields` (opcional): lista de campos a conservar en el store. Los campos no listados se descartan al escribir. Motivacion: Debezium tiene un bug que impide filtrar columnas en origen — siempre envia TODAS las columnas de cada tabla Informix (que puede tener 30+ campos), pero los builders solo necesitan un subconjunto
- Si se omite `storeFields`, se conservan todos los campos (backward compatible)
- `keyField` (opcional): campo usado como clave de agrupacion en el store. Default `"codigo"`. Usar cuando la FK a `ctercero` no es `codigo` (ej: `cterasoc` usa `tercer`)
- Elimina la necesidad de hardcodear nombres de tabla en multiples ficheros

### Entity Registry (fuente unica de verdad para entidades)
- `domain/entity-registry.ts` define `ENTITY_REGISTRY` con todas las entidades y sus metadatos
- Cada entrada tiene: `type` (PayloadType), `label` (para logs), `triggerPath` (segmento URL), `apiPath` (endpoint API externa), `swagger` (summary + description para sync y delete)
- Lookups derivados: `ENTITY_MAP`, `ENTITY_LABELS`, `ENTITY_ENDPOINTS`
- Usado por: `server.ts` (rutas dinamicas), `schemas.ts` (factory), `dispatcher.ts` (endpoints), `cdc-debouncer.ts` y `pending-buffer.ts` (labels para logs), `bulk-service.ts` (apiPath para batches)

### BulkHandler y BulkService (patron Strategy para operaciones bulk)

Cada entidad implementa `BulkHandler` (`bulk/bulk-handler.ts`) con dos metodos:
- `syncAll(codigos)` → valida datos en el store, llama al builder, retorna `{ items, skippedDetails }`
- `deleteAll(codigos)` → valida datos en el store, construye deletion payloads, retorna `{ items, skippedDetails }`

`BulkService` (`bulk/bulk-service.ts`) es un motor generico:
- `registerHandler(handler)` — registra un BulkHandler por tipo
- `sync(type, codigos?)` / `delete(type, codigos?)` — delega al handler, envia batches via `ApiClient`
- Obtiene `apiPath` desde `ENTITY_MAP` del entity-registry
- Mutex: solo permite una operacion bulk a la vez (`BulkOperationInProgressError` si hay otra en curso)
- No conoce la logica de negocio de ninguna entidad — es 100% generico

### Dispatch de payloads (que se envia y cuando)
La decision de que payloads enviar se toma a nivel de **campo**, no de tabla. Cada watched field en el registry declara que payload types alimenta:

| Campo cambiado | Supplier | Contact | Se envia |
|---|---|---|---|
| `ctercero.codigo` | Si | Si | Ambos |
| `ctercero.nombre` | Si | Si | Ambos |
| `ctercero.cif` | Si | Si | Ambos |
| `gproveed.fecalt` | Si | No | Solo Supplier |
| `gproveed.fecbaj` | Si | Si | Ambos |
| `cterdire.*` | No | Si | Solo Contact |
| `cterasoc.*` | — | — | Sin watched fields (solo almacenamiento en store) |

Resumen por escenario:
- **Cambio en ctercero** → siempre Supplier + Contact (todos sus campos afectan a ambos)
- **Cambio en gproveed.fecalt** (fecha alta, sin cambio en fecbaj) → solo Supplier
- **Cambio en gproveed.fecbaj** (fecha baja) → Supplier + Contact (Status cambia en ambos)
- **Cambio en cterdire** → solo Contact (direcciones no afectan a Supplier)

### CDC Debouncer (`dispatch/cdc-debouncer.ts`)

Capa de agregacion entre el message-handler y el dispatcher. Resuelve el problema de que al re-arrancar el consumer, miles de CDCs historicos se procesan como "live" generando un PUT HTTP por cada evento.

- **`enqueue(codigo, types)`**: merge `types` en `buffer.get(codigo)` (o crea nueva entrada). Si `buffer.size >= maxBufferSize` → flush inmediato. Si no hay timer activo → inicia `setTimeout(flush, windowMs)`.
- **`flush()`**: snapshot + clear del buffer. Para cada `(codigo, types)`: `builder.build(codigo)` → acumula en `Map<PayloadType, AnyPayload[]>`. Luego despacha un PUT por tipo (particionado en batches de `batchSize`). Si un build retorna null → `addPending()`.
- **Labels de log**: usa `ENTITY_LABELS[type]` del entity-registry (no hay tagMap hardcodeado).
- **`stop()`**: cancela timer + flush final (llamado en shutdown antes de `server.close()`).
- **Anti-overlap**: flag `flushing` impide flushes concurrentes.
- **Seguridad**: el store ya tiene el estado final cuando se hace flush (se actualiza con cada evento ANTES de encolar).

Env vars:
- `DEBOUNCE_WINDOW_MS` → default `1000` (1 segundo)
- `DEBOUNCE_MAX_BUFFER_SIZE` → default `500` (flush anticipado si se acumulan tantos codigos)

Ejemplo numerico: 1.000 CDCs en 3s → deduplica a ~800 codigos → 2 flushes → **4 PUTs** (2 por tipo) en vez de 1.000+.

Tag de logging: `"Debounce"`. Queries utiles en Grafana:
```
# Flushes del debouncer
{container="informix-consumer"} | json | tag = `Debounce` | msg =~ `Flushed.*`

# Errores de batch dispatch
{container="informix-consumer"} | json | tag = `Debounce` | level >= 50
```

### Pending buffer (reintentos)
- Guarda codigos con datos incompletos para reintentar cada 2s (max 5 reintentos o 60s TTL)
- Labels de log: usa `ENTITY_LABELS[type]` del entity-registry (no hay tagMap hardcodeado)
- Anti-overlap: flag `retrying` impide que un nuevo ciclo de `setInterval` se solape con uno que aun no ha terminado (dispatch es async)
- Capacidad maxima 10.000 entradas; al llegar al limite evicta la mas antigua con `logger.warn`
- Los dispatch se hacen con `await` + try/catch; un fallo en un tipo no bloquea los demas

### Store snapshot persistence (`persistence/snapshot-manager.ts`)
- Persiste el `InMemoryStore` + offsets Kafka a disco para evitar replay completo al reiniciar
- Al arrancar, si hay un snapshot valido, hidrata el store y hace seek a los offsets guardados (~2s vs ~5min)
- Formato: JSON con `version`, `registryHash`, `timestamp`, `offsets`, `store`
- Invalidacion automatica: hash del registry no coincide, version distinta, JSON corrupto → descarta y hace rebuild completo
- Deteccion de re-snapshot: si aparecen eventos `op: "r"` despues de cargar desde snapshot → `store.clear()`, `tracker.reset()`, elimina snapshot
- `FORCE_REBUILD=true` fuerza rebuild completo (elimina snapshot y lee desde offset 0)
- Env var `SNAPSHOT_PATH` (default `./data/store-snapshot.json`)
- Docker: volumen `consumer-data` montado en `/app/data`, Dockerfile crea `/app/data` con `chown node:node`
- Tag de logging: `"Snapshot"` — visible en Grafana
- `InMemoryStore.serialize()` / `hydrate()` para serializar/hidratar datos
- `computeRegistryHash()` en `table-registry.ts` genera hash SHA-256 deterministico del registry
- `OffsetTracker` en `consumer.ts` registra el offset mas alto procesado por topic-partition
- `SnapshotTracker` acepta `startReady=true` para arrancar en modo "ready" (skip snapshot detection) y `reset()` para volver a modo rebuild

#### Tres mecanismos de save (redundancia)

El snapshot se guarda en tres momentos para garantizar persistencia:

| Mecanismo | Trigger | Funciona con `--watch`? |
|---|---|---|
| `onStoreReady` | Al completar rebuild (primer evento live) | Si |
| Periodico | Cada 5 minutos (`setInterval`) | Si |
| Shutdown | SIGTERM/SIGINT en `process.on` | Solo sin `--watch` |

`tsx --watch` (usado en dev) intercepta SIGTERM sin propagarlo al proceso Node, por lo que el handler de shutdown no se ejecuta. Los otros dos mecanismos compensan: el peor caso es reproceesar ~5 min de CDCs (idempotente). En produccion (`node dist/index.js`) los tres mecanismos funcionan.

### Shutdown graceful
- `Promise.race` entre el shutdown graceful (stopRetryLoop + debouncer.stop + persistSnapshot + server.close + consumer.disconnect) y un timeout de 10s
- `debouncer.stop()` hace un flush final para no perder eventos encolados
- `persistSnapshot()` persiste el store + offsets a disco antes de desconectar
- Si el timeout gana, se loguea el error y se sale con `exitCode = 1`
- Evita que un `consumer.disconnect()` bloqueado impida el cierre del proceso

### Payload helpers compartidos (`payloads/payload-utils.ts`)
- `trimOrNull(value)`: convierte a string, hace trim, devuelve `null` si vacio
- `isActive(fecbaj)`: `true` si `fecbaj` es null o string vacio (= proveedor activo)
- `formatDate(value)`: convierte dias-desde-epoch (Debezium) o ISO string a `YYYY-MM-DD`
- Importados por `SupplierBuilder` y `SupplierContactBuilder` — zero duplicacion

### Envelope Debezium
- Los mensajes Kafka de Debezium vienen con formato `{ schema, payload }` cuando se usa JSON sin schema registry
- El evento CDC real esta en `payload` (con `op`, `source`, `before`, `after`, `ts_ms`)
- El consumer hace `raw.payload ?? raw` para soportar ambos formatos

### Logger
- `initLogger(level)` se llama desde `index.ts` despues de cargar config
- El singleton `logger` se reasigna; funciona con CommonJS porque TypeScript compila imports como property access sobre el modulo

### Docker
- `platform: linux/amd64` es obligatorio en Apple Silicon (librdkafka es nativo)
- El compose monta `./src:/app/src:ro` + `command: npx tsx --watch` para hot-reload sin rebuild
- Se conecta a red externa `informix-debezium_default` para alcanzar `kafka:29092`
- El Dockerfile usa `USER node` (uid 1000) para no correr como root en produccion
- Produccion: `npm ci --omit=dev` (sin devDependencies)
- Resource limits en docker-compose: consumer 512M/1cpu, loki 512M/1cpu, promtail 256M/0.5cpu, grafana 256M/0.5cpu

### Logging (pino)
- Todos los logs salen como JSON estructurado via `pino`. No queda ningun `console.log` en el codigo.
- Cada log lleva un campo `tag` que permite filtrar en Grafana: `CDC`, `StoreRebuild`, `Watch`, `Supplier`, `SupplierContact`, `PendingBuffer`, `Debounce`, `Consumer`, `Dispatcher`, `BulkSync`.
- `LOG_LEVEL=info` (default): metadatos solamente (tabla, operacion, campos cambiados, codigo). No se loguean valores PII.
- `LOG_LEVEL=debug`: incluye payloads completos (Supplier/SupplierContact bodies), valores before/after de campos, y mensajes non-CDC. Solo usar en desarrollo.

### Topics
Los topics siguen el patron `{prefix}.{schema}.{table}` donde prefix=`informix` (configurado en Debezium como `topic.prefix`). No incluyen el nombre de la base de datos en el path. Los topics default se derivan automaticamente de `ALL_TOPICS` en el table registry.

### Trigger API (Fastify + Swagger)
- Servidor Fastify en puerto 3001 con rutas dinamicas generadas desde `ENTITY_REGISTRY` + health check
- Para cada entidad se crean 2 rutas: `POST /triggers/{triggerPath}` (sync) y `DELETE /triggers/{triggerPath}` (delete)
- `makeTriggerSchema()` factory en `http/schemas.ts` genera el schema OpenAPI a partir de los metadatos swagger de cada entidad
- `BulkService.sync(type, codigos?)` / `BulkService.delete(type, codigos?)` — metodos genericos que delegan en el `BulkHandler` correspondiente
- `@fastify/swagger` genera spec OpenAPI 3.0.3; `@fastify/swagger-ui` sirve documentacion interactiva en `/docs`
- Auth: Bearer token (`TRIGGER_API_KEY`) verificado en hook `onRequest`; se salta `/health` y `/docs*`
- Auth: comparacion timing-safe con `crypto.timingSafeEqual` (previene timing attacks)
- Schemas compartidos en `http/schemas.ts`: `BulkResultResponse`, `ErrorResponse`, `triggerResponses`, `TriggerBody`
- `TriggerBody.CodSupplier` tiene limites: `maxItems: 10_000` y `maxLength: 50` por item (Fastify valida automaticamente)
- `persistAuthorization: true` guarda el token en localStorage entre recargas del Swagger UI
- Orden de registro critico: swagger → swagger-ui → auth hook → rutas
- Los endpoints de trigger aceptan un body JSON opcional `{ "CodSupplier": ["P001", "P002"] }` para filtrar por codigos. Sin body se procesan todos.
- La respuesta incluye `skippedDetails: { CodSupplier, reason }[]` con el motivo concreto de cada skip

#### skippedDetails — motivos de skip por handler

Cada `BulkHandler` valida existencia en el store **antes** de llamar al builder o construir el payload de borrado. Los codigos que no pasan la validacion se reportan en `skippedDetails` con una reason especifica:

| Handler | Metodo | Condicion | Reason |
|---|---|---|---|
| `SupplierBulkHandler` | `syncAll` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `SupplierBulkHandler` | `syncAll` | codare no aplicable | `"codare 'XXX' not applicable"` |
| `SupplierBulkHandler` | `syncAll` | `gproveed` no existe | `"Incomplete data: missing gproveed"` |
| `SupplierBulkHandler` | `syncAll` | builder retorna null | `"Builder returned null"` |
| `SupplierBulkHandler` | `deleteAll` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `SupplierBulkHandler` | `deleteAll` | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | `syncAll` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `ContactBulkHandler` | `syncAll` | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | `syncAll` | `gproveed` no existe | `"Incomplete data: missing gproveed"` |
| `ContactBulkHandler` | `syncAll` | sin direcciones | `"No addresses found (cterdire)"` |
| `ContactBulkHandler` | `syncAll` | builder retorna null | `"Builder returned null"` |
| `ContactBulkHandler` | `deleteAll` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `ContactBulkHandler` | `deleteAll` | codare no aplicable | `"codare 'XXX' not applicable"` |
| `ContactBulkHandler` | `deleteAll` | NIF nulo o vacio | `"Missing NIF (cif)"` |

Ejemplo de respuesta con skips:
```json
{
  "operation": "sync",
  "target": "supplier",
  "totalCodsuppliers": 3,
  "totalItems": 2,
  "batches": 1,
  "successBatches": 1,
  "failedBatches": 0,
  "skipped": 1,
  "skippedDetails": [
    { "CodSupplier": "ZZZZ", "reason": "Not found in store (ctercero)" }
  ],
  "durationMs": 15
}
```

| URL | Metodo | Auth | Body opcional | Proposito |
|---|---|---|---|---|
| `/docs` | GET | No | — | Swagger UI interactivo |
| `/docs/json` | GET | No | — | OpenAPI spec JSON |
| `/docs/yaml` | GET | No | — | OpenAPI spec YAML |
| `/health` | GET | No | — | Health check |
| `/triggers/suppliers` | POST | Bearer | `{ CodSupplier?: string[] }` | Sync bulk de suppliers |
| `/triggers/suppliers` | DELETE | Bearer | `{ CodSupplier?: string[] }` | Delete bulk de suppliers |
| `/triggers/contacts` | POST | Bearer | `{ CodSupplier?: string[] }` | Sync bulk de contacts |
| `/triggers/contacts` | DELETE | Bearer | `{ CodSupplier?: string[] }` | Delete bulk de contacts |
| `/store` | GET | No | — | Store Viewer (pagina HTML interactiva) |
| `/store/api/stats` | GET | Bearer | — | Stats del store (counts + memoria estimada por tabla) |
| `/store/api/tables/:table` | GET | Bearer | — | Lista codigos de una tabla |
| `/store/api/tables/:table/:codigo` | GET | Bearer | — | Datos de un registro por tabla y codigo |
| `/store/api/search?q=xxx` | GET | Bearer | — | Busqueda de codigos por substring (max 200 resultados) |

Las rutas `/triggers/*` se generan automaticamente desde `ENTITY_REGISTRY`. Al añadir una nueva entidad al registry, las rutas y schemas Swagger correspondientes se crean sin modificar `server.ts` ni `schemas.ts`.

### Store Viewer (visor web del InMemoryStore)

Pagina HTML autocontenida servida en `/store` que permite explorar el contenido del `InMemoryStore` desde el navegador. Util para diagnosticar datos, verificar registros y depurar problemas sin necesidad de buscar en logs.

- **Implementacion**: `http/store-viewer.ts` — funcion `registerStoreViewer(app)` que registra la pagina HTML + 4 endpoints JSON
- **Auth**: la pagina HTML (`/store`) se sirve sin auth (igual que `/docs`). Los endpoints de datos (`/store/api/*`) requieren Bearer token
- **Token persistence**: el token se guarda en `localStorage["store-viewer-token"]` entre recargas (mismo patron que Swagger UI)
- **Swagger**: los 4 endpoints aparecen en Swagger UI bajo el tag "Store Viewer"
- **Zero dependencias extra**: HTML + CSS + JS inline, sin librerias frontend, sin ficheros estaticos

Funcionalidades de la UI:
- Stats dashboard con cards por tabla + total, incluyendo **memoria estimada** (bytes en heap V8)
- Explorador de tabla: selector + lista de codigos (con filtro local)
- Vista unificada por codigo: carga datos de **todas las tablas** (ctercero + gproveed + cterdire + cterasoc) en un solo panel
- Busqueda global: busca substring de codigo en todas las tablas (debounce 300ms en el cliente)
- JSON syntax highlighting (keys, strings, numbers, booleans, nulls) con tema oscuro
- Responsive basico (layout vertical en pantallas estrechas)

Acceso: `http://localhost:3001/store`

### Monitoring (Grafana + Loki + Promtail)

Stack de observabilidad incluido en el mismo `docker-compose.yml`:

```
consumer (pino JSON → stdout) → Promtail → Loki → Grafana (:3000)
```

- **Promtail** descubre containers Docker con label `logging=loki` y envia sus logs a Loki.
- **Loki** almacena e indexa los logs JSON. Retention: 7 dias. Schema v13 (TSDB).
- **Grafana** expone un dashboard pre-provisionado "Informix Consumer" con 5 paneles:
  1. Log stream (timeline de todos los logs, filtrable por tag)
  2. CDC events/min (rate por tabla, timeseries)
  3. Errors (logs nivel error/fatal)
  4. Store rebuild progress (stat panel)
  5. Pending buffer (retries y give-ups)

Ficheros de configuracion:
- `monitoring/loki-config.yml` - Config de Loki
- `monitoring/promtail-config.yml` - Config de Promtail (Docker SD + label filter)
- `monitoring/grafana/provisioning/datasources/loki.yml` - Datasource auto-provisionado
- `monitoring/grafana/provisioning/dashboards/dashboard.yml` - Dashboard provider
- `monitoring/grafana/dashboards/informix-consumer.json` - Dashboard JSON

Volumes Docker: `loki-data`, `grafana-data` (persistencia entre reinicios).

## Proximos pasos previstos

1. ~~Implementar `HttpDispatcher` para enviar payloads transformados a la API destino~~ ✓
2. ~~Implementar servidor HTTP con Trigger API (bulk sync/delete endpoints)~~ ✓
3. ~~Documentacion Swagger/OpenAPI auto-generada para la Trigger API~~ ✓
4. ~~Tests unitarios (Tier 1 + Tier 2)~~ ✓
5. ~~Refactoring entity-registry para escalabilidad~~ ✓
6. ~~Store Viewer — visor web del InMemoryStore~~ ✓
7. Manejo de reintentos HTTP y dead letter queue
8. Filtrado por tipo de operacion si es necesario
9. Alertas en Grafana (ej. errores sostenidos, pending buffer creciendo)
