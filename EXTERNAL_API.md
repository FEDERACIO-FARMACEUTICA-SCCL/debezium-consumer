JSON Suppliers:

{

  ‘Suppliers': [

    {

      "IdSupplier": "6571AAE7-FBC9-41C0-9690-0063408449FC”,

      "CodSupplier": "PRV000123",

      "Supplier": "Proveedor Demo S.A.",

      "NIF": "A12345678",

      "StartDate': "2023-05-10",

      "Status": "ACTIVE"

    }

  ]

}

 

JSON Contacs relacionados con Suppliers:

{
    “Suppliers_Contacts": [

        {

          "IdSupplier": "6571AAE7-FBC9-41C0-9690-0063408449FC",

          “Name": "Proveedor Demo S.A.",

          “NIF": "A12345678",

          “Address": "Calle Mayor 15",

          “City": "Barcelona",

          “Country": "ES",

          “Postal_Code": "08001",

          “Phone": "+34931234567",

          “E_Mail": "info@proveedordemo.com",

          “Status": "ACTIVE"

        }

      ]
}


Origen Suppliers

IdSupplier: UUID Farmacloud

CodSupplier: FedeFarma_imports..ctercero.codigo

Supplier [VARCHAR(255)] : FedeFarma_imports..ctercero.nombre

NIF [VARCHAR(50)] : FedeFarma_imports..ctercero.cif

StartDate [DATE] : TRY_CONVERT(date, FedeFarma_imports..gproveed.fecalt)

Status [VARCHAR(255)] : TRY_CONVERT(date, FedeFarma_imports..gproveed.fecbaj) is null ? ACTIVO | BAJA

 

      Origen Suppliers_Contacts

             IdSupplier: UUID Farmacloud

Name [VARCHAR(255)] : FedeFarma_imports..ctercero.nombre

NIF [VARCHAR(50)] : FedeFarma_imports..ctercero.cif

Address [VARCHAR(255)] : FedeFarma_imports..cterdire.direcc

City [VARCHAR(255)] : FedeFarma_imports..cterdire.poblac

Country [VARCHAR(255)] : FedeFarma_imports..cterdire.codnac

Postal_Code [VARCHAR(50)] : FedeFarma_imports..cterdire.codpos

Phone [VARCHAR(50)] : FedeFarma_imports..cterdire.telef1

E_Mail [VARCHAR(255)] : FedeFarma_imports..cterdire.email

          Status [VARCHAR(255)] : TRY_CONVERT(date, FedeFarma_imports..gproveed.fecbaj) is null ? ACTIVO | BAJA