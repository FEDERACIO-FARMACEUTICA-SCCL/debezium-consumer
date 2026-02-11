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
```

## Arquitectura del codigo

```
src/
  index.ts                      # Composition root: wiring de todos los modulos
  config.ts                     # Configuracion (kafka + http placeholder)
  logger.ts                     # initLogger() + singleton mutable

  types/
    debezium.ts                 # Interfaces Debezium: DebeziumEvent, DebeziumSource, Operation, OP_LABELS
    payloads.ts                 # Interfaces Supplier, SupplierContact, PayloadType, AnyPayload

  domain/
    table-registry.ts           # Fuente unica de verdad para tablas, watched fields y payload mappings
    store.ts                    # Clase InMemoryStore (data-driven desde registry)
    watched-fields.ts           # detectChanges() lee WATCHED_FIELDS del registry

  payloads/
    payload-builder.ts          # Interface PayloadBuilder + PayloadRegistry
    supplier.ts                 # SupplierBuilder implements PayloadBuilder
    supplier-contact.ts         # SupplierContactBuilder implements PayloadBuilder

  kafka/
    consumer.ts                 # Solo infra Kafka (connect, subscribe, run)
    snapshot-tracker.ts         # Maquina de estados del snapshot
    message-handler.ts          # Orquestador eachMessage (wires domain logic)

  dispatch/
    pending-buffer.ts           # Buffer de reintentos para codigos con datos incompletos
    dispatcher.ts               # Interface PayloadDispatcher + LogDispatcher

  http/
    server.ts                   # Placeholder para futuro servidor HTTP
```

### Flujo de datos

1. `kafka/consumer.ts` recibe mensajes y delega a `MessageCallback`
2. `kafka/message-handler.ts` parsea el envelope Debezium, actualiza el store, consulta el snapshot tracker
3. Para eventos live CDC: detecta cambios en watched fields, calcula payload types a nivel de campo via `FIELD_TO_PAYLOADS`
4. `payloads/supplier.ts` y `payloads/supplier-contact.ts` construyen payloads desde el store
5. `dispatch/dispatcher.ts` recibe el payload construido (actualmente solo loguea)
6. Si un builder retorna null, el codigo va al `pending-buffer` para reintentos

### Como añadir un nuevo payload type

1. Añadir fila en `TABLE_REGISTRY` para la nueva tabla + añadir el tipo a `feedsPayloads` de tablas existentes si aplica
2. Añadir el tipo al union `PayloadType` en `types/payloads.ts`
3. Crear `payloads/nuevo.ts` implementando `PayloadBuilder`
4. Registrar en `index.ts`: `registry.register(new NuevoBuilder())`

**Zero cambios** en consumer, message handler, pending buffer, store o watched fields.

## Detalles tecnicos importantes

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

### Logging (pino)
- Todos los logs salen como JSON estructurado via `pino`. No queda ningun `console.log` en el codigo.
- Cada log lleva un campo `tag` que permite filtrar en Grafana: `CDC`, `StoreRebuild`, `Watch`, `Supplier`, `SupplierContact`, `PendingBuffer`, `Consumer`, `Dispatcher`.
- `LOG_LEVEL=info` (default): metadatos solamente (tabla, operacion, campos cambiados, codigo). No se loguean valores PII.
- `LOG_LEVEL=debug`: incluye payloads completos (Supplier/SupplierContact bodies), valores before/after de campos, y mensajes non-CDC. Solo usar en desarrollo.

### Topics
Los topics siguen el patron `{prefix}.{schema}.{table}` donde prefix=`informix` (configurado en Debezium como `topic.prefix`). No incluyen el nombre de la base de datos en el path. Los topics default se derivan automaticamente de `ALL_TOPICS` en el table registry.

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

1. Implementar `HttpDispatcher` para enviar payloads transformados a la API destino
2. Manejo de reintentos HTTP y dead letter queue
3. Implementar servidor HTTP en `http/server.ts` (webhooks + health endpoint)
4. Filtrado por tipo de operacion si es necesario
5. Alertas en Grafana (ej. errores sostenidos, pending buffer creciendo)
