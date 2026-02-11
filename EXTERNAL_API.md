# External API Documentation

## JSON Suppliers

```json
[
  {
    "CodSupplier": "PRV000123",
    "Supplier": "Proveedor Demo S.A.",
    "NIF": "A12345678",
    "StartDate": "2023-05-10",
    "Status": "ACTIVE"
  }
]
```

## JSON Suppliers Contacts

```json
[
  {
    "CodSupplier": "PRV000123",
    "Name": "Proveedor Demo S.A.",
    "NIF": "A12345678",
    "Adress": "Calle Mayor 15",
    "City": "Barcelona",
    "Country": "ES",
    "Postal_Code": "08001",
    "Phone": "+34931234567",
    "E_Mail": "info@proveedordemo.com",
    "Status": "ACTIVE"
  }
]
```

## Origen Suppliers

| Campo | Tipo | Origen | Notas |
|---|---|---|---|
| CodSupplier | string (max 50) | ctercero.codigo | Requerido |
| Supplier | string (max 255) | ctercero.nombre | Requerido, trimmed |
| NIF | string (max 50) \| null | ctercero.cif | Nullable, trimmed |
| StartDate | date \| null | gproveed.fecalt | Dias desde epoch -> YYYY-MM-DD |
| Status | string (max 50) \| null | gproveed.fecbaj | null -> "ACTIVE", con valor -> "INACTIVE" |

## Origen Suppliers Contacts

| Campo | Tipo | Origen | Notas |
|---|---|---|---|
| CodSupplier | string (max 50) | ctercero.codigo | Requerido |
| Name | string (max 255) | ctercero.nombre | Requerido, trimmed |
| NIF | string (max 50) \| null | ctercero.cif | Nullable, trimmed |
| Adress | string (max 255) \| null | cterdire.direcc | Nullable, trimmed |
| City | string (max 255) \| null | cterdire.poblac | Nullable, trimmed |
| Country | string (max 2) \| null | cterdire.codnac | ISO3 -> ISO2 (ej: ESP -> ES) |
| Postal_Code | string (max 50) \| null | cterdire.codpos | Nullable, trimmed |
| Phone | string (max 50) \| null | cterdire.telef1 | Nullable, trimmed |
| E_Mail | string (max 255) \| null | cterdire.email | Nullable, trimmed |
| Status | string (max 50) \| null | gproveed.fecbaj | null -> "ACTIVE", con valor -> "INACTIVE" |

## API Endpoints

| Metodo | Endpoint | Body |
|---|---|---|
| PUT | `/ingest-api/suppliers` | `Supplier[]` |
| DELETE | `/ingest-api/suppliers` | `SupplierDeletion[]` |
| PUT | `/ingest-api/suppliers-contacts` | `SupplierContact[]` |
| DELETE | `/ingest-api/suppliers-contacts` | `SupplierContactDeletion[]` |
| POST | `/ingest-api/token` | `{ username, password }` -> JWT |

Autenticacion: Bearer token (JWT) en todos los endpoints excepto `/token`.

Especificacion OpenAPI completa: `src/external-api-documentation/openapi.json`
