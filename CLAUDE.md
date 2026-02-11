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

  domain/
    table-registry.ts           # Fuente unica de verdad para tablas, watched fields y payload mappings
    store.ts                    # Clase InMemoryStore (data-driven desde registry)
    watched-fields.ts           # detectChanges() lee WATCHED_FIELDS del registry
    country-codes.ts            # Mapping ISO3 → ISO2 para codigos de pais

  payloads/
    payload-builder.ts          # Interface PayloadBuilder + PayloadRegistry
    payload-utils.ts            # Helpers compartidos: trimOrNull, isActive, formatDate
    supplier.ts                 # SupplierBuilder implements PayloadBuilder
    supplier-contact.ts         # SupplierContactBuilder implements PayloadBuilder

  kafka/
    consumer.ts                 # Solo infra Kafka (connect, subscribe, run)
    snapshot-tracker.ts         # Maquina de estados del snapshot
    message-handler.ts          # Orquestador eachMessage (wires domain logic)

  dispatch/
    cdc-debouncer.ts            # Debounce + aggregation de CDCs antes de enviar a la API
    pending-buffer.ts           # Buffer de reintentos para codigos con datos incompletos
    dispatcher.ts               # Interface PayloadDispatcher + LogDispatcher + HttpDispatcher
    http-client.ts              # ApiClient con auth JWT + renovacion automatica

  http/
    server.ts                   # Fastify server: Trigger API + Swagger UI + health check
    schemas.ts                  # JSON Schemas OpenAPI para todas las rutas
```

### Flujo de datos

1. `kafka/consumer.ts` recibe mensajes y delega a `MessageCallback`
2. `kafka/message-handler.ts` parsea el envelope Debezium, actualiza el store, consulta el snapshot tracker
3. Para eventos live CDC: detecta cambios en watched fields, calcula payload types a nivel de campo via `FIELD_TO_PAYLOADS`
4. `dispatch/cdc-debouncer.ts` acumula `codigo → Set<PayloadType>` en una ventana de tiempo (default 1s)
5. Al hacer flush: construye payloads desde el store (que ya tiene el estado final), agrupa items por tipo y envia en batches
6. Si un builder retorna null, el codigo va al `pending-buffer` para reintentos

### Como añadir un nuevo payload type

1. Añadir fila en `TABLE_REGISTRY` para la nueva tabla + añadir el tipo a `feedsPayloads` de tablas existentes si aplica
2. Añadir el tipo al union `PayloadType` en `types/payloads.ts`
3. Crear `payloads/nuevo.ts` implementando `PayloadBuilder`
4. Registrar en `index.ts`: `registry.register(new NuevoBuilder())`

**Zero cambios** en consumer, message handler, pending buffer, store o watched fields.

## Tests

Suite de tests con **vitest**. 150 tests, ~500ms. Tests colocados junto al codigo fuente como `*.test.ts` (excluidos del build de TypeScript via `tsconfig.json`).

```bash
npm test              # ejecutar toda la suite una vez
npm run test:watch    # modo watch (re-ejecuta al guardar)
```

### Configuracion

- `vitest.config.ts` en raiz: `globals: true`, `root: "src"`
- `tsconfig.json` excluye `src/**/*.test.ts` del build
- `.gitignore` incluye `coverage/`

### Tier 1 — Funciones puras (4 ficheros)

| Fichero test | Modulo bajo test | Que cubre |
|---|---|---|
| `payloads/payload-utils.test.ts` | `trimOrNull`, `isActive`, `formatDate` | Null/undefined, whitespace, coercion de tipos, epoch days, ISO strings, fechas invalidas |
| `domain/country-codes.test.ts` | `toISO2` | ISO3→ISO2, lowercase, passthrough ISO2, null/undefined, codigos desconocidos |
| `domain/watched-fields.test.ts` | `detectChanges` | CREATE/READ/UPDATE/DELETE, whitespace normalization, tabla desconocida, uppercase table |
| `kafka/snapshot-tracker.test.ts` | `SnapshotTracker` | Estado inicial, transiciones por topic, flag `last`, topics vacios, duplicados |

### Tier 2 — Logica de negocio (6 ficheros)

| Fichero test | Modulo bajo test | Que cubre |
|---|---|---|
| `domain/store.test.ts` | `InMemoryStore` | CRUD single/array, deduplicacion, whitespace matching, getStats, getAllCodigos, clear |
| `payloads/supplier.test.ts` | `SupplierBuilder` | Build exitoso, datos incompletos, Status ACTIVE/INACTIVE, NIF null, trimming, StartDate |
| `payloads/supplier-contact.test.ts` | `SupplierContactBuilder` | 1 y N direcciones, datos incompletos, Country ISO3→ISO2, campos null, Status |
| `dispatch/cdc-debouncer.test.ts` | `CdcDebouncer` | Debounce timer, merge types/codigos, buffer overflow, batching, builder null→pending, dispatcher error, stop() |
| `dispatch/pending-buffer.test.ts` | `addPending`, `startRetryLoop`, `stopRetryLoop` | Retry exitoso/parcial, max retries, age eviction, capacidad maxima, anti-overlap, dispatch error |
| `bulk/bulk-service.test.ts` | `BulkService` | sync/delete suppliers/contacts, skippedDetails, batching, batch failure, mutex, filtro codigos |

### Estrategia de mocking

- **Store**: `vi.mock("../domain/store")` — se controlan retornos de `getSingle`/`getArray`/`getAllCodigos`
- **Logger**: `vi.mock("../logger")` — silencia logs, stubs vacios
- **Timers**: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` para CdcDebouncer y PendingBuffer
- **PendingBuffer**: `vi.resetModules()` + `import()` dinamico en cada test para resetear estado module-level
- **PayloadRegistry/Dispatcher/ApiClient**: mocks manuales con `vi.fn()`
- **watched-fields.test.ts**: `vi.mock("./table-registry")` para controlar `WATCHED_FIELDS` sin depender del registry real
- **store.test.ts**: instancia `new InMemoryStore(miniRegistry)` con un registry custom (no usa el singleton global)

### Como añadir tests para un nuevo payload type

1. Crear `payloads/nuevo.test.ts`
2. Mockear `store` y `logger` igual que en `supplier.test.ts`
3. Controlar retornos de `store.getSingle`/`store.getArray` por tabla
4. Verificar: build exitoso, datos incompletos → null, campos null, transformaciones

## Detalles tecnicos importantes

### API externa (Ingest API)
- `HttpDispatcher` envia payloads al endpoint `PUT /ingest-api/suppliers` (y en el futuro `/ingest-api/suppliers-contacts`)
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

### Table Registry (fuente unica de verdad)
- `domain/table-registry.ts` define `TABLE_REGISTRY` con todas las tablas, sus store kinds, watched fields (con mapping campo→payloads) y topics
- Lookups derivados computados una vez al cargar modulo: `TABLE_MAP`, `WATCHED_FIELDS`, `FIELD_TO_PAYLOADS`, `ALL_TOPICS`
- `FIELD_TO_PAYLOADS` mapea `"tabla.campo"` → `Set<PayloadType>`, permitiendo granularidad a nivel de campo
- Elimina la necesidad de hardcodear nombres de tabla en multiples ficheros

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

Resumen por escenario:
- **Cambio en ctercero** → siempre Supplier + Contact (todos sus campos afectan a ambos)
- **Cambio en gproveed.fecalt** (fecha alta, sin cambio en fecbaj) → solo Supplier
- **Cambio en gproveed.fecbaj** (fecha baja) → Supplier + Contact (Status cambia en ambos)
- **Cambio en cterdire** → solo Contact (direcciones no afectan a Supplier)

### CDC Debouncer (`dispatch/cdc-debouncer.ts`)

Capa de agregacion entre el message-handler y el dispatcher. Resuelve el problema de que al re-arrancar el consumer, miles de CDCs historicos se procesan como "live" generando un PUT HTTP por cada evento.

- **`enqueue(codigo, types)`**: merge `types` en `buffer.get(codigo)` (o crea nueva entrada). Si `buffer.size >= maxBufferSize` → flush inmediato. Si no hay timer activo → inicia `setTimeout(flush, windowMs)`.
- **`flush()`**: snapshot + clear del buffer. Para cada `(codigo, types)`: `builder.build(codigo)` → acumula en `Map<PayloadType, AnyPayload[]>`. Luego despacha un PUT por tipo (particionado en batches de `batchSize`). Si un build retorna null → `addPending()`.
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
- Guarda anti-overlap: flag `retrying` impide que un nuevo ciclo de `setInterval` se solape con uno que aun no ha terminado (dispatch es async)
- Capacidad maxima 10.000 entradas; al llegar al limite evicta la mas antigua con `logger.warn`
- Los dispatch se hacen con `await` + try/catch; un fallo en un tipo no bloquea los demas

### Shutdown graceful
- `Promise.race` entre el shutdown graceful (stopRetryLoop + debouncer.stop + server.close + consumer.disconnect) y un timeout de 10s
- `debouncer.stop()` hace un flush final para no perder eventos encolados
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
- Cada log lleva un campo `tag` que permite filtrar en Grafana: `CDC`, `StoreRebuild`, `Watch`, `Supplier`, `SupplierContact`, `PendingBuffer`, `Debounce`, `Consumer`, `Dispatcher`.
- `LOG_LEVEL=info` (default): metadatos solamente (tabla, operacion, campos cambiados, codigo). No se loguean valores PII.
- `LOG_LEVEL=debug`: incluye payloads completos (Supplier/SupplierContact bodies), valores before/after de campos, y mensajes non-CDC. Solo usar en desarrollo.

### Topics
Los topics siguen el patron `{prefix}.{schema}.{table}` donde prefix=`informix` (configurado en Debezium como `topic.prefix`). No incluyen el nombre de la base de datos en el path. Los topics default se derivan automaticamente de `ALL_TOPICS` en el table registry.

### Trigger API (Fastify + Swagger)
- Servidor Fastify en puerto 3001 con 2 recursos (`/triggers/suppliers`, `/triggers/contacts`) x 2 metodos (POST=sync, DELETE=delete) + health check
- `@fastify/swagger` genera spec OpenAPI 3.0.3; `@fastify/swagger-ui` sirve documentacion interactiva en `/docs`
- Auth: Bearer token (`TRIGGER_API_KEY`) verificado en hook `onRequest`; se salta `/health` y `/docs*`
- Auth: comparacion timing-safe con `crypto.timingSafeEqual` (previene timing attacks)
- Schemas de rutas en `http/schemas.ts`: schemas compartidos (`BulkResultResponse`, `ErrorResponse`, `triggerResponses`, `TriggerBody`) + schemas individuales por ruta
- `TriggerBody.CodSupplier` tiene limites: `maxItems: 10_000` y `maxLength: 50` por item (Fastify valida automaticamente)
- `persistAuthorization: true` guarda el token en localStorage entre recargas del Swagger UI
- Orden de registro critico: swagger → swagger-ui → auth hook → rutas
- Los endpoints de trigger aceptan un body JSON opcional `{ "CodSupplier": ["P001", "P002"] }` para filtrar por codigos. Sin body se procesan todos.
- La respuesta incluye `skippedDetails: { CodSupplier, reason }[]` con el motivo concreto de cada skip

#### skippedDetails — motivos de skip por metodo

Cada metodo bulk valida existencia en el store **antes** de llamar al builder o construir el payload de borrado. Los codigos que no pasan la validacion se reportan en `skippedDetails` con una reason especifica:

| Metodo | Condicion | Reason |
|---|---|---|
| `syncSuppliers` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `syncSuppliers` | `gproveed` no existe | `"Incomplete data: missing gproveed"` |
| `syncSuppliers` | builder retorna null | `"Builder returned null"` |
| `syncContacts` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `syncContacts` | `gproveed` no existe | `"Incomplete data: missing gproveed"` |
| `syncContacts` | sin direcciones | `"No addresses found (cterdire)"` |
| `syncContacts` | builder retorna null | `"Builder returned null"` |
| `deleteSuppliers` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `deleteContacts` | `ctercero` no existe | `"Not found in store (ctercero)"` |
| `deleteContacts` | NIF nulo o vacio | `"Missing NIF (cif)"` |

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
5. Manejo de reintentos HTTP y dead letter queue
6. Filtrado por tipo de operacion si es necesario
7. Alertas en Grafana (ej. errores sostenidos, pending buffer creciendo)
