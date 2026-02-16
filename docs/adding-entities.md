# Guia: Como anadir nuevas entidades

Este documento explica paso a paso como anadir una nueva entidad al consumer CDC, de forma que:
- Los cambios en Informix se detecten y envien automaticamente a la API externa (flujo CDC).
- Se expongan endpoints Trigger API (`POST`/`DELETE`) para sync/delete bulk bajo demanda.
- Se genere documentacion Swagger automaticamente.

**Tiempo estimado**: 30-60 minutos si la tabla ya existe en el TABLE_REGISTRY.

---

## Conceptos clave

El proyecto tiene **dos registries** que son la fuente de verdad:

| Registry | Que define | Quien lo consume |
|---|---|---|
| `TABLE_REGISTRY` (`domain/table-registry.ts`) | **Tablas** CDC: campos a monitorizar, tipo de store, topic Kafka, keyField | Store, watched-fields, message-handler |
| `ENTITY_REGISTRY` (`domain/entity-registry.ts`) | **Entidades** API: tipo, label, ruta trigger, endpoint API, metadata Swagger | Server, schemas, dispatcher, debouncer, bulk-service |

Una **tabla** alimenta una o varias **entidades**. Por ejemplo, `ctercero` alimenta `supplier` y `contact`.

### Filtro codare

Por defecto, los payloads solo se envian para terceros cuyo campo `codare` (en `ctercero`) este registrado en `CODARE_REGISTRY`. Si tu entidad aplica a **todos** los terceros (independientemente de codare), debe marcarse como **exenta** en `CODARE_EXEMPT`.

| Escenario | Accion |
|---|---|
| Solo proveedores (codare=PRO) | Anadir el tipo a `CODARE_REGISTRY` bajo `"PRO"` |
| Todos los terceros | Anadir el tipo a `CODARE_EXEMPT` |
| Nuevo tipo de tercero (ej: LAB) | Crear entrada en `CODARE_REGISTRY`: `{ codare: "LAB", payloadTypes: [...] }` |

---

## Paso a paso

Vamos a usar como ejemplo una entidad ficticia llamada `warehouse`.

### 1. Tipos (`src/types/`)

**`src/types/payloads.ts`** — Anadir la interfaz y el tipo al union:

```typescript
// Anadir la interfaz con los campos que espera la API externa
export interface Warehouse {
  CodWarehouse: string;
  Name: string;
  Location: string | null;
  // ... campos segun el schema de la API
}

// Anadir "warehouse" al union
export type PayloadType = "supplier" | "contact" | "agreement" | "warehouse";

// Anadir Warehouse[] al union
export type AnyPayload = Supplier[] | SupplierContact[] | Agreement[] | Warehouse[];
```

**`src/types/deletions.ts`** — Anadir la interfaz de borrado (si la API tiene endpoint DELETE):

```typescript
export interface WarehouseDeletion {
  CodWarehouse: string;
  DeletionDate?: string | null;
}
```

### 2. Tabla en el registry (`src/domain/table-registry.ts`)

Si la tabla ya existe en `TABLE_REGISTRY`, solo hay que anadir watched fields. Si es nueva:

```typescript
{
  table: "almacen",                    // nombre en Informix (lowercase)
  storeKind: "single",                 // "single" = 1 registro por codigo, "array" = N registros
  watchedFields: [
    { field: "nombre", payloads: ["warehouse"] },
    { field: "ubicac", payloads: ["warehouse"] },
    // Cada campo declara que payload types dispara al cambiar
  ],
  topic: "informix.informix.almacen",  // patron: informix.informix.{tabla}
  storeFields: ["codigo", "nombre", "ubicac"],  // solo los campos que necesita el builder
  // keyField: "tercer",               // solo si la FK no es "codigo" (default)
},
```

**Notas**:
- `storeFields` es importante: Debezium envia TODAS las columnas de la tabla. Sin filtro, el store guardaria 30+ campos innecesarios.
- `keyField` solo se necesita si la clave de agrupacion no es `"codigo"` (ej: `gvenacuh` usa `"tercer"`).
- Si quieres que cambios en una **tabla existente** tambien disparen tu entidad, anade `"warehouse"` al array `payloads` de los watched fields correspondientes.

### 3. Entidad en el registry (`src/domain/entity-registry.ts`)

```typescript
{
  type: "warehouse",
  label: "Warehouse",                        // para logs en Grafana
  triggerPath: "warehouses",                  // URL: /triggers/warehouses
  apiPath: "/ingest-api/warehouses",          // endpoint de la API externa
  swagger: {
    sync: {
      summary: "Bulk sync warehouses",
      description: "Reads all warehouses from the store and sends them to the ingest API.",
    },
    delete: {
      summary: "Bulk delete warehouses",
      description: "Sends a deletion payload for every warehouse in the store.",
    },
  },
},
```

Esto genera automaticamente:
- `POST /triggers/warehouses` (sync)
- `DELETE /triggers/warehouses` (delete)
- Documentacion en Swagger UI (`/docs`)

### 4. Filtro codare (`src/domain/codare-registry.ts`)

Segun el caso:

```typescript
// Opcion A: Solo para proveedores (codare=PRO)
// Anadir "warehouse" al array existente:
{ codare: "PRO", payloadTypes: ["supplier", "contact", "warehouse"] },

// Opcion B: Para todos los terceros (sin filtro codare)
// Anadir a CODARE_EXEMPT:
export const CODARE_EXEMPT: Set<PayloadType> = new Set(["agreement", "warehouse"]);
```

### 5. Builder (`src/payloads/warehouse.ts`)

```typescript
import { store } from "../domain/store";
import { logger } from "../logger";
import { Warehouse, PayloadType } from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";
import { trimOrNull, formatDate } from "./payload-utils";

export class WarehouseBuilder implements PayloadBuilder<Warehouse[]> {
  readonly type: PayloadType = "warehouse";

  build(codigo: string): Warehouse[] | null {
    // Leer datos del store (getSingle para storeKind:"single", getArray para "array")
    const record = store.getSingle("almacen", codigo);

    if (!record) {
      logger.info({ tag: "Warehouse", codigo }, "No data found");
      return null;
    }

    // Construir el payload segun el schema de la API externa
    return [{
      CodWarehouse: String(codigo),
      Name: String(record["nombre"] ?? "").trim(),
      Location: trimOrNull(record["ubicac"]),
    }];
  }
}
```

**Helpers disponibles** en `payloads/payload-utils.ts`:
- `trimOrNull(value)` — convierte a string, trim, null si vacio
- `isActive(fecbaj)` — true si fecbaj es null o vacio (proveedor activo)
- `formatDate(value)` — epoch days o ISO string → `YYYY-MM-DD`

### 6. Bulk handler (`src/bulk/handlers/warehouse-handler.ts`)

```typescript
import { BulkHandler, BulkSyncResult, BulkDeletionResult } from "../bulk-handler";
import { PayloadRegistry } from "../../payloads/payload-builder";
import { store } from "../../domain/store";
import { PayloadType, Warehouse } from "../../types/payloads";
import { SkippedDetail, WarehouseDeletion } from "../../types/deletions";
// Si necesita filtro codare:
// import { getAllowedTypes } from "../../domain/codare-registry";

export class WarehouseBulkHandler implements BulkHandler {
  readonly type: PayloadType = "warehouse";

  constructor(private registry: PayloadRegistry) {}

  syncAll(codigos: string[]): BulkSyncResult {
    const builder = this.registry.get("warehouse");
    const items: Warehouse[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      // Validar existencia en el store ANTES de llamar al builder
      const record = store.getSingle("almacen", codigo);
      if (!record) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (almacen)" });
        continue;
      }

      // Si necesita filtro codare, anadir aqui (ver supplier-handler.ts como ejemplo)

      const result = builder?.build(codigo) as Warehouse[] | null;
      if (result) {
        items.push(...result);
      } else {
        skippedDetails.push({ CodSupplier: codigo, reason: "Builder returned null" });
      }
    }

    return { items, skippedDetails };
  }

  deleteAll(codigos: string[]): BulkDeletionResult {
    const now = new Date().toISOString();
    const items: WarehouseDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const record = store.getSingle("almacen", codigo);
      if (!record) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (almacen)" });
        continue;
      }
      items.push({ CodWarehouse: codigo, DeletionDate: now });
    }

    return { items, skippedDetails };
  }
}
```

### 7. Registrar en `src/index.ts`

```typescript
// Imports
import { WarehouseBuilder } from "./payloads/warehouse";
import { WarehouseBulkHandler } from "./bulk/handlers/warehouse-handler";

// En la funcion main(), anadir al PayloadRegistry:
registry.register(new WarehouseBuilder());

// Y al BulkService (dentro del bloque if config.http.enabled):
bulkService.registerHandler(new WarehouseBulkHandler(registry));
```

### 8. Tests

**`src/payloads/warehouse.test.ts`** — Tests del builder:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../domain/store", () => {
  const getSingle = vi.fn();
  return { store: { getSingle, getArray: vi.fn(), getAllCodigos: vi.fn() } };
});

import { WarehouseBuilder } from "./warehouse";
import { store } from "../domain/store";

const mockGetSingle = vi.mocked(store.getSingle);

describe("WarehouseBuilder", () => {
  let builder: WarehouseBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new WarehouseBuilder();
  });

  it("has type 'warehouse'", () => {
    expect(builder.type).toBe("warehouse");
  });

  it("builds payload with complete data", () => {
    mockGetSingle.mockReturnValue({ codigo: "W001", nombre: "Main", ubicac: "BCN" });
    const result = builder.build("W001");
    expect(result).toHaveLength(1);
    expect(result![0].CodWarehouse).toBe("W001");
  });

  it("returns null when record is missing", () => {
    mockGetSingle.mockReturnValue(undefined);
    expect(builder.build("W001")).toBeNull();
  });

  // Anadir tests para: campos null, trimming, transformaciones especificas...
});
```

**`src/bulk/handlers/warehouse-handler.test.ts`** — Tests del bulk handler:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../domain/store", () => ({
  store: { getSingle: vi.fn(), getArray: vi.fn(), getAllCodigos: vi.fn() },
}));

import { WarehouseBulkHandler } from "./warehouse-handler";
import { store } from "../../domain/store";
import { PayloadType } from "../../types/payloads";

const mockGetSingle = vi.mocked(store.getSingle);

function createMockRegistry() {
  const builder = { type: "warehouse" as PayloadType, build: vi.fn() };
  return {
    builder,
    registry: {
      get: vi.fn((t: PayloadType) => (t === "warehouse" ? builder : undefined)),
      register: vi.fn(),
      buildAll: vi.fn(),
    },
  };
}

describe("WarehouseBulkHandler", () => {
  // syncAll: happy path, record missing → skip, builder null → skip
  // deleteAll: happy path, record missing → skip
  // Ver supplier-handler.test.ts o agreement-handler.test.ts como referencia
});
```

---

## Verificacion

Despues de implementar, ejecutar en este orden:

```bash
# 1. Compilar — debe pasar sin errores
npm run build

# 2. Tests — todos deben pasar (los existentes + los nuevos)
npm test

# 3. Levantar el consumer
docker compose up -d --build consumer

# 4. Verificar Swagger UI — deben aparecer los nuevos endpoints
open http://localhost:3001/docs

# 5. Verificar Store Viewer — la nueva tabla debe ser visible
open http://localhost:3001/store

# 6. Probar Trigger API manualmente
curl -X POST http://localhost:3001/triggers/warehouses \
  -H "Authorization: Bearer $TRIGGER_API_KEY" \
  -H "Content-Type: application/json"

# 7. Verificar en Grafana que los logs CDC aparecen con el tag correcto
# {container="informix-consumer"} | json | tag = `Warehouse`
```

---

## Ficheros que NO necesitan cambios

Gracias al patron data-driven, estos ficheros **nunca se tocan** al anadir una entidad:

| Fichero | Motivo |
|---|---|
| `http/server.ts` | Las rutas se generan desde `ENTITY_REGISTRY` |
| `http/schemas.ts` | `makeTriggerSchema()` usa los metadatos swagger del registry |
| `bulk/bulk-service.ts` | Motor generico, delega en el handler registrado |
| `dispatch/dispatcher.ts` | Usa `ENTITY_ENDPOINTS` del registry |
| `dispatch/cdc-debouncer.ts` | Usa `ENTITY_LABELS` para logs |
| `dispatch/pending-buffer.ts` | Usa `ENTITY_LABELS` para logs |
| `kafka/consumer.ts` | Los topics se derivan de `ALL_TOPICS` |
| `kafka/message-handler.ts` | Lee `FIELD_TO_PAYLOADS` del registry |
| `domain/store.ts` / `sqlite-store.ts` | Data-driven desde `TABLE_REGISTRY` |
| `domain/watched-fields.ts` | Lee `WATCHED_FIELDS` del registry |

---

## Checklist rapido

- [ ] Interface del payload en `types/payloads.ts`
- [ ] Interface de deletion en `types/deletions.ts`
- [ ] Tipo anadido a `PayloadType` union
- [ ] Tipo anadido a `AnyPayload` union
- [ ] Tabla en `TABLE_REGISTRY` con `watchedFields` y `storeFields`
- [ ] Entidad en `ENTITY_REGISTRY` con swagger metadata
- [ ] Filtro codare resuelto (CODARE_REGISTRY o CODARE_EXEMPT)
- [ ] Builder creado en `payloads/`
- [ ] Bulk handler creado en `bulk/handlers/`
- [ ] Registrado en `index.ts` (registry + bulkService)
- [ ] Tests del builder
- [ ] Tests del bulk handler
- [ ] `npm run build` pasa
- [ ] `npm test` pasa
- [ ] Swagger UI muestra los endpoints
- [ ] Documentar en `CLAUDE.md` (skippedDetails, dispatch table, test table)

---

## Referencia: entidades existentes

| Entidad | Tipo | Tablas que lee | Filtro codare | Builder | Bulk handler |
|---|---|---|---|---|---|
| Supplier | `supplier` | ctercero, gproveed | PRO | `payloads/supplier.ts` | `bulk/handlers/supplier-handler.ts` |
| SupplierContact | `contact` | ctercero, gproveed, cterdire | PRO | `payloads/supplier-contact.ts` | `bulk/handlers/contact-handler.ts` |
| Agreement | `agreement` | gvenacuh | **Exento** | `payloads/agreement.ts` | `bulk/handlers/agreement-handler.ts` |
