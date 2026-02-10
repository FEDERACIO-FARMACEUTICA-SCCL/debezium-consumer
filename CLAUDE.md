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

- `src/index.ts` - Entry point. Carga config, crea consumer, gestiona SIGINT/SIGTERM para graceful shutdown.
- `src/config.ts` - Configuracion via variables de entorno (`KAFKA_BROKERS`, `KAFKA_GROUP_ID`, `KAFKA_TOPICS`, `KAFKA_AUTO_OFFSET_RESET`, `LOG_LEVEL`). Defaults apuntan al entorno Docker.
- `src/logger.ts` - Instancia de pino (JSON structured logging). Level viene de `LOG_LEVEL`, campo base `service: "informix-consumer"`.
- `src/consumer.ts` - Logica del consumer. Usa `@confluentinc/kafka-javascript` con API KafkaJS. Deserializa el envelope Debezium (`raw.payload ?? raw`) y procesa eventos CDC.
- `src/supplier.ts` - Construye payload `Supplier` a partir del store (ctercero + gproveed).
- `src/supplier-contact.ts` - Construye payload `SupplierContact` (ctercero + gproveed + cterdire).
- `src/pending-buffer.ts` - Buffer de reintentos para codigos con datos incompletos. Max 10K entries, evicta los mas antiguos.
- `src/types/debezium.ts` - Interfaces TypeScript: `DebeziumEvent<T>`, `DebeziumSource`, `Operation`, `OP_LABELS`.

## Detalles tecnicos importantes

### Cliente Kafka
- Se usa `@confluentinc/kafka-javascript`, NO `kafkajs`. La API es compatible pero con diferencias:
  - Import: `import { KafkaJS } from "@confluentinc/kafka-javascript"`
  - Constructor: `new KafkaJS.Kafka({ kafkaJS: { brokers: [...] } })`
  - `fromBeginning` va en el consumer config, NO en `subscribe()`
  - `subscribe()` acepta `{ topics: string[] }`, no `{ topic, fromBeginning }`

### Envelope Debezium
- Los mensajes Kafka de Debezium vienen con formato `{ schema, payload }` cuando se usa JSON sin schema registry
- El evento CDC real esta en `payload` (con `op`, `source`, `before`, `after`, `ts_ms`)
- El consumer hace `raw.payload ?? raw` para soportar ambos formatos

### Docker
- `platform: linux/amd64` es obligatorio en Apple Silicon (librdkafka es nativo)
- El compose monta `./src:/app/src:ro` + `command: npx tsx --watch` para hot-reload sin rebuild
- Se conecta a red externa `informix-debezium_default` para alcanzar `kafka:29092`
- El Dockerfile usa `USER node` (uid 1000) para no correr como root en produccion

### Logging (pino)
- Todos los logs salen como JSON estructurado via `pino`. No queda ningun `console.log` en el codigo.
- Cada log lleva un campo `tag` que permite filtrar en Grafana: `CDC`, `StoreRebuild`, `Watch`, `Supplier`, `SupplierContact`, `PendingBuffer`, `Consumer`.
- `LOG_LEVEL=info` (default): metadatos solamente (tabla, operacion, campos cambiados, codigo). No se loguean valores PII.
- `LOG_LEVEL=debug`: incluye payloads completos (Supplier/SupplierContact bodies), valores before/after de campos, y mensajes non-CDC. Solo usar en desarrollo.

### Topics
Los topics siguen el patron `{prefix}.{schema}.{table}` donde prefix=`informix` (configurado en Debezium como `topic.prefix`). No incluyen el nombre de la base de datos en el path.

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

1. Añadir cliente HTTP para enviar payloads transformados a la API destino
2. Manejo de reintentos HTTP y dead letter queue
3. Filtrado por tipo de operacion si es necesario
4. Alertas en Grafana (ej. errores sostenidos, pending buffer creciendo)
