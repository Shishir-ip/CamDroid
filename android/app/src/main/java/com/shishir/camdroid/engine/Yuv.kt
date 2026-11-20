package com.shishir.camdroid.engine

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageProxy
import java.io.ByteArrayOutputStream

/** YUV_420_888 -> NV21 -> JPEG. Handles pixelStride 1 and 2 (semi-planar) layouts. */
object Yuv {

    fun toJpeg(image: ImageProxy, quality: Int): ByteArray = toJpegRotated(image, quality, 0)

    /** Encodes with an explicit clockwise rotation (0/90/180/270) applied to the NV21 buffer. */
    fun toJpegRotated(image: ImageProxy, quality: Int, rotation: Int): ByteArray {
        val w = image.width
        val h = image.height
        var nv21 = toNv21(image)
        var rw = w
        var rh = h
        val rot = ((rotation % 360) + 360) % 360
        if (rot != 0) {
            nv21 = rotateNv21(nv21, w, h, rot)
            if (rot % 180 != 0) { rw = h; rh = w }
        }
        val yuv = YuvImage(nv21, ImageFormat.NV21, rw, rh, null)
        val out = ByteArrayOutputStream(nv21.size / 4)
        yuv.compressToJpeg(Rect(0, 0, rw, rh), quality, out)
        return out.toByteArray()
    }

    /** Rotates a tightly packed NV21 buffer clockwise by 90/180/270 degrees. */
    fun rotateNv21(src: ByteArray, w: Int, h: Int, degrees: Int): ByteArray {
        if (degrees == 0) return src
        val ySize = w * h
        val out = ByteArray(src.size)
        val cw = w / 2
        val ch = h / 2
        when (degrees) {
            180 -> {
                for (r in 0 until h) {
                    val sRow = (h - 1 - r) * w
                    val dRow = r * w
                    for (c in 0 until w) out[dRow + c] = src[sRow + (w - 1 - c)]
                }
                val pairs = ySize / 4
                for (i in 0 until pairs) {
                    val s = ySize + (pairs - 1 - i) * 2
                    val d = ySize + i * 2
                    out[d] = src[s]; out[d + 1] = src[s + 1]
                }
            }
            90 -> {
                val nw = h
                for (y in 0 until h) {
                    val sRow = y * w
                    for (x in 0 until w) out[x * nw + (h - 1 - y)] = src[sRow + x]
                }
                for (cy in 0 until ch) for (cx in 0 until cw) {
                    val s = ySize + (cy * cw + cx) * 2
                    val d = ySize + (cx * ch + (ch - 1 - cy)) * 2
                    out[d] = src[s]; out[d + 1] = src[s + 1]
                }
            }
            270 -> {
                val nw = h
                for (y in 0 until h) {
                    val sRow = y * w
                    for (x in 0 until w) out[(w - 1 - x) * nw + y] = src[sRow + x]
                }
                for (cy in 0 until ch) for (cx in 0 until cw) {
                    val s = ySize + (cy * cw + cx) * 2
                    val d = ySize + ((cw - 1 - cx) * ch + cy) * 2
                    out[d] = src[s]; out[d + 1] = src[s + 1]
                }
            }
        }
        return out
    }

    private fun toNv21(image: ImageProxy): ByteArray {
        val w = image.width
        val h = image.height
        val ySize = w * h
        val nv21 = ByteArray(ySize + ySize / 2)

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]

        // Y plane
        val yBuffer = yPlane.buffer
        if (yPlane.rowStride == w && yPlane.pixelStride == 1) {
            yBuffer.get(nv21, 0, ySize)
        } else {
            val row = ByteArray(yPlane.rowStride)
            var pos = 0
            for (r in 0 until h) {
                yBuffer.position(r * yPlane.rowStride)
                val toRead = minOf(yPlane.rowStride, yBuffer.remaining())
                yBuffer.get(row, 0, toRead)
                System.arraycopy(row, 0, nv21, pos, w)
                pos += w
            }
        }

        // VU interleaved (NV21). CameraX YUV_420_888 usually has pixelStride 2 for chroma.
        val chromaH = h / 2
        val chromaW = w / 2
        val vBuffer = vPlane.buffer
        val uBuffer = uPlane.buffer
        val vRowStride = vPlane.rowStride
        val uRowStride = uPlane.rowStride
        val vPixelStride = vPlane.pixelStride
        val uPixelStride = uPlane.pixelStride

        if (vPixelStride == 2 && uPixelStride == 2 && vRowStride == w) {
            // Fast path: V plane already contains interleaved VU pairs.
            vBuffer.get(nv21, ySize, minOf(vBuffer.remaining(), ySize / 2))
        } else {
            var pos = ySize
            val vRow = ByteArray(vRowStride)
            val uRow = ByteArray(uRowStride)
            for (r in 0 until chromaH) {
                vBuffer.position(r * vRowStride)
                vBuffer.get(vRow, 0, minOf(vRowStride, vBuffer.remaining()))
                uBuffer.position(r * uRowStride)
                uBuffer.get(uRow, 0, minOf(uRowStride, uBuffer.remaining()))
                for (c in 0 until chromaW) {
                    nv21[pos++] = vRow[c * vPixelStride]
                    nv21[pos++] = uRow[c * uPixelStride]
                }
            }
        }
        return nv21
    }
}