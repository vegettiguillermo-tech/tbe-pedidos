TBE PEDIDOS 3.0 - ANDROID
=========================

1. Abrir esta carpeta /android con Android Studio.
2. Esperar la sincronizacion de Gradle.
3. Compilar e instalar en la tablet.
4. La app abre en horizontal y pantalla completa.
5. Ir a Configuracion y cargar:
   - URL del servidor Render, por ejemplo https://tbe-pedidos.onrender.com
   - Clave de la tablet: el mismo TBE_ADMIN_KEY configurado en Render
   - IP de la impresora WiFi

IMPRESION
---------
La app incluye PrinterBridge y usa socket TCP puerto 9100.
Los pedidos de WhatsApp que llegan al servidor aparecen en tiempo real en la tablet
y se imprimen automaticamente una sola vez en esa tablet.

SEGURIDAD
---------
La depuracion de WebView queda habilitada solamente en compilaciones DEBUG.
En produccion usar una compilacion RELEASE.

NOTA
----
El servidor y WhatsApp funcionan independientemente de la impresion. Para recibir
pedidos de WhatsApp la tablet necesita acceso a Internet. Para imprimir necesita
alcanzar la IP de la impresora por WiFi.
