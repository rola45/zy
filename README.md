# ZY Coffee

Sistema sencillo para mostrar el menú de ZY Coffee y recibir solicitudes de pedido para recoger.

## Inicio rápido

1. La clave privada del panel está guardada en `.env` (archivo local ignorado por Git). Cámbiala ahí si quieres usar otra.
2. Ejecuta `npm start` con Node.js 24 o posterior.
3. Abre `http://localhost:3000`.
4. El panel de administración está en `http://localhost:3000/admin`.

Las solicitudes se guardan en `data/zy-coffee.sqlite`. Los pedidos son solicitudes de preparación y no se realiza ningún cobro en línea.

El menú de ejemplo está en `menu.js` y puede actualizarse según la carta real.
