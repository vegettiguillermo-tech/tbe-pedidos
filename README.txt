TBE PEDIDOS 3.0 - PRODUCCION
============================

Esta version esta preparada para desplegar el servidor y conectar WhatsApp Business
Cloud API de Meta.

CAMBIOS DE ESTA VERSION
-----------------------
- Se elimino de Caja el bloque de retiros de efectivo.
- Se elimino el cierre manual con efectivo contado, observacion y diferencia.
- La Caja ahora trabaja por DIA y genera cierres diarios automaticamente.
- Al comenzar un nuevo dia, el dia anterior queda guardado en Cierres diarios.
- Caja muestra: total, efectivo, electronico, pedidos, retiro, delivery, WhatsApp y Tablet.
- Se mantiene el detalle de productos vendidos y la impresion del resumen.
- Categorias: agregar, editar, ocultar y eliminar.
- Productos: agregar, editar, mover de categoria, ocultar y eliminar.
- WhatsApp: nombre, retiro/delivery, direccion, menu, pago y confirmacion.
- Al marcar LISTO un pedido de WhatsApp se envia el aviso automatico al cliente.
- La tablet muestra si el aviso de WhatsApp fallo en lugar de afirmar que se envio.
- Webhook protegido con firma X-Hub-Signature-256 usando WHATSAPP_APP_SECRET.
- Los mensajes de WhatsApp procesados se recuerdan para evitar reprocesar reintentos.
- Las conversaciones activas del bot se guardan en disco y sobreviven reinicios.
- API de tablet protegida con TBE_ADMIN_KEY.
- El simulador queda desactivado por defecto en produccion.
- Render usa /var/data mediante disco persistente para no perder pedidos/caja/menu.

PRUEBA LOCAL
------------
Para probar sin Meta:

Windows CMD:
  set NODE_ENV=development
  set ENABLE_SIMULATOR=true
  npm start

Abrir:
  http://localhost:3000
  http://localhost:3000/simulator.html

En desarrollo, si no definis TBE_ADMIN_KEY, la API local queda habilitada para facilitar
la prueba. En produccion TBE_ADMIN_KEY debe estar configurada.

PRODUCCION EN RENDER
--------------------
El archivo render.yaml ya incluye:
- servicio Node
- health check
- disco persistente /var/data
- zona horaria Argentina
- simulador desactivado
- variables privadas pendientes de completar

Variables privadas que tenes que cargar:
  TBE_ADMIN_KEY
  WHATSAPP_TOKEN
  WHATSAPP_PHONE_NUMBER_ID
  WHATSAPP_VERIFY_TOKEN
  WHATSAPP_APP_SECRET

Consultar CONFIGURAR_WHATSAPP.txt para el paso a paso.

TABLET / ANDROID
----------------
El proyecto Android esta en /android.
La pantalla se ejecuta en WebView y conserva el puente de impresion por WiFi.

En Configuracion cargar:
- URL publica del servidor Render
- misma TBE_ADMIN_KEY configurada en Render
- IP de la impresora

La impresion usa AndroidPrinter por puerto 9100.

ARCHIVOS PERSISTENTES
---------------------
En DATA_DIR se guardan:
- store.json: negocio, categorias y productos
- orders.json: pedidos
- cash.json: caja y cierres diarios
- sessions.json: estado de conversaciones WhatsApp
- processed_messages.json: IDs de mensajes ya procesados

IMPORTANTE
----------
No publicar ni enviar a terceros los valores de WHATSAPP_TOKEN, WHATSAPP_APP_SECRET,
WHATSAPP_VERIFY_TOKEN ni TBE_ADMIN_KEY.
