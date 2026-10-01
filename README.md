# ZY Coffee — sistema de una sucursal

Aplicación de operación para pedidos web, barra y caja de una sola sucursal. Incluye una carta de ejemplo en MXN, cuenta opcional para clientes, pedido como invitado, bandeja del barista y punto de venta.

## Inicio

Este proyecto usa Node.js 24 o posterior y SQLite integrado en Node.

```sh
npm start
```

Abre `http://localhost:3000`.

## Flujo de clientes

- Se puede navegar por el menú y armar el carrito sin cuenta.
- El cliente puede enviar la solicitud como invitado, o crear cuenta/iniciar sesión para guardar sus datos y consultar pedidos recientes.
- El envío crea una solicitud pendiente; no se cobra en línea. El café confirma disponibilidad y horario de recogida.
- La carta incluye una nota sobre alergias. Revisa ingredientes con el equipo antes de consumir.

## Equipo

- `http://localhost:3000/admin`: iniciar sesión, revisar pedidos web/ventas, actualizar estados, pausar pedidos web y administrar el menú.
- `http://localhost:3000/pos`: abrir turno con fondo inicial, registrar ventas pagadas en efectivo o terminal, consultar totales y cerrar caja contando el efectivo.
- La clave del equipo está en el archivo local `.env` (ignorado por Git). Cámbiala ahí si necesitas rotarla; conserva al menos 12 caracteres.

Los registros se guardan en `data/zy-coffee.sqlite`. Mantén una copia de seguridad del archivo cuando detengas la app. El punto de venta registra pagos cobrados fuera de la app; no procesa tarjetas ni emite facturas.

## Menú

El menú inicial es demostrativo porque falta la carta oficial con productos y precios. Puedes actualizarlo desde Administración o editar `menu.js` antes del primer inicio.

## Antes de publicar

Agrega datos oficiales de contacto del negocio y revisa el aviso de privacidad. Para operar en internet, aloja la aplicación y la base de datos en un servidor con HTTPS y almacenamiento persistente; la vista previa `localhost` solo funciona en este equipo.
