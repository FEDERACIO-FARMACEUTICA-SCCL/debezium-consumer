# CLAUDE.md - Informix Consumer

## Que es este proyecto

Consumer Kafka en Node.js + TypeScript que lee eventos CDC de Informix via Debezium. Actualmente solo loguea los eventos; en fases futuras procesara y enviara datos a una API.

## Proyecto hermano

El stack de infraestructura (Kafka, Debezium Server, Redpanda Console) vive en `../informix-debezium/`. Este proyecto se conecta a su red Docker (`informix-debezium_default`) como red externa.

## Comandos

```bash
# Levantar con hot-reload (desarrollo)
docker compose up -d --build
docker compose logs -f

# Solo build
npm run build

# Desarrollo local (sin Docker, requiere Kafka accesible en localhost)
npm run dev
```

## Arquitectura del codigo

- `src/index.ts` - Entry point. Carga config, crea consumer, gestiona SIGINT/SIGTERM para graceful shutdown.
- `src/config.ts` - Configuracion via variables de entorno (`KAFKA_BROKERS`, `KAFKA_GROUP_ID`, `KAFKA_TOPICS`, `KAFKA_AUTO_OFFSET_RESET`, `LOG_LEVEL`). Defaults apuntan al entorno Docker.
- `src/consumer.ts` - Logica del consumer. Usa `@confluentinc/kafka-javascript` con API KafkaJS. Deserializa el envelope Debezium (`raw.payload ?? raw`) y loguea operacion + tabla + datos.
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

### Seguridad - LOG_LEVEL
- `LOG_LEVEL=info` (default): los logs solo muestran metadatos (tabla, operacion, nombres de campos cambiados, codigo). No se loguean valores PII (NIFs, nombres, direcciones, telefonos, emails).
- `LOG_LEVEL=debug`: los logs incluyen valores completos before/after y payloads JSON. Solo usar en desarrollo.

### Topics
Los topics siguen el patron `{prefix}.{schema}.{table}` donde prefix=`informix` (configurado en Debezium como `topic.prefix`). No incluyen el nombre de la base de datos en el path.

## Proximos pasos previstos

1. Transformar eventos CDC a un formato limpio para la API destino
2. Añadir cliente HTTP para enviar datos transformados a la API
3. Manejo de reintentos y dead letter queue
4. Filtrado por tipo de operacion si es necesario
