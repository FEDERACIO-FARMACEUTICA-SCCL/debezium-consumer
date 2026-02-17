# Analisis: SQLite vs PostgreSQL para el Store

Documento de decision tecnica sobre el motor de base de datos usado como store del consumer CDC.

**Decision**: Mantener SQLite. Fecha: 2026-02-16.

---

## Contexto

El store persiste el estado CDC (registros de Informix) para que los builders puedan construir payloads sin depender de consultas en tiempo real a la base de datos origen. Actualmente usa `better-sqlite3` (API sincrona, C nativo) con un fichero local (`./data/store.db`).

### Uso actual del store

| Operacion | Frecuencia | Ejemplo |
|---|---|---|
| Write (update registro) | Alta — cada evento CDC | `store.update("ctercero", "c", null, record)` |
| Read por clave | Alta — cada flush del debouncer | `store.getSingle("ctercero", "P001")` |
| Read array por clave | Media — builders de contact/agreement | `store.getArray("gvenacuh", "P001")` |
| Scan completo | Baja — solo en bulk triggers | `store.getAllCodigos("ctercero")` |
| Offsets | Baja — uno por mensaje procesado | `store.setOffset(key, offset)` |

No hay JOINs, no hay queries complejas, no hay acceso concurrente desde multiples procesos.

---

## Comparativa

### Rendimiento

| Operacion | SQLite (fichero local) | PostgreSQL (red Docker) | Diferencia |
|---|---|---|---|
| Read simple (getSingle) | ~0.02ms | ~0.5-2ms | 25-100x mas lento |
| Write simple (update) | ~0.05ms | ~1-3ms | 20-60x mas lento |
| Batch de 500 writes | ~5ms (transaccion) | ~50-150ms | 10-30x mas lento |
| getAllCodigos (scan) | ~2ms | ~5-20ms | 5-10x mas lento |
| Rebuild completo (~80K registros) | ~4s | ~30-60s | 10-15x mas lento |

La diferencia principal es la latencia de red (loopback Docker ~0.3ms por round-trip) multiplicada por el numero de queries. Para el flujo CDC normal (pocos eventos/segundo), la diferencia seria imperceptible. Para el rebuild inicial (~80K writes) seria significativa.

### Infraestructura

| Aspecto | SQLite | PostgreSQL |
|---|---|---|
| Servicio adicional en Docker | No | Si (+100-256MB RAM) |
| Connection pool | No necesario | Si (pg-pool o similar) |
| Migraciones de schema | No (auto-create en constructor) | Si (herramienta de migraciones) |
| Secrets adicionales | Ninguno | POSTGRES_USER, PASSWORD, DB, URL |
| Startup order | Independiente | Consumer depende de PG (depends_on + healthcheck) |
| Health check | Fichero existe | Query SELECT 1 + timeout |
| Backup | `cp store.db store.db.bak` | pg_dump — mas complejo |

### Fiabilidad

| Aspecto | SQLite | PostgreSQL |
|---|---|---|
| Crash recovery | WAL mode — robusto | WAL + checkpointing — robusto |
| Puntos de fallo | Disco local unicamente | Red + proceso PG + disco |
| Conexion perdida | No aplica (fichero local) | Hay que manejar reconexiones, timeouts, pool exhaustion |
| Corrupcion de datos | Raro (fichero local) | Menos probable (proceso dedicado) |

### Impacto en el codigo

| Aspecto | Impacto |
|---|---|
| API sincrona → asincrona | `better-sqlite3` es sincrono. PostgreSQL requiere driver async (`pg`). **Todos** los metodos del store pasarian a devolver `Promise`. |
| Ficheros afectados | ~80% del proyecto: builders, handlers, debouncer, pending-buffer, message-handler, store-viewer, interfaces, tests |
| Interfaces | `PayloadBuilder.build()` y `BulkHandler.syncAll/deleteAll` cambian firma a async |
| Tests | 226 tests necesitan refactor a async/await + mocks async |
| Estimacion de esfuerzo | 2-3 semanas (refactor + tests + validacion en produccion) |

---

## Pros de PostgreSQL

1. **Queries complejas**: JOINs entre tablas, indices compuestos, queries analiticas.
2. **Acceso externo**: Otros servicios pueden leer la DB directamente sin pasar por la API HTTP.
3. **Concurrencia multi-proceso**: Multiples instancias del consumer podrian acceder al mismo store.
4. **Observabilidad**: pgAdmin, pg_stat_statements, EXPLAIN ANALYZE.
5. **Familiaridad**: Si el equipo ya gestiona PostgreSQL, la operacion es conocida.

## Contras de PostgreSQL

1. **Complejidad operativa**: Servicio adicional que mantener, monitorizar, actualizar y backupear.
2. **Latencia en rebuild**: ~80K registros pasaria de ~4s a ~30-60s sin bulk inserts optimizados.
3. **Refactor transversal**: ~80% de ficheros + 226 tests. Alto riesgo de regresiones.
4. **Nuevo punto de fallo**: Si PG cae, el consumer se para. Con SQLite eso no puede pasar.
5. **Overhead innecesario**: El store es un cache clave-valor sin queries complejas. SQLite es la herramienta optima para este patron.
6. **Desarrollo local mas pesado**: Cada developer necesita PG corriendo.

---

## Cuando reconsiderar esta decision

| Escenario | Accion |
|---|---|
| Se necesitan JOINs o queries complejas entre tablas del store | Evaluar migracion |
| Se despliegan multiples instancias del consumer en paralelo | Evaluar migracion |
| Otros servicios necesitan acceso directo al store (no via HTTP) | Evaluar migracion (o ampliar Store Viewer API) |
| Politica de empresa prohibe ficheros SQLite en produccion | Evaluar migracion |
| El store crece a millones de registros con scans frecuentes | Evaluar migracion (aunque SQLite escala bien con indices) |

---

## Conclusion

SQLite es la opcion correcta para el caso de uso actual: un store de estado CDC con operaciones simples de lectura/escritura por clave, un solo proceso, sin necesidad de acceso externo (el Store Viewer ya cubre eso via HTTP). Migrar a PostgreSQL aportaria capacidades que no se necesitan hoy, a cambio de un coste significativo en tiempo de desarrollo, complejidad operativa y riesgo de regresiones.
