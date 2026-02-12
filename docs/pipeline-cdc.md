# Pipeline CDC: de Informix al API destino

Documento tecnico que describe el flujo completo de datos desde la base de datos Informix hasta la API REST destino, pasando por Debezium, Kafka y el consumer.

## Vision general

```
Informix DB (tablas: ctercero, gproveed, cterdire)
     |
     | CDC nativo (Change Data Capture)
     v
Debezium Server (lee el transaction log de Informix)
     |
     | Produce mensajes JSON a Kafka (1 mensaje por fila modificada)
     v
Kafka (3 topics: informix.informix.ctercero, .gproveed, .cterdire)
     |
     | Consumer lee TODOS los mensajes desde offset 0
     v
Informix Consumer (Node.js)
     |
     |-- 1. Reconstruye tablas en memoria (InMemoryStore)
     |-- 2. Detecta cambios en campos monitorizados
     |-- 3. Agrupa cambios en ventana de debounce (1s)
     |-- 4. Construye payloads JSON (Supplier / SupplierContact)
     |
     v
Ingest API (PUT /ingest-api/suppliers, PUT /ingest-api/suppliers-contacts)
```

## Agente 1: Informix DB

Base de datos relacional de IBM. Contiene las tablas maestras de proveedores:

| Tabla | Contenido | Clave |
|-------|-----------|-------|
| `ctercero` | Datos basicos del proveedor (codigo, nombre, NIF) | `codigo` |
| `gproveed` | Datos de gestion (fecha alta, fecha baja) | `codigo` |
| `cterdire` | Direcciones del proveedor (N por proveedor) | `codigo` (FK) |

Informix tiene soporte nativo de CDC: registra cada INSERT, UPDATE y DELETE en su transaction log. Debezium lee este log para capturar los cambios.

## Agente 2: Debezium Server

Debezium Server es un proceso standalone (no requiere Kafka Connect) que se conecta directamente al transaction log de Informix. Vive en el proyecto hermano `../informix-debezium/`.

### Que hace

1. **Snapshot inicial**: la primera vez que arranca, lee **todas las filas existentes** de las 3 tablas monitorizadas y las envia a Kafka como eventos de tipo `r` (read/snapshot). Si `ctercero` tiene 11.000 registros, genera 11.000 mensajes.

2. **Streaming continuo**: despues del snapshot, se queda escuchando el transaction log. Cada INSERT, UPDATE o DELETE en las tablas monitorizadas genera un mensaje Kafka en tiempo real.

### Formato del mensaje

Cada mensaje es un JSON con envelope `{ schema, payload }`. El `payload` contiene:

```json
{
  "before": null,
  "after": { "codigo": "P01868", "nombre": "Proveedor Demo S.A.", "cif": "A12345678" },
  "source": {
    "table": "ctercero",
    "db": "testdb",
    "snapshot": "true"
  },
  "op": "r",
  "ts_ms": 1770626302328
}
```

| Campo | Descripcion |
|-------|-------------|
| `op` | Tipo de operacion: `r` (snapshot), `c` (INSERT), `u` (UPDATE), `d` (DELETE) |
| `before` | Estado anterior de la fila (null en INSERT y snapshot) |
| `after` | Estado nuevo de la fila (null en DELETE) |
| `source.table` | Nombre de la tabla origen |
| `source.snapshot` | `"true"` durante el snapshot, `"last"` en el ultimo registro del snapshot, `"false"` en CDC live |

### Topics Kafka

Debezium crea un topic por tabla con el patron `{prefix}.{schema}.{tabla}`:

| Topic | Tabla |
|-------|-------|
| `informix.informix.ctercero` | ctercero |
| `informix.informix.gproveed` | gproveed |
| `informix.informix.cterdire` | cterdire |

El prefix `informix` se configura en Debezium como `topic.prefix`.

### Particularidades de Informix

- Los campos `CHAR` vienen con padding de espacios a la derecha (ej: `"P01868     "`). El consumer hace `trim()` en claves y valores.
- Las fechas se serializan como **dias desde epoch** (entero), no como ISO string. El consumer convierte `19123` a `2023-05-10`.

## Agente 3: Kafka

Kafka actua como broker de mensajes con **log compaction** activado en los 3 topics. En vez de acumular mensajes indefinidamente, Kafka conserva **solo el ultimo mensaje por clave** (primary key de la fila). Esto mantiene el volumen acotado independientemente del tiempo que lleve el sistema en marcha.

### Log compaction y por que importa

Los topics tienen `cleanup.policy=compact` y Debezium usa el primary key de cada fila como clave del mensaje. Esto significa que si un proveedor P01868 recibe 200 UPDATEs en 5 anos, Kafka conserva solo el ultimo — no los 200. El volumen total se mantiene proporcional al numero de registros en las tablas, no al numero de cambios historicos.

El consumer lee desde offset 0 **cada vez que arranca** (usa un group ID efimero). Gracias a la compactacion, el numero de mensajes a leer se mantiene estable:

1. Lee los ~11.000 mensajes de `ctercero` (ultimo estado de cada registro)
2. Lee los ~7.000 mensajes de `gproveed`
3. Lee los mensajes de `cterdire`
4. Lee CDCs recientes que aun no hayan sido compactados
5. Queda escuchando CDCs en tiempo real

El resultado: el consumer siempre reconstruye una copia exacta de las tablas en memoria, y el tiempo de arranque se mantiene en segundos independientemente de la antiguedad del sistema.

### Group ID efimero

```typescript
const ephemeralGroupId = `${config.kafka.groupId}-${Date.now()}`;
```

Se genera un group ID unico por arranque (ej: `informix-consumer-1770626302328`). Esto garantiza que siempre lea desde el principio, sin depender de offsets guardados. No hace auto-commit.

## Agente 4: El Consumer

### Fase 1 — Reconstruccion del store (snapshot replay)

Al arrancar, el consumer lee todos los mensajes de Kafka y reconstruye las tablas en un **InMemoryStore**:

```
Kafka (historico completo)              InMemoryStore
+-------------------------------+       +----------------------------+
| op:r  ctercero  codigo=P001  | ----> | singleStore["ctercero"]    |
| op:r  ctercero  codigo=P002  | ----> |   .set("P001", {...})      |
| ...                          |       |   .set("P002", {...})      |
| op:r  gproveed  codigo=P001  | ----> | singleStore["gproveed"]    |
| ...                          |       |   .set("P001", {...})      |
| op:r  cterdire  codigo=P001  | ----> | arrayStore["cterdire"]     |
| op:r  cterdire  codigo=P001  | ----> |   .get("P001").push({...}) |
| ...                          |       +----------------------------+
| op:u  ctercero  codigo=P001  | ----> | sobreescribe P001          |
+-------------------------------+       +----------------------------+
```

El store tiene dos tipos de almacenamiento:

| Tipo | Tablas | Estructura | Semantica |
|------|--------|-----------|-----------|
| `single` | ctercero, gproveed | `Map<codigo, Record>` | 1 registro por codigo |
| `array` | cterdire | `Map<codigo, Record[]>` | N registros por codigo |

Cada mensaje (snapshot o CDC) **siempre** actualiza el store, independientemente de la fase.

#### SnapshotTracker: como sabe cuando termina el snapshot

El `SnapshotTracker` es una maquina de estados que detecta la transicion de snapshot a CDC live:

1. Mientras `source.snapshot === "true"` y `op === "r"` → estamos en fase de snapshot. Solo se actualiza el store, no se procesan cambios.
2. Cuando llega `source.snapshot === "last"` → marca todos los topics como completados.
3. Alternativamente, si llega un evento con `op !== "r"` para un topic que aun no se marco como done, se marca ese topic.
4. Cuando todos los topics estan marcados → `ready = true`. A partir de aqui, los eventos se procesan como CDC live.

Durante el replay, cada 1.000 eventos se loguea el progreso:
```
Store rebuild progress { ctercero: 5200, gproveed: 3100, cterdire: 8400 }
```

### Fase 2 — Procesamiento CDC en tiempo real

Una vez completado el replay, cada nuevo mensaje Kafka pasa por este pipeline:

```
Mensaje Kafka
  |
  v
(1) Parsear envelope Debezium (extraer payload de {schema, payload})
  |
  v
(2) Actualizar store (siempre, para mantener la copia en memoria actualizada)
  |
  v
(3) SnapshotTracker: es evento live? --> No: parar aqui
  |                                      Si: continuar
  v
(4) detectChanges(): algun campo monitorizado cambio?
  |   Compara before vs after para los campos de WATCHED_FIELDS
  |   --> No cambios relevantes: parar aqui
  |   --> Si: lista de campos cambiados
  v
(5) FIELD_TO_PAYLOADS: para cada campo cambiado, que payloads afecta?
  |   Ejemplo: campo "ctercero.nombre" → {supplier, contact}
  |            campo "gproveed.fecalt" → {supplier}
  |   Resultado: Set<PayloadType> con la union de todos
  v
(6) CdcDebouncer.enqueue(codigo, payloadTypes)
```

#### Campos monitorizados y que payloads afectan

La decision de **que payloads construir** se toma a nivel de **campo**, no de tabla. Definido en `domain/table-registry.ts`:

| Campo | Supplier | Contact |
|-------|----------|---------|
| `ctercero.codigo` | Si | Si |
| `ctercero.nombre` | Si | Si |
| `ctercero.cif` | Si | Si |
| `gproveed.fecalt` | Si | No |
| `gproveed.fecbaj` | Si | Si |
| `cterdire.direcc` | No | Si |
| `cterdire.poblac` | No | Si |
| `cterdire.codnac` | No | Si |
| `cterdire.codpos` | No | Si |
| `cterdire.telef1` | No | Si |
| `cterdire.email` | No | Si |

Ejemplo: si cambia `gproveed.fecalt` (fecha alta), solo se reconstruye el payload Supplier. Si cambia `gproveed.fecbaj` (fecha baja), se reconstruyen ambos porque `fecbaj` determina el Status en los dos payloads.

### Fase 3 — Debounce y dispatch

El `CdcDebouncer` resuelve un problema critico: al re-arrancar el consumer, los CDCs historicos post-snapshot se procesan como "live". Sin debounce, cada evento generaria un PUT HTTP individual.

#### Como funciona

```
CDC: P001 → {supplier, contact}     ─┐
CDC: P002 → {supplier}              ─┤  Buffer: Map<codigo, Set<PayloadType>>
CDC: P001 → {contact}     (merge!)  ─┤  P001 → {supplier, contact}
CDC: P003 → {supplier, contact}     ─┘  P002 → {supplier}
                                        P003 → {supplier, contact}
        |
        | Timer expira (1s) o buffer lleno (500 codigos)
        v
flush():
  1. Snapshot del buffer + clear
  2. Para cada (codigo, types):
     - builder.build(codigo) → lee del store (estado final!)
     - Si build OK → acumula en Map<PayloadType, items[]>
     - Si build null → addPending(codigo, type)
  3. Para cada tipo: PUT en batches de 500 items
```

Puntos clave:
- El **store ya tiene el estado final** cuando se hace flush (se actualiza con cada evento ANTES de encolar en el debouncer).
- Si el mismo codigo recibe 5 CDCs en 1 segundo, solo se construye **1 payload** con los datos mas recientes.
- Resultado numerico: 1.000 CDCs en 3s → ~800 codigos unicos → 2 flushes → **4 PUTs** (2 por tipo) en vez de 1.000+.

### Fase 4 — Construccion de payloads

Los builders (`SupplierBuilder`, `SupplierContactBuilder`) leen del store y cruzan datos:

**Supplier** (1 registro por codigo):
```
ctercero[codigo] + gproveed[codigo] → Supplier payload
```
```json
{
  "CodSupplier": "P01868",
  "Supplier": "Proveedor Demo S.A.",
  "NIF": "A12345678",
  "StartDate": "2023-05-10",
  "Status": "ACTIVE"
}
```

**SupplierContact** (N registros por codigo, uno por direccion):
```
ctercero[codigo] + gproveed[codigo] + cterdire[codigo][] → SupplierContact[] payloads
```
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

Si faltan datos (ej: llega un evento de `cterdire` pero `ctercero` aun no se ha cargado), el builder retorna `null` y el codigo va al **pending buffer** para reintento (cada 2s, max 5 reintentos o 60s).

### Fase 5 — Envio a la API destino

El `HttpDispatcher` envia los payloads agrupados via `PUT`:

| Payload type | Endpoint | Metodo |
|-------------|----------|--------|
| supplier | `/ingest-api/suppliers` | PUT |
| contact | `/ingest-api/suppliers-contacts` | PUT |

El `ApiClient` gestiona la autenticacion JWT:
1. Obtiene token via `POST /ingest-api/token` (username + password, `application/x-www-form-urlencoded`)
2. Cachea el token y lo renueva automaticamente 60s antes de expirar
3. Si recibe 401, renueva token y reintenta UNA vez
4. Todas las llamadas tienen timeout de 30s

Los payloads se envian como arrays (batch). El tamaño del batch es configurable (`BULK_BATCH_SIZE`, default 500 items).

## Ciclo de vida completo (ejemplo)

### Arranque del consumer

```
t=0s    Consumer arranca. Group ID efimero: informix-consumer-1707836400000
t=0.1s  Conecta a Kafka, subscribe a 3 topics
t=0.2s  Empieza a leer desde offset 0

        --- FASE SNAPSHOT (SnapshotTracker.ready = false) ---

t=0.2s  Lee snapshot ctercero (op: "r") → store.update() x 11.000
t=1.5s  Lee snapshot gproveed (op: "r") → store.update() x 7.000
t=2.0s  Lee snapshot cterdire (op: "r") → store.update() x 25.000
t=2.1s  Recibe snapshot "last" → SnapshotTracker marca todos los topics como done

        Log: "Store rebuild complete { ctercero: 11000, gproveed: 7000, cterdire: 25000 }"
        Log: "Events replayed: 43000"

        --- FASE CDC REPLAY (CDCs historicos post-snapshot) ---

t=2.1s  Lee CDCs pendientes en Kafka (acumulados desde el ultimo arranque)
        Cada CDC: store.update() + detectChanges() + debouncer.enqueue()
t=2.5s  400 codigos en buffer → debouncer.flush()
        Construye payloads desde el store → PUT /suppliers (batch 1)
                                           → PUT /suppliers-contacts (batch 1)
t=3.0s  200 codigos mas → debouncer.flush()
        → PUT /suppliers (batch 2), PUT /suppliers-contacts (batch 2)

        --- FASE LIVE (escucha en tiempo real) ---

t=3.1s  Consumer queda escuchando. Buffer vacio. Timer inactivo.
```

### Cambio en tiempo real

```
t=100s  Usuario modifica nombre de P01868 en Informix
t=100.01s  Debezium detecta el UPDATE en el transaction log
t=100.02s  Mensaje llega a Kafka topic informix.informix.ctercero:
           { op: "u", before: { codigo: "P01868", nombre: "OLD" },
                      after:  { codigo: "P01868", nombre: "NEW" } }

t=100.05s  Consumer recibe el mensaje:
           1. store.update("ctercero", "u", before, after) → actualiza P01868
           2. SnapshotTracker: ready=true, op="u" → es live
           3. detectChanges(): campo "nombre" cambio
           4. FIELD_TO_PAYLOADS["ctercero.nombre"] → {supplier, contact}
           5. debouncer.enqueue("P01868", {supplier, contact})

t=101.05s  Timer de 1s expira → debouncer.flush():
           - SupplierBuilder.build("P01868") → lee store → payload OK
           - SupplierContactBuilder.build("P01868") → lee store → payload OK
           - PUT /ingest-api/suppliers [{...P01868...}]
           - PUT /ingest-api/suppliers-contacts [{...P01868...}]
```

## Donde se guardan los datos

| Componente | Almacenamiento | Persistencia | Contenido |
|-----------|---------------|-------------|-----------|
| Informix | Disco (DB relacional) | Permanente | Tablas maestras originales |
| Kafka | Disco (segments) | Configurable (retencion larga) | Todos los eventos CDC + snapshots |
| InMemoryStore | RAM del consumer | Volatil (se reconstruye al arrancar) | Copia de las 3 tablas |
| Ingest API | Depende del destino | Permanente | Payloads procesados |

**Punto clave**: el consumer NO tiene persistencia propia. Si se reinicia, reconstruye todo desde Kafka. Kafka es la fuente de verdad del historico.

## Resumen de tiempos tipicos

| Evento | Latencia |
|--------|---------|
| Cambio en Informix → mensaje en Kafka | ~100ms (Debezium polling) |
| Mensaje en Kafka → store actualizado | <10ms |
| Store actualizado → flush del debouncer | 1s (configurable) |
| Flush → PUT a la API | ~50-200ms (depende de la red y batch size) |
| **Total end-to-end** | **~1.5s** |
| Arranque completo (rebuild de ~40K registros) | **~2-3s** |

## Preguntas frecuentes

### Se pierden los datos del consumer al parar el contenedor?

**Si.** El `InMemoryStore` vive en RAM (son `Map` de JavaScript). Al parar el contenedor se pierde todo. No hay persistencia a disco. Pero no es un problema: al volver a arrancar, el consumer reconstruye todo el store leyendo el historico de Kafka (ver siguiente pregunta).

### Al arrancar se reconstruyen las tablas en su estado real?

**Si.** El consumer usa un group ID efimero y lee desde offset 0 con `fromBeginning: true`. Recorre todo el historico de Kafka:

1. Primero procesa los mensajes del snapshot de Debezium (la foto completa de cada tabla)
2. Luego aplica todos los CDCs posteriores (INSERT, UPDATE, DELETE) en orden

Al terminar, el store tiene una copia exacta del estado actual de las tablas en Informix. Es como hacer un `SELECT *` pero reconstruido desde el stream de eventos.

### Al arrancar se vuelven a enviar datos a la API?

**Parcialmente.** El `SnapshotTracker` distingue dos fases:

- **Fase replay** (`ready = false`): los mensajes del snapshot original (op: `r`) solo actualizan el store. **No se envian payloads a la API.**
- **Fase live** (`ready = true`): se activa cuando se detecta que el snapshot ha terminado.

El matiz: los CDCs que llegaron *despues* del snapshot de Debezium se reprocesan como "live" porque ya no llevan `op: "r"`. Esto significa que **si se re-envian payloads a la API para esos CDCs historicos**. El debouncer mitiga el impacto (1.000 CDCs pendientes se reducen a unos pocos PUTs agrupados), y como son PUTs idempotentes (sobreescriben), no causan duplicados funcionales.

En la practica: si el consumer estuvo parado 5 minutos y hubo 50 cambios, al arrancar se enviaran esos 50 cambios agrupados a la API.

### Si el proyecto escala a muchas tablas, necesitara mucha RAM?

**Depende del volumen, pero si, es el limite principal.** El store guarda todos los registros de todas las tablas en memoria. Estimacion orientativa:

| Registros totales | RAM estimada del store |
|---|---|
| 40K (actual) | ~20-50 MB |
| 500K | ~200-500 MB |
| 5M | ~2-5 GB |

El container tiene un limite de 512 MB en docker-compose. Si el volumen crece significativamente habria que subir ese limite o valorar un almacenamiento con persistencia a disco (SQLite, Redis), aunque eso seria un cambio arquitectonico importante. Con el volumen actual no es un problema.

### Que pasa si Kafka se cae?

El consumer pierde la conexion y se detiene. Al volver Kafka, hay que reiniciar el consumer. Como lee desde offset 0, reconstruye todo el estado sin perdida de datos. No se pierde ningun evento siempre que Kafka tenga retencion suficiente para conservar el historico.

### Que pasa si la API destino no esta disponible?

Los PUTs fallan y se loguean como error. Los datos **no se pierden del store** (siguen en memoria). Hay dos mecanismos de recuperacion:

- **Pending buffer**: si un payload no se pudo construir por datos incompletos, se reintenta automaticamente cada 2s (max 5 reintentos).
- **Trigger API manual**: se puede lanzar un sync bulk desde `/triggers/suppliers` o `/triggers/contacts` en cualquier momento para reenviar todos los datos del store a la API.

Sin embargo, si la API esta caida durante un CDC live y el payload se construyo bien pero el PUT fallo, ese evento concreto **no se reintenta automaticamente**. Para esos casos, el trigger manual es la solucion.

### Que pasa si Debezium se cae?

Mientras Debezium esta caido, los cambios en Informix se siguen registrando en el transaction log de la base de datos. Cuando Debezium vuelve a arrancar, lee los cambios pendientes del log y los envia a Kafka. No se pierden eventos siempre que el transaction log de Informix no se haya purgado durante la caida.

### Puede haber datos desincronizados entre Informix y el consumer?

En condiciones normales, no. El store se actualiza con cada evento en orden. Los unicos escenarios de desincronizacion temporal son:

- **Consumer recien arrancado**: durante los 2-3 segundos que tarda el rebuild, el store esta incompleto.
- **Debezium con retraso**: si Debezium tarda en procesar el transaction log (carga alta), los datos del store pueden tener un desfase de segundos.
- **Consumer parado**: mientras el consumer esta caido, el store no existe. Al arrancar se pone al dia.

En todos los casos, la desincronizacion es temporal y se resuelve sola.

### Se pueden monitorizar los datos del consumer sin mirar logs?

Si. El consumer ofrece dos herramientas web en el puerto 3001:

- **Store Viewer** (`http://localhost:3001/store`): pagina interactiva para explorar las tablas y registros del store. Permite buscar codigos, ver datos JSON formateados y consultar stats.
- **Swagger UI** (`http://localhost:3001/docs`): documentacion interactiva de la Trigger API. Permite lanzar syncs y deletes desde el navegador.

Ademas, Grafana (`http://localhost:3000`) muestra logs en tiempo real, rates de eventos CDC, errores y estado del pending buffer.

### Se puede forzar un reenvio completo de todos los datos a la API?

Si. La Trigger API permite lanzar operaciones bulk:

```bash
# Reenviar todos los suppliers
curl -X POST http://localhost:3001/triggers/suppliers \
  -H "Authorization: Bearer <TOKEN>"

# Reenviar todos los contacts
curl -X POST http://localhost:3001/triggers/contacts \
  -H "Authorization: Bearer <TOKEN>"
```

Esto lee todos los codigos del store, construye payloads y los envia en batches a la API. Util despues de una caida prolongada de la API destino o para sincronizaciones puntuales.

### Cuantas veces se conecta el consumer a Informix?

**Cero.** El consumer no tiene conexion a Informix. Todos los datos llegan a traves de Kafka. Debezium es el unico componente que se conecta a la base de datos.

### Que hay que hacer al cambiar de servidor Informix (ej: de local a produccion)?

**Borrar todos los topics de Kafka y partir de cero.** Los mensajes existentes (snapshot + CDCs) pertenecen al servidor antiguo y no son validos para el nuevo. Si no se borran, el consumer mezclaria datos de ambos servidores.

Procedimiento:

1. **Parar Debezium** (para que deje de escribir en Kafka)
2. **Borrar los topics de Kafka**:
   ```bash
   kafka-topics --bootstrap-server kafka:29092 --delete --topic informix.informix.ctercero
   kafka-topics --bootstrap-server kafka:29092 --delete --topic informix.informix.gproveed
   kafka-topics --bootstrap-server kafka:29092 --delete --topic informix.informix.cterdire
   ```
   Tambien se puede hacer desde la UI de Redpanda Console si esta disponible.
3. **Reconfigurar Debezium** para apuntar al nuevo servidor Informix
4. **Arrancar Debezium** — hara un snapshot completo de las tablas del servidor real y recreara los topics automaticamente
5. **Reiniciar el consumer** — reconstruira el store con los datos del nuevo servidor

Si no se borran los topics, el consumer leeria primero el snapshot del servidor local (datos obsoletos) y luego el del servidor real (que sobreescribiria). Podria funcionar por casualidad, pero es fragil: los CDCs del servidor antiguo seguirian en Kafka mezclados con los nuevos, y codigos que existian en local pero no en produccion quedarian como fantasmas en el store.

---

## Reenvio de CDCs al reiniciar: problema y solucion propuesta

### El problema

Cada vez que el consumer arranca, lee todo el historico de Kafka desde offset 0 para reconstruir el store en memoria. Esto es necesario porque el store vive en RAM y no se persiste a disco.

El efecto secundario: los CDCs que ya se procesaron y enviaron a la API en la ejecucion anterior **se vuelven a enviar**. El SnapshotTracker suprime los mensajes de snapshot (op: `r`), pero los CDCs posteriores (op: `c`, `u`, `d`) se reprocesan como "live" porque no hay forma de distinguirlos de CDCs nuevos.

El debouncer agrupa los re-envios (1.000 CDCs → ~4 PUTs), y como son PUTs idempotentes la API los tolera sin problemas. Pero generan trafico innecesario.

### Por que no basta con "marcar como procesado" en Kafka

Kafka tiene un mecanismo nativo para esto: **consumer offsets**. Un consumer puede hacer commit del offset despues de procesar un mensaje, y Kafka recuerda la posicion por grupo. Al reiniciar, el consumer retoma donde lo dejo.

El problema: si el consumer retoma desde el offset 45.000, **no lee los 43.000 mensajes del snapshot**. El store arranca vacio y no puede construir payloads.

Es decir: offsets persistentes sin store persistente no funciona. El consumer necesita leer desde offset 0 para reconstruir la memoria.

### Solucion propuesta: offsets como watermark

La idea es **combinar ambas cosas**: leer desde offset 0 (para reconstruir el store) pero usar los offsets de Kafka como marca de agua para saber que CDCs ya se despacharon.

```
Arranque:
  1. Group ID fijo: "informix-consumer" (no efimero)
  2. Consultar a Kafka: "ultimo offset committed?" → 44500
  3. Seek a offset 0 → leer TODO desde el principio (como ahora)
  4. Para cada mensaje:
     - SIEMPRE actualizar el store (reconstruccion, como ahora)
     - Si offset <= 44500 → NO despachar (ya se envio en la ejecucion anterior)
     - Si offset > 44500 → despachar normalmente
  5. Tras cada flush exitoso del debouncer → commit del offset mas alto despachado
```

El flujo visual:

```
Kafka (historico completo)
+------------------------------------------+
| offset 0-43000: snapshot (op: "r")       |  → Solo store (como ahora)
| offset 43001-44500: CDCs ya procesados   |  → Solo store (NUEVO: se saltan)
| offset 44501+: CDCs nuevos               |  → Store + debouncer + API
+------------------------------------------+
                                     ^
                          watermark = 44500
                    (guardado por Kafka en el grupo)
```

### Que cambiaria en el codigo

| Fichero | Cambio |
|---------|--------|
| `kafka/consumer.ts` | Group ID fijo (no efimero). Al arrancar: `committed()` para obtener el watermark, luego `seek(0)` para leer desde el principio. Exponer `commitOffsets()` |
| `kafka/message-handler.ts` | Recibir el offset de cada mensaje. Si `offset <= watermark` → actualizar store pero **no** encolar en el debouncer |
| `dispatch/cdc-debouncer.ts` | Tras cada flush exitoso, llamar a `commitOffsets()` con el offset mas alto del batch despachado |

**Ficheros no afectados**: store.ts, table-registry.ts, entity-registry.ts, builders, bulk handlers, server.ts, schemas.ts, tests existentes.

### Ventajas

- **Zero dependencias nuevas**: Kafka ya gestiona offsets internamente, no se necesita fichero, Redis ni base de datos
- **Store sigue en RAM**: se reconstruye leyendo desde offset 0, exactamente como ahora
- **No pierde eventos**: los CDCs que ocurrieron mientras el consumer estaba parado tienen offset > watermark y se despachan
- **Seguro ante fallos**: si los offsets se pierden (grupo expirado, Kafka reinstalado), el consumer vuelve al comportamiento actual — re-envia todo, que es seguro porque son PUTs idempotentes
- **Cambio acotado**: ~3 ficheros modificados, sin cambio arquitectonico

### Inconvenientes y edge cases

- **Expiracion de offsets**: Kafka expira los offsets de grupos inactivos tras `offsets.retention.minutes` (default 7 dias). Si el consumer esta parado mas de 7 dias, pierde el watermark y re-envia todo al arrancar. Es seguro pero genera trafico extra.
- **Offsets por particion**: el watermark no es un solo numero — hay un offset por topic-partition. Hay que gestionar el map `topic:partition → offset` correctamente.
- **Commit despues del dispatch**: el commit debe hacerse **despues** de que el PUT a la API tenga exito, no antes. Si se commitea antes y el PUT falla, ese CDC se pierde (no se reintentaria al siguiente arranque).
- **Rebalance de Kafka**: si las particiones cambian (raro en este proyecto), los offsets pueden quedar desalineados. El fallback seguro es re-enviar todo.

### Por que no borrar los mensajes de Kafka despues de procesarlos?

Es una pregunta logica: si el problema es que los CDCs se reprocesan al arrancar, por que no eliminarlos de Kafka una vez enviados a la API?

**Kafka no permite borrar mensajes individuales.** A diferencia de una cola de mensajes tradicional (RabbitMQ, SQS), los mensajes en Kafka viven en "segments" en disco y se borran por retencion temporal (ej: 7 dias) o por tamano, nunca de forma selectiva. No existe una operacion "borrar el mensaje con offset 44501".

Pero aunque se pudiera, **romperia la reconstruccion del store**. El consumer necesita todo el historico para arrancar:

```
Si se borran los mensajes procesados:

Kafka (despues de borrar)           InMemoryStore al arrancar
+-------------------------------+   +---------------------------+
| (vacio — todo procesado)      |   | ctercero: 0 registros     |
|                               |   | gproveed: 0 registros     |
+-------------------------------+   | cterdire: 0 registros     |
                                    +---------------------------+
                                    → Store vacio, nada funciona
```

Incluso si solo se borran los CDCs y se conserva el snapshot, se pierde informacion:

1. Snapshot dice: `P01868.nombre = "Nombre Original"`
2. CDC (borrado): `UPDATE P01868.nombre = "Nombre Nuevo"`
3. Al arrancar: el store tiene `"Nombre Original"` en vez de `"Nombre Nuevo"`

El estado final de un registro es el resultado de aplicar **todos** los eventos en orden: snapshot + todos los CDCs. Borrar cualquiera rompe la cadena.

| Enfoque | Funciona? | Por que |
|---|---|---|
| Borrar mensajes individuales | No es posible | Kafka no soporta borrado individual |
| Compaction por clave | No vale aqui | Borraria el snapshot y CDCs antiguos necesarios para el rebuild |
| Borrar solo CDCs ya procesados | Rompe datos | El store se reconstruiria con estado incompleto |
| Reducir retencion | Peligroso | Si la retencion es menor que el tiempo entre reinicios, se pierde el snapshot |

Por eso la solucion correcta es el **watermark de offsets**: dejar los mensajes intactos en Kafka pero marcarlos logicamente como ya despachados.

### Estado actual y recomendacion

Actualmente el consumer usa group ID efimero y no commitea offsets. Esto es deliberado: prioriza **simplicidad y fiabilidad** sobre eficiencia. El trafico redundante al reiniciar es el coste aceptado.

La solucion del watermark es la mejora recomendada si en algun momento:
- La API destino tiene rate limiting o no tolera bien el trafico extra
- Los reinicios del consumer son frecuentes (deploys, actualizaciones)
- El volumen de CDCs acumulados crece y los re-envios tardan demasiado

Con el volumen actual (~40K registros, reinicios poco frecuentes), el comportamiento actual es suficiente.

---

## Escalabilidad: tiempo de arranque a largo plazo

### El problema

El consumer lee **todo** el historico de Kafka en cada arranque. A medida que pasan los meses y anos, Kafka acumula CDCs. El tiempo de rebuild crece de forma lineal:

| Mensajes en Kafka | Tiempo estimado de arranque |
|---|---|
| 40K (actual) | ~3 segundos |
| 500K (1 ano, pocas tablas) | ~35 segundos |
| 5M (3 anos, mas tablas) | ~6 minutos |
| 50M (5 anos, muchas tablas) | ~1 hora |

Cada reinicio (deploy, actualizacion, crash) paga ese coste completo. Con muchas tablas y muchos registros, el arranque puede ser inviable.

### Solucion aplicada: Compactacion de topics en Kafka

**Estado: ACTIVO.** Los 3 topics tienen `cleanup.policy=compact` y Debezium usa el primary key de cada fila como clave del mensaje.

Kafka mantiene **solo el ultimo mensaje por clave**. Para un proveedor P01868 que tuvo 200 UPDATEs en 5 anos, Kafka conserva solo el ultimo.

```
Sin compactacion (5 anos):              Con compactacion (estado actual):
  snapshot P01868 (op: r)                 ultimo UPDATE P01868  ← solo este
  UPDATE P01868 nombre
  UPDATE P01868 fecbaj
  UPDATE P01868 nombre
  ... (197 mas)
  ultimo UPDATE P01868
```

Resultado: en vez de 50M de mensajes, Kafka mantiene ~40K (uno por registro por tabla, siempre la version mas reciente). El arranque se mantiene en **segundos** independientemente del tiempo que lleve el sistema en marcha.

Configuracion aplicada en los 3 topics:

```bash
kafka-configs --bootstrap-server kafka:29092 \
  --alter --entity-type topics --entity-name informix.informix.ctercero \
  --add-config cleanup.policy=compact

kafka-configs --bootstrap-server kafka:29092 \
  --alter --entity-type topics --entity-name informix.informix.gproveed \
  --add-config cleanup.policy=compact

kafka-configs --bootstrap-server kafka:29092 \
  --alter --entity-type topics --entity-name informix.informix.cterdire \
  --add-config cleanup.policy=compact
```

**Nota**: la compactacion no es inmediata — Kafka la ejecuta en background. Puede haber momentos con mensajes duplicados por clave hasta que el cleaner pasa. El consumer lo tolera bien (sobreescribe en el store).

### Solucion 2: Reset periodico de topics (sin cambios de codigo)

Borrar los topics y dejar que Debezium haga un snapshot fresco. Es el mismo procedimiento que al cambiar de servidor Informix:

1. Parar Debezium
2. Borrar los 3 topics
3. Borrar offsets de Debezium (para forzar re-snapshot)
4. Arrancar Debezium → snapshot fresco de las tablas
5. Reiniciar consumer

Se puede hacer cada 6 meses o cuando el arranque empiece a ser lento. No requiere cambios de codigo.

**Ventajas**: simple, operacional, resetea el historico a un estado limpio.

**Inconvenientes**: hay downtime durante el proceso (Debezium re-lee todas las tablas). Con 40K registros son segundos, con millones podria ser minutos.

### Solucion 3: Store persistente (cambio arquitectonico)

Si el store no vive en RAM (Redis, SQLite), no hace falta leer desde offset 0. Combinado con offsets persistentes, el arranque es **instantaneo** sea cual sea el volumen.

Es la solucion mas completa pero tambien la mas costosa en desarrollo (ver seccion anterior). Solo merece la pena si el volumen crece a cientos de miles de registros o si se necesitan arranques instantaneos.

### Comparativa de soluciones de escalabilidad

| | Compactacion Kafka | Reset periodico | Store persistente |
|---|---|---|---|
| **Estado** | **ACTIVO** | Disponible | No implementado |
| **Esfuerzo** | Configuracion | Operacional | Alto (codigo) |
| **Cambio de codigo** | Ninguno | Ninguno | ~15 ficheros |
| **Arranque con 50M CDCs** | ~3s (compactado a ~40K) | ~3s (post-reset) | Instantaneo |
| **Automatico** | Si (Kafka lo gestiona) | No (manual o cron) | Si |
| **Downtime** | Ninguno | Minutos (durante reset) | Ninguno |
| **Dependencias nuevas** | Ninguna | Ninguna | Redis o SQLite |

### Estado actual

La **compactacion de topics** esta activa. Los 3 topics tienen `cleanup.policy=compact` y Debezium usa primary keys como clave de mensaje. Esto resuelve el crecimiento indefinido de Kafka y mantiene el tiempo de arranque estable a largo plazo.

Si en el futuro el proyecto crece a muchas tablas con millones de registros y se necesitan arranques instantaneos, el paso siguiente seria el store persistente.

---

## Resumen simplificado

Para entender el sistema sin entrar en detalles tecnicos:

### Que problema resuelve

Fedefarma tiene datos de proveedores en una base de datos antigua (Informix). Otra aplicacion necesita esos datos en un formato diferente a traves de una API. Este sistema **sincroniza automaticamente** los datos de proveedores desde Informix hacia esa API, en tiempo real.

### Como funciona (en 4 pasos)

```
PASO 1: VIGILAR                PASO 2: TRANSMITIR
+------------------+           +------------------+
|   Informix DB    |           |      Kafka       |
|                  |  cambio   |                  |
| Alguien modifica | --------> | Guarda el cambio |
| un proveedor     | Debezium  | como un mensaje  |
+------------------+           +------------------+
                                        |
                                        |
PASO 4: ENVIAR                 PASO 3: PROCESAR
+------------------+           +------------------+
|    API destino   |           |    Consumer      |
|                  |  PUT JSON |                  |
| Recibe el dato   | <-------- | Lee el mensaje,  |
| actualizado      |           | transforma y     |
+------------------+           | agrupa los datos |
                               +------------------+
```

**Paso 1 — Vigilar**: Debezium vigila la base de datos Informix. Cada vez que alguien crea, modifica o borra un proveedor, Debezium lo detecta.

**Paso 2 — Transmitir**: El cambio se envia a Kafka, que actua como una cola de mensajes. Kafka guarda todos los mensajes (incluso los antiguos) para que no se pierda nada.

**Paso 3 — Procesar**: El consumer lee los mensajes de Kafka. Mantiene una copia de los datos en su memoria para poder cruzar informacion de distintas tablas (datos basicos + fechas + direcciones). Cuando detecta un cambio relevante, espera 1 segundo por si llegan mas cambios del mismo proveedor y los agrupa.

**Paso 4 — Enviar**: El consumer construye el formato JSON que necesita la API destino y lo envia. Si un proveedor tiene 3 direcciones, se generan 3 registros de contacto.

### Caracteristicas clave

- **Automatico**: no requiere intervencion humana. Los cambios se propagan solos.
- **Tiempo real**: un cambio en Informix llega a la API en ~1.5 segundos.
- **Resistente a caidas**: si el consumer se para, al volver a arrancar reconstruye todo el estado desde Kafka y se pone al dia.
- **Sin conexion directa**: el consumer nunca se conecta a Informix. Solo lee mensajes de Kafka.
- **Agrupacion inteligente**: si llegan 1.000 cambios en 3 segundos, no hace 1.000 llamadas a la API. Los agrupa en unas pocas llamadas.
- **Observable**: hay herramientas web para ver los datos en memoria (Store Viewer), consultar la API (Swagger UI) y monitorizar todo el sistema (Grafana).
