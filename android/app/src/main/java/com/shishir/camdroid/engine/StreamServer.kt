package com.shishir.camdroid.engine

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.InputStream

/**
 * Tiny HTTP server: MJPEG stream + JSON control API.
 *  GET  /          -> browser test page
 *  GET  /stream    -> multipart MJPEG (lowest-latency path)
 *  GET  /snapshot  -> latest JPEG frame
 *  GET  /info      -> device + camera capabilities JSON
 *  POST /set       -> apply camera settings JSON
 */
class StreamServer(private val engine: CameraEngine, port: Int) : NanoHTTPD(port) {

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri.trimEnd('/')
        if (session.method == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, ""))
        }
        return try {
            when {
                uri == "/stream" -> {
                    engine.clientConnected()
                    val resp = newChunkedResponse(
                        Response.Status.OK,
                        "multipart/x-mixed-replace; boundary=$BOUNDARY",
                        MjpegStream(engine)
                    )
                    resp.addHeader("Cache-Control", "no-store, no-cache, must-revalidate")
                    resp.addHeader("Pragma", "no-cache")
                    cors(resp)
                }
                uri == "/snapshot" -> {
                    val jpeg = engine.latestFrame()
                    if (jpeg == null) cors(newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "no frame yet"))
                    else cors(newFixedLengthResponse(Response.Status.OK, "image/jpeg", jpeg.inputStream(), jpeg.size.toLong()))
                }
                uri == "/info" -> cors(jsonResponse(engine.infoJson()))
                uri == "/set" && session.method == Method.POST -> {
                    val files = HashMap<String, String>()
                    session.parseBody(files)
                    val body = files["postData"] ?: "{}"
                    val ok = engine.handleSet(JSONObject(body))
                    cors(jsonResponse(JSONObject().put("ok", ok)))
                }
                uri == "" || uri == "/" -> cors(
                    newFixedLengthResponse(
                        Response.Status.OK, "text/html",
                        "<html><body style='background:#000;margin:0;display:flex;align-items:center;justify-content:center;height:100vh'>" +
                        "<img src='/stream' style='max-width:100%;max-height:100%'/></body></html>"
                    )
                )
                else -> cors(newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found"))
            }
        } catch (e: Exception) {
            cors(newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.message ?: "error"))
        }
    }

    private fun jsonResponse(obj: JSONObject): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json", obj.toString())

    private fun cors(resp: Response): Response {
        resp.addHeader("Access-Control-Allow-Origin", "*")
        resp.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        resp.addHeader("Access-Control-Allow-Headers", "Content-Type")
        return resp
    }

    /** Blocking InputStream that emits one MJPEG part per fresh frame. */
    private class MjpegStream(private val engine: CameraEngine) : InputStream() {
        private var buf: ByteArray = EMPTY
        private var pos = 0
        private var lastId = -1L
        private var closed = false

        override fun read(): Int {
            val b = ByteArray(1)
            val n = read(b, 0, 1)
            return if (n <= 0) -1 else b[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (closed) return -1
            if (pos >= buf.size) {
                if (!fill()) return -1
            }
            val n = minOf(len, buf.size - pos)
            System.arraycopy(buf, pos, b, off, n)
            pos += n
            return n
        }

        private fun fill(): Boolean {
            while (!closed) {
                if (!engine.isRunning()) return false
                val frame = engine.awaitFrame(lastId, 1000) ?: continue
                lastId = engine.frameId()
                val header = "--$BOUNDARY\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.size}\r\n\r\n"
                    .toByteArray(Charsets.US_ASCII)
                buf = ByteArray(header.size + frame.size + 2)
                System.arraycopy(header, 0, buf, 0, header.size)
                System.arraycopy(frame, 0, buf, header.size, frame.size)
                buf[buf.size - 2] = '\r'.code.toByte()
                buf[buf.size - 1] = '\n'.code.toByte()
                pos = 0
                return true
            }
            return false
        }

        override fun close() {
            closed = true
            engine.clientDisconnected()
        }

        companion object {
            val EMPTY = ByteArray(0)
        }
    }

    companion object {
        const val BOUNDARY = "camdroidframe"
    }
}