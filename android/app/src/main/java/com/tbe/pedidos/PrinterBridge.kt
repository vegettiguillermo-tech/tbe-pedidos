package com.tbe.pedidos

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors

class PrinterBridge(private val ctx: Context) {
    companion object {
        private const val DEFAULT_IP = "20.20.10.10"
        private const val DEFAULT_PORT = 9100
        private const val COLS = 42
    }

    private val prefs = ctx.getSharedPreferences("printer_prefs", Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()

    @JavascriptInterface
    fun setPrinter(ip: String, port: Int) {
        prefs.edit().putString("ip", ip.trim()).putInt("port", port).apply()
    }

    @JavascriptInterface
    fun pingPrinter(): Boolean {
        return try {
            val ip = prefs.getString("ip", DEFAULT_IP) ?: DEFAULT_IP
            val port = prefs.getInt("port", DEFAULT_PORT)
            openPrinterSocket(ip, port, 900).use { true }
        } catch (_: Exception) { false }
    }

    @JavascriptInterface
    fun printOrder(json: String) {
        executor.execute {
            try {
                val root = JSONObject(json)
                val businessName = root.optString("businessName", "TBE PEDIDOS")
                val order = root.optJSONObject("order") ?: root
                val number = order.optInt("number", 0)
                val customer = order.optString("customerName", "Sin nombre")
                val source = order.optString("source", "TABLET")
                val phone = order.optString("phone", "")
                val notes = order.optString("notes", "")
                val total = order.optDouble("total", 0.0)
                val createdAt = order.optString("createdAt", "")
                val readyAt = order.optString("readyAt", "")
                val deliveryType = order.optString("deliveryType", "RETIRO")
                val address = order.optString("address", "")
                val paymentMethod = order.optString("paymentMethod", "A_DEFINIR")
                val items = order.optJSONArray("items")

                withPrinter { out ->
                    fun cmd(vararg bytes: Int) = out.write(ByteArray(bytes.size) { i -> bytes[i].toByte() })
                    fun line(value: String = "") = out.write((safe(value) + "\n").toByteArray(Charsets.US_ASCII))
                    fun center() = cmd(0x1B, 0x61, 0x01)
                    fun left() = cmd(0x1B, 0x61, 0x00)
                    fun bold(on: Boolean) = cmd(0x1B, 0x45, if (on) 1 else 0)

                    cmd(0x1B, 0x40)
                    center(); bold(true)
                    line(fit(businessName.uppercase(), COLS))
                    cmd(0x1D, 0x21, 0x11)
                    line("PEDIDO #${number.toString().padStart(3, '0')}")
                    cmd(0x1D, 0x21, 0x00)
                    bold(false)
                    line("=".repeat(COLS))
                    left()
                    bold(true); wrap("NOMBRE: $customer", COLS).forEach { line(it) }; bold(false)
                    line("ORIGEN: ${if (source == "WHATSAPP") "WHATSAPP" else "MOSTRADOR"}")
                    line("ENTREGA: ${if (deliveryType == "DELIVERY") "DELIVERY" else "RETIRO"}")
                    if (deliveryType == "DELIVERY" && address.isNotBlank()) {
                        bold(true); line("DIRECCION:"); bold(false)
                        wrap(address, COLS).forEach { line(it) }
                    }
                    line("PAGO: ${paymentLabel(paymentMethod)}")
                    if (phone.isNotBlank()) line("TEL: $phone")
                    if (createdAt.isNotBlank()) line("FECHA: ${formatIso(createdAt)}")
                    if (readyAt.isNotBlank()) {
                        center(); bold(true)
                        cmd(0x1D, 0x21, 0x11)
                        line("SALIDA ${formatTimeIso(readyAt)}")
                        cmd(0x1D, 0x21, 0x00)
                        bold(false); left()
                    }
                    line("-".repeat(COLS))

                    if (items != null) {
                        for (i in 0 until items.length()) {
                            val it = items.getJSONObject(i)
                            val qty = it.optInt("qty", it.optInt("cant", 1)).coerceAtLeast(1)
                            val name = it.optString("name", it.optString("nombre", "Producto"))
                            bold(true)
                            wrap("$qty x $name", COLS).forEach { part -> line(part) }
                            bold(false)
                        }
                    }

                    if (notes.isNotBlank()) {
                        line("-".repeat(COLS))
                        bold(true); line("OBSERVACIONES:"); bold(false)
                        wrap(notes, COLS).forEach { line(it) }
                    }

                    line("=".repeat(COLS))
                    center(); bold(true)
                    cmd(0x1D, 0x21, 0x11)
                    line("TOTAL ${formatMoney(total)}")
                    cmd(0x1D, 0x21, 0x00)
                    line("*** COCINA ***")
                    bold(false)
                    cmd(0x1B, 0x64, 0x05)
                    cmd(0x1D, 0x56, 0x00)
                    out.flush()
                }
            } catch (e: Exception) {
                showToast("Error imprimiendo pedido: ${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun printCashSummary(json: String) {
        executor.execute {
            try {
                val root = JSONObject(json)
                val businessName = root.optString("businessName", "TBE PEDIDOS")
                val kind = root.optString("kind", "CAJA")
                val data = root.optJSONObject("data") ?: JSONObject()
                val summary = data.optJSONObject("summary") ?: JSONObject()
                val businessDate = data.optString("businessDate", "")
                val openedAt = data.optString("openedAt", "")
                val closedAt = data.optString("closedAt", "")
                val products = summary.optJSONArray("products")

                withPrinter { out ->
                    fun cmd(vararg bytes: Int) = out.write(ByteArray(bytes.size) { i -> bytes[i].toByte() })
                    fun line(value: String = "") = out.write((safe(value) + "\n").toByteArray(Charsets.US_ASCII))
                    fun center() = cmd(0x1B, 0x61, 0x01)
                    fun left() = cmd(0x1B, 0x61, 0x00)
                    fun bold(on: Boolean) = cmd(0x1B, 0x45, if (on) 1 else 0)
                    fun row(label: String, value: String) = line(twoCol(label, value))

                    cmd(0x1B, 0x40)
                    center(); bold(true)
                    line(fit(businessName.uppercase(), COLS))
                    cmd(0x1D, 0x21, 0x11)
                    line(kind.uppercase())
                    cmd(0x1D, 0x21, 0x00)
                    bold(false)
                    line("=".repeat(COLS))
                    left()
                    if (businessDate.isNotBlank()) row("Dia", businessDate)
                    if (openedAt.isNotBlank()) row("Inicio", formatIso(openedAt))
                    if (closedAt.isNotBlank()) row("Cierre", formatIso(closedAt))
                    line("-".repeat(COLS))
                    row("Pedidos", summary.optInt("orderCount", 0).toString())
                    bold(true)
                    row("Total vendido", formatMoney(summary.optDouble("total", 0.0)))
                    bold(false)
                    row("Efectivo", formatMoney(summary.optDouble("cash", 0.0)))
                    row("Electronico", formatMoney(summary.optDouble("electronic", 0.0)))
                    row("Pago a definir", formatMoney(summary.optDouble("undefinedPayment", 0.0)))
                    row("Retiro", formatMoney(summary.optDouble("pickup", 0.0)))
                    row("Delivery", formatMoney(summary.optDouble("delivery", 0.0)))
                    row("WhatsApp", formatMoney(summary.optDouble("whatsapp", 0.0)))
                    row("Tablet", formatMoney(summary.optDouble("tablet", 0.0)))

                    if (products != null && products.length() > 0) {
                        line("=".repeat(COLS))
                        bold(true); line("PRODUCTOS VENDIDOS"); bold(false)
                        for (i in 0 until products.length()) {
                            val p = products.getJSONObject(i)
                            val qty = p.optInt("qty", 0)
                            val name = p.optString("name", "Producto")
                            val total = p.optDouble("total", 0.0)
                            wrap("$qty x $name", COLS).forEach { line(it) }
                            line("    ${formatMoney(total)}")
                        }
                    }

                    line("=".repeat(COLS))
                    center(); line("TBE PEDIDOS")
                    cmd(0x1B, 0x64, 0x05)
                    cmd(0x1D, 0x56, 0x00)
                    out.flush()
                }
            } catch (e: Exception) {
                showToast("Error imprimiendo caja: ${e.message}")
            }
        }
    }

    private fun withPrinter(block: (BufferedOutputStream) -> Unit) {
        val ip = prefs.getString("ip", DEFAULT_IP) ?: DEFAULT_IP
        val port = prefs.getInt("port", DEFAULT_PORT)
        openPrinterSocket(ip, port, 4000).use { sock ->
            BufferedOutputStream(sock.getOutputStream(), 16 * 1024).use { out -> block(out) }
        }
    }

    private fun getWifiNetwork(): Network? {
        return try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.allNetworks.firstOrNull { n ->
                val caps = cm.getNetworkCapabilities(n)
                caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            }
        } catch (_: Exception) { null }
    }

    private fun openPrinterSocket(ip: String, port: Int, timeoutMs: Int): Socket {
        val wifi = getWifiNetwork()
        val socket = if (wifi != null) wifi.socketFactory.createSocket() as Socket else Socket()
        socket.tcpNoDelay = true
        socket.soTimeout = 8000
        socket.connect(InetSocketAddress(ip, port), timeoutMs)
        return socket
    }

    private fun safe(s: String): String = s
        .replace('á','a').replace('Á','A').replace('é','e').replace('É','E')
        .replace('í','i').replace('Í','I').replace('ó','o').replace('Ó','O')
        .replace('ú','u').replace('Ú','U').replace('ü','u').replace('Ü','U')
        .replace('ñ','n').replace('Ñ','N')
        .replace(Regex("[^\\u0020-\\u007E]"), "")

    private fun fit(s: String, n: Int): String = if (safe(s).length <= n) safe(s) else safe(s).take(n)

    private fun wrap(text: String, width: Int): List<String> {
        val words = safe(text).trim().split(Regex("\\s+"))
        val out = mutableListOf<String>()
        var line = ""
        for (w in words) {
            if (w.length > width) {
                if (line.isNotBlank()) { out.add(line); line = "" }
                w.chunked(width).forEach { out.add(it) }
            } else if (line.isEmpty()) line = w
            else if (line.length + 1 + w.length <= width) line += " $w"
            else { out.add(line); line = w }
        }
        if (line.isNotBlank()) out.add(line)
        return if (out.isEmpty()) listOf("") else out
    }

    private fun twoCol(label: String, value: String): String {
        val l = safe(label).trim()
        val r = safe(value).trim()
        val room = (COLS - r.length - 1).coerceAtLeast(1)
        val lf = fit(l, room)
        val spaces = (COLS - lf.length - r.length).coerceAtLeast(1)
        return lf + " ".repeat(spaces) + r
    }

    private fun paymentLabel(v: String): String = when (v) {
        "EFECTIVO" -> "EFECTIVO"
        "ELECTRONICO" -> "ELECTRONICO"
        else -> "A DEFINIR"
    }

    private fun formatIso(v: String): String {
        return try {
            Instant.parse(v).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm"))
        } catch (_: Exception) {
            v.replace('T', ' ').replace("Z", "").take(19)
        }
    }

    private fun formatTimeIso(v: String): String {
        return try {
            Instant.parse(v).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm"))
        } catch (_: Exception) {
            v.replace('T', ' ').replace("Z", "").takeLast(8).take(5)
        }
    }

    private fun formatMoney(v: Double): String {
        val nf = NumberFormat.getNumberInstance(Locale("es", "AR"))
        nf.maximumFractionDigits = 0
        return "$ " + nf.format(v)
    }

    private fun showToast(msg: String) {
        (ctx as? Activity)?.runOnUiThread { Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show() }
    }
}
