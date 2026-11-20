package com.shishir.camdroid.engine

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Size
import android.view.OrientationEventListener
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.MeteringPoint
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import com.shishir.camdroid.util.Net
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

data class LensInfo(val id: String, val label: String, val facing: Int, val physicalId: String?) {
    fun key(): String = id + (physicalId?.let { "#$it" } ?: "")
}

data class EngineState(
    val running: Boolean = false,
    val error: String? = null,
    val width: Int = 1280,          // streamed output width (after orientation)
    val height: Int = 720,          // streamed output height (after orientation)
    val captureWidth: Int = 1280,   // sensor capture width (resolution setting)
    val captureHeight: Int = 720,
    val preset: String = "fhd",     // sd | hd | fhd | qhd | uhd
    val aspect: String = "16:9",    // 16:9 | 4:3
    val quality: Int = 70,
    val targetFps: Int = 30,
    val fps: Int = 0,
    val kbps: Int = 0,
    val clients: Int = 0,
    val lensId: String = "",
    val lensLabel: String = "",
    val lenses: List<LensInfo> = emptyList(),
    val resolutions: List<Size> = emptyList(),
    val torchAvailable: Boolean = false,
    val torchOn: Boolean = false,
    val zoom: Float = 1f,
    val minZoom: Float = 1f,
    val maxZoom: Float = 1f,
    val exposure: Int = 0,
    val minExposure: Int = 0,
    val maxExposure: Int = 0,
    val battery: Int = -1,
    val charging: Boolean = false,
    val thermal: Int = 0,
    val orientation: String = "auto",   // auto | portrait | landscape
    val latencyMode: String = "normal", // normal | minimal | auto
    val ip: String = "",
    val port: Int = 8765,
    val startedAt: Long = 0L,
    val keepScreenOn: Boolean = false
)

/**
 * Singleton camera + streaming engine. Lives in the foreground service so the
 * stream survives screen-off, app swipe-away and activity recreation.
 *
 * Orientation is computed from the physical device sensor (works with the
 * screen off) and applied to the NV21 buffer before JPEG encoding:
 *   auto      -> upright relative to how the phone is held (upright = vertical)
 *   portrait  -> always vertical output
 *   landscape -> always horizontal output
 *
 * Latency modes:
 *   normal  -> user-chosen resolution / quality / fps
 *   minimal -> 640x480, quality 55, 24 fps (lowest latency + least heat)
 *   auto    -> normal, stepping down to minimal when the device gets hot or
 *              the battery is low, and recovering when it cools / charges.
 */
@androidx.annotation.OptIn(androidx.camera.camera2.interop.ExperimentalCamera2Interop::class)
object CameraEngine {

    val state = MutableStateFlow(EngineState())

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val analysisExecutor = Executors.newSingleThreadExecutor()

    private var appContext: Context? = null
    private var owner: LifecycleOwner? = null
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var analysis: ImageAnalysis? = null
    private var preview: Preview? = null
    private var surfaceProvider: Preview.SurfaceProvider? = null
    private var server: StreamServer? = null
    private var discovery: Discovery? = null

    @Volatile private var running = false
    private var currentLens: LensInfo? = null

    // User ("normal" mode) settings vs effective settings.
    private var userPreset = "fhd"
    private var userAspect = "16:9"
    private var userResW = 1280
    private var userResH = 720
    private var userQuality = 70
    private var userFps = 30
    private var resW = 1280
    private var resH = 720
    private var quality = 70
    private var targetFps = 30
    private var deviceSizes: List<Size> = emptyList()

    private var orientationMode = "auto"
    private var latencyMode = "normal"
    private var autoDown = false
    private var thermalStatus = 0
    private var deviceOrientation = 0
    private var sensorOrientation = 90
    private var currentFacing = CameraCharacteristics.LENS_FACING_BACK
    private var orientationListener: OrientationEventListener? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    private var torchOn = false
    private var zoomVal = 1f
    private var exposureVal = 0
    private var lastEncode = 0L
    private var bindRetries = 0

    private val frameLock = ReentrantLock()
    private val frameCond = frameLock.newCondition()
    private var latestJpeg: ByteArray? = null
    private var frameCounter = 0L
    private val framesWindow = AtomicLong(0)
    private val bytesWindow = AtomicLong(0)
    private val clients = AtomicInteger(0)

    fun isRunning() = running

    // ---------------------------------------------------------------- lifecycle

    fun start(context: Context, lifecycleOwner: LifecycleOwner) {
        if (running) return
        val ctx = context.applicationContext
        appContext = ctx
        owner = lifecycleOwner
        loadPrefs(ctx)
        applyEffective(false)
        running = true
        state.update {
            it.copy(
                running = true, error = null, startedAt = System.currentTimeMillis(),
                ip = Net.lanIp(), quality = quality, targetFps = targetFps,
                orientation = orientationMode, latencyMode = latencyMode
            )
        }
        startOrientationListener(ctx)
        startThermalListener(ctx)
        scope.launch {
            try {
                val p = withContext(Dispatchers.IO) { ProcessCameraProvider.getInstance(ctx).get() }
                provider = p
                enumerateLenses(ctx, p)
                startServer()
                bind()
                startStats()
                discovery = Discovery(ctx).also { it.register(state.value.port) }
            } catch (e: Exception) {
                state.update { it.copy(error = e.message ?: "Camera init failed") }
            }
        }
    }

    fun stop() {
        if (!running) return
        running = false
        try { provider?.unbindAll() } catch (_: Exception) {}
        analysis?.clearAnalyzer()
        try { server?.stop() } catch (_: Exception) {}
        discovery?.unregister()
        server = null
        discovery = null
        camera = null
        orientationListener?.disable()
        orientationListener = null
        thermalListener?.let { l ->
            try {
                appContext?.getSystemService(PowerManager::class.java)?.removeThermalStatusListener(l)
            } catch (_: Exception) {}
        }
        thermalListener = null
        frameLock.withLock {
            latestJpeg = null
            frameCond.signalAll()
        }
        clients.set(0)
        val keep = state.value.keepScreenOn
        state.value = EngineState(
            captureWidth = resW, captureHeight = resH, quality = quality, targetFps = targetFps,
            orientation = orientationMode, latencyMode = latencyMode, keepScreenOn = keep
        )
    }

    fun attachPreview(sp: Preview.SurfaceProvider?) {
        surfaceProvider = sp
        if (running) mainHandler.post { bind() }
    }

    fun setKeepScreenOn(on: Boolean) {
        state.update { it.copy(keepScreenOn = on) }
        appContext?.let { prefs(it).edit().putBoolean("keepScreenOn", on).apply() }
    }

    // ---------------------------------------------------------------- orientation & thermal

    private fun startOrientationListener(ctx: Context) {
        val listener = object : OrientationEventListener(ctx) {
            override fun onOrientationChanged(orientation: Int) {
                if (orientation == ORIENTATION_UNKNOWN) return
                val quantized = ((orientation + 45) / 90) % 4 * 90
                deviceOrientation = quantized
            }
        }
        if (listener.canDetectOrientation()) {
            listener.enable()
            orientationListener = listener
        }
    }

    private fun startThermalListener(ctx: Context) {
        if (Build.VERSION.SDK_INT < 29) return
        try {
            val pm = ctx.getSystemService(PowerManager::class.java)
            val listener = PowerManager.OnThermalStatusChangedListener { status ->
                thermalStatus = status
                state.update { it.copy(thermal = status) }
                if (latencyMode == "auto") mainHandler.post { evaluateAuto(); applyEffective() }
            }
            pm.addThermalStatusListener(ctx.mainExecutor, listener)
            thermalListener = listener
            thermalStatus = pm.currentThermalStatus
        } catch (_: Exception) {}
    }

    /** Clockwise rotation to apply so the output matches the orientation mode. */
    private fun outputRotation(): Int {
        val base = if (currentFacing == CameraCharacteristics.LENS_FACING_FRONT)
            (sensorOrientation + deviceOrientation) % 360
        else
            (sensorOrientation - deviceOrientation + 360) % 360
        // Camera sensors are landscape: base % 180 == 0 keeps landscape dims.
        val landscapeOut = base % 180 == 0
        return when (orientationMode) {
            "portrait" -> if (landscapeOut) (base + 90) % 360 else base
            "landscape" -> if (!landscapeOut) (base + 90) % 360 else base
            else -> base
        }
    }

    // ---------------------------------------------------------------- latency modes

    private fun evaluateAuto() {
        val s = state.value
        val hot = thermalStatus >= 2 // THERMAL_STATUS_MODERATE or worse
        val lowBattery = s.battery in 0..19 && !s.charging
        val batteryRecovered = s.battery >= 25 || s.charging || s.battery < 0
        if (hot || lowBattery) autoDown = true
        else if (thermalStatus <= 1 && batteryRecovered) autoDown = false
    }

    /** Applies the effective resolution/quality/fps for the current mode. */
    private fun applyEffective(rebind: Boolean = true) {
        val minimal = latencyMode == "minimal" || (latencyMode == "auto" && autoDown)
        val target = if (minimal) Size(640, 480) else pickCaptureSize(userPreset, userAspect)
        val w = target.width
        val h = target.height
        val q = if (minimal) 55 else userQuality
        val f = if (minimal) 24 else userFps
        val resChanged = w != resW || h != resH
        resW = w; resH = h; quality = q; targetFps = f
        state.update {
            it.copy(
                quality = q, targetFps = f, captureWidth = w, captureHeight = h,
                preset = userPreset, aspect = userAspect, latencyMode = latencyMode
            )
        }
        if (rebind && resChanged && running) mainHandler.post { bind() }
    }

    // Friendly resolution presets map to a target long-edge pixel count.
    private fun presetLongEdge(p: String): Int = when (p) {
        "sd" -> 640
        "hd" -> 1280
        "fhd" -> 1920
        "qhd" -> 2560
        "uhd" -> 3840
        else -> 1920
    }

    private fun aspectRatio(a: String): Double = if (a == "4:3") 4.0 / 3.0 else 16.0 / 9.0

    /** Picks the device-supported capture size closest to the preset + aspect. */
    private fun pickCaptureSize(preset: String, aspect: String): Size {
        val long = presetLongEdge(preset)
        val ratio = aspectRatio(aspect)
        val targetW = long
        val targetH = Math.round(long / ratio).toInt()
        val targetArea = targetW.toLong() * targetH
        val sizes = deviceSizes
        if (sizes.isEmpty()) return Size(targetW, targetH)
        val matching = sizes.filter { Math.abs(it.width.toDouble() / it.height - ratio) < 0.035 }
        val pool = if (matching.isNotEmpty()) matching else sizes
        return pool.minByOrNull { Math.abs(it.width.toLong() * it.height - targetArea) }
            ?: Size(targetW, targetH)
    }

    fun setPreset(preset: String) {
        if (preset !in listOf("sd", "hd", "fhd", "qhd", "uhd")) return
        userPreset = preset
        latencyMode = "normal"
        appContext?.let { prefs(it).edit().putString("preset", preset).putString("mode", "normal").apply() }
        mainHandler.post { applyEffective() }
    }

    fun setAspect(aspect: String) {
        if (aspect !in listOf("16:9", "4:3")) return
        userAspect = aspect
        latencyMode = "normal"
        appContext?.let { prefs(it).edit().putString("aspect", aspect).putString("mode", "normal").apply() }
        mainHandler.post { applyEffective() }
    }

    fun setLatencyMode(mode: String) {
        if (mode !in listOf("normal", "minimal", "auto")) return
        latencyMode = mode
        autoDown = false
        appContext?.let { prefs(it).edit().putString("mode", mode).apply() }
        state.update { it.copy(latencyMode = mode) }
        mainHandler.post { evaluateAuto(); applyEffective() }
    }

    fun setOrientation(mode: String) {
        if (mode !in listOf("auto", "portrait", "landscape")) return
        orientationMode = mode
        appContext?.let { prefs(it).edit().putString("orientation", mode).apply() }
        state.update { it.copy(orientation = mode) }
    }

    // ---------------------------------------------------------------- camera binding

    private fun enumerateLenses(ctx: Context, p: ProcessCameraProvider) {
        val list = mutableListOf<LensInfo>()
        try {
            val cm = ctx.getSystemService(CameraManager::class.java)
            for (info in p.availableCameraInfos) {
                val c2 = Camera2CameraInfo.from(info)
                val id = c2.cameraId
                val facing = c2.getCameraCharacteristic(CameraCharacteristics.LENS_FACING)
                    ?: CameraCharacteristics.LENS_FACING_BACK
                val focal = c2.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                    ?.firstOrNull() ?: 0f
                val faceLabel = if (facing == CameraCharacteristics.LENS_FACING_FRONT) "Front" else "Back"
                list.add(LensInfo(id, "$faceLabel · ${lensTag(focal)}", facing, null))
                try {
                    val chars = cm.getCameraCharacteristics(id)
                    val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
                    if (caps != null && caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)) {
                        for (pid in chars.physicalCameraIds) {
                            val pf = cm.getCameraCharacteristics(pid)
                                .get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull() ?: 0f
                            list.add(LensInfo(id, "$faceLabel · ${lensTag(pf)} ($pid)", facing, pid))
                        }
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        if (list.isEmpty()) {
            list.add(LensInfo("0", "Back · wide", CameraCharacteristics.LENS_FACING_BACK, null))
            list.add(LensInfo("1", "Front · wide", CameraCharacteristics.LENS_FACING_FRONT, null))
        }
        currentLens = list.firstOrNull { it.facing == CameraCharacteristics.LENS_FACING_BACK && it.physicalId == null }
            ?: list.first()
        state.update { it.copy(lenses = list) }
    }

    private fun lensTag(focalMm: Float): String = when {
        focalMm <= 0f -> "wide"
        focalMm < 2.2f -> "ultra-wide"
        focalMm < 3.8f -> "wide"
        focalMm < 6.5f -> "main"
        else -> "tele"
    }

    private fun resolutionSelector(): ResolutionSelector {
        val strategy = ResolutionStrategy(
            Size(resW, resH), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
        )
        val ratio = if (resW * 3 == resH * 4) AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
        else AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
        return ResolutionSelector.Builder()
            .setResolutionStrategy(strategy)
            .setAspectRatioStrategy(ratio)
            .build()
    }

    private fun bind() {
        val p = provider ?: return
        val o = owner ?: return
        try {
            p.unbindAll()
            analysis?.clearAnalyzer()
            val lens = currentLens
            val selector = if (lens?.facing == CameraCharacteristics.LENS_FACING_FRONT)
                CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

            val usePhysical = lens?.physicalId != null
            // Rotation is applied manually from the physical device sensor so the
            // output orientation is correct even with the screen off.
            val ab = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageRotationEnabled(false)
                .setResolutionSelector(resolutionSelector())
            val pb = Preview.Builder().setResolutionSelector(resolutionSelector())
            if (usePhysical) {
                Camera2Interop.Extender(ab).setPhysicalCameraId(lens!!.physicalId!!)
                Camera2Interop.Extender(pb).setPhysicalCameraId(lens.physicalId!!)
            }
            val ia = ab.build()
            ia.setAnalyzer(analysisExecutor, analyzer)
            analysis = ia
            val pv = pb.build()
            surfaceProvider?.let { pv.setSurfaceProvider(it) }
            preview = pv

            camera = try {
                if (surfaceProvider != null) p.bindToLifecycle(o, selector, pv, ia)
                else p.bindToLifecycle(o, selector, ia)
            } catch (e: Exception) {
                if (!usePhysical) throw e
                // Physical lens binding failed -> fall back to the logical camera.
                val ab2 = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageRotationEnabled(false)
                    .setResolutionSelector(resolutionSelector())
                val ia2 = ab2.build()
                ia2.setAnalyzer(analysisExecutor, analyzer)
                analysis = ia2
                val pv2 = Preview.Builder().setResolutionSelector(resolutionSelector()).build()
                surfaceProvider?.let { pv2.setSurfaceProvider(it) }
                preview = pv2
                if (surfaceProvider != null) p.bindToLifecycle(o, selector, pv2, ia2)
                else p.bindToLifecycle(o, selector, ia2)
            }
            afterBind()
        } catch (e: Exception) {
            state.update { it.copy(error = "Bind failed: ${e.message}") }
            // Recover from transient camera failures (camera briefly busy, etc.).
            if (running && bindRetries < 5) {
                bindRetries++
                mainHandler.postDelayed({ if (running) bind() }, 800L * bindRetries)
            }
        }
    }

    private fun afterBind() {
        val cam = camera ?: return
        bindRetries = 0
        val info = cam.cameraInfo
        val c2 = Camera2CameraInfo.from(info)
        sensorOrientation = c2.getCameraCharacteristic(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        currentFacing = c2.getCameraCharacteristic(CameraCharacteristics.LENS_FACING)
            ?: CameraCharacteristics.LENS_FACING_BACK
        val zs = info.zoomState.value
        val minZ = zs?.minZoomRatio ?: 1f
        val maxZ = zs?.maxZoomRatio ?: 1f
        val curZ = zs?.zoomRatio ?: 1f
        val es = info.exposureState
        // One device-specific resolution list, never above 4K.
        val allSizes = try {
            c2.getCameraCharacteristic(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(ImageFormat.YUV_420_888)
                ?.filter {
                    it.width >= 640 && it.height >= 480 &&
                        it.width <= 3840 && it.height <= 2160 &&
                        it.width.toLong() * it.height <= 3840L * 2160L
                }
                ?.distinct()
                ?: defaultResolutions()
        } catch (_: Exception) { defaultResolutions() }
        deviceSizes = allSizes
        val resolutions = allSizes.sortedByDescending { it.width * it.height }.take(8)

        analysis?.resolutionInfo?.resolution?.let {
            resW = it.width; resH = it.height
        }
        state.update {
            it.copy(
                lensId = currentLens?.key() ?: "", lensLabel = currentLens?.label ?: "",
                torchAvailable = info.hasFlashUnit(),
                minZoom = minZ, maxZoom = maxZ,
                zoom = curZ.coerceAtLeast(minZ),
                minExposure = es.exposureCompensationRange.lower,
                maxExposure = es.exposureCompensationRange.upper,
                resolutions = resolutions,
                captureWidth = resW, captureHeight = resH, error = null
            )
        }
        zoomVal = curZ
        try { cam.cameraControl.enableTorch(torchOn && info.hasFlashUnit()) } catch (_: Exception) {}
        try { cam.cameraControl.setZoomRatio(zoomVal.coerceIn(minZ, maxZ)) } catch (_: Exception) {}
        if (es.isExposureCompensationSupported) {
            try {
                cam.cameraControl.setExposureCompensationIndex(
                    exposureVal.coerceIn(es.exposureCompensationRange.lower, es.exposureCompensationRange.upper)
                )
            } catch (_: Exception) {}
        }
    }

    private fun defaultResolutions(): List<Size> = listOf(
        Size(1920, 1080), Size(1280, 720), Size(640, 480)
    )

    // ---------------------------------------------------------------- encoding

    private val analyzer = ImageAnalysis.Analyzer { image: ImageProxy ->
        try {
            if (!running) return@Analyzer
            // No viewers: skip JPEG encoding entirely (camera + preview stay live).
            // This keeps the phone cool while idle; the first viewer gets video
            // within one frame interval of connecting.
            if (clients.get() == 0) return@Analyzer
            val now = SystemClock.elapsedRealtime()
            val minInterval = 1000L / targetFps.coerceAtLeast(1)
            if (now - lastEncode < minInterval) return@Analyzer
            lastEncode = now
            val rot = outputRotation()
            val jpeg = Yuv.toJpegRotated(image, quality, rot)
            publishFrame(jpeg)
            val outW = if (rot % 180 == 0) image.width else image.height
            val outH = if (rot % 180 == 0) image.height else image.width
            val s = state.value
            if (outW != s.width || outH != s.height) {
                state.update { it.copy(width = outW, height = outH) }
            }
        } catch (_: Exception) {
        } finally {
            image.close()
        }
    }

    private fun publishFrame(jpeg: ByteArray) {
        frameLock.withLock {
            latestJpeg = jpeg
            frameCounter++
            frameCond.signalAll()
        }
        framesWindow.incrementAndGet()
        bytesWindow.addAndGet(jpeg.size.toLong())
    }

    fun awaitFrame(lastId: Long, timeoutMs: Long): ByteArray? {
        frameLock.withLock {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (frameCounter <= lastId) {
                if (!running) return null
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return null
                frameCond.await(remaining, TimeUnit.MILLISECONDS)
            }
            return latestJpeg
        }
    }

    fun latestFrame(): ByteArray? = frameLock.withLock { latestJpeg }
    fun frameId(): Long = frameLock.withLock { frameCounter }
    fun clientConnected() { clients.incrementAndGet(); state.update { it.copy(clients = clients.get()) } }
    fun clientDisconnected() { clients.decrementAndGet(); state.update { it.copy(clients = clients.get()) } }

    // ---------------------------------------------------------------- stats

    private fun startStats() {
        scope.launch {
            var lastFrames = 0L
            var lastBytes = 0L
            while (running) {
                delay(1000)
                val f = framesWindow.get()
                val b = bytesWindow.get()
                val fps = (f - lastFrames).toInt()
                val kbps = ((b - lastBytes) * 8 / 1000).toInt()
                lastFrames = f
                lastBytes = b
                val batt = batteryInfo()
                state.update {
                    it.copy(
                        fps = fps, kbps = kbps, clients = clients.get(),
                        battery = batt.first, charging = batt.second, ip = Net.lanIp()
                    )
                }
                if (latencyMode == "auto") {
                    val before = autoDown
                    evaluateAuto()
                    if (before != autoDown) applyEffective()
                }
            }
        }
    }

    private fun batteryInfo(): Pair<Int, Boolean> {
        return try {
            val ctx = appContext ?: return -1 to false
            val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val pct = if (level >= 0) level * 100 / scale else -1
            pct to (status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        } catch (_: Exception) { -1 to false }
    }

    // ---------------------------------------------------------------- server

    private fun startServer() {
        var port = 8765
        while (port <= 8775) {
            try {
                val s = StreamServer(this, port)
                s.start()
                server = s
                state.update { it.copy(port = port) }
                return
            } catch (_: Exception) {
                port++
            }
        }
        state.update { it.copy(error = "No free port (8765-8775)") }
    }

    fun infoJson(): JSONObject {
        val s = state.value
        val lenses = JSONArray()
        for (l in s.lenses) {
            lenses.put(JSONObject().put("key", l.key()).put("id", l.id).put("label", l.label)
                .put("facing", if (l.facing == CameraCharacteristics.LENS_FACING_FRONT) "front" else "back")
                .put("physical", l.physicalId ?: JSONObject.NULL))
        }
        val resolutions = JSONArray()
        for (r in s.resolutions) resolutions.put(JSONObject().put("w", r.width).put("h", r.height))
        return JSONObject()
            .put("app", "CamDroid")
            .put("version", "1.2.0")
            .put("model", Build.MODEL)
            .put("device", Build.DEVICE)
            .put("android", Build.VERSION.RELEASE)
            .put("streaming", s.running)
            .put("ip", s.ip)
            .put("port", s.port)
            .put("width", s.width)
            .put("height", s.height)
            .put("captureWidth", s.captureWidth)
            .put("captureHeight", s.captureHeight)
            .put("preset", s.preset)
            .put("aspect", s.aspect)
            .put("quality", s.quality)
            .put("fpsTarget", s.targetFps)
            .put("fps", s.fps)
            .put("kbps", s.kbps)
            .put("clients", s.clients)
            .put("orientation", s.orientation)
            .put("latencyMode", s.latencyMode)
            .put("thermal", s.thermal)
            .put("lens", s.lensId)
            .put("lensLabel", s.lensLabel)
            .put("lenses", lenses)
            .put("resolutions", resolutions)
            .put("torchAvailable", s.torchAvailable)
            .put("torchOn", s.torchOn)
            .put("zoom", s.zoom).put("zoomMin", s.minZoom).put("zoomMax", s.maxZoom)
            .put("exposure", s.exposure).put("exposureMin", s.minExposure).put("exposureMax", s.maxExposure)
            .put("battery", s.battery)
            .put("charging", s.charging)
            .put("uptimeMs", if (s.startedAt > 0) System.currentTimeMillis() - s.startedAt else 0)
    }

    fun handleSet(json: JSONObject): Boolean {
        mainHandler.post {
            try {
                if (json.has("lens")) setLens(json.getString("lens"))
                if (json.has("torch")) setTorch(json.getBoolean("torch"))
                if (json.has("zoom")) setZoom(json.getDouble("zoom").toFloat())
                if (json.has("exposure")) setExposure(json.getInt("exposure"))
                if (json.has("orientation")) setOrientation(json.getString("orientation"))
                if (json.has("mode")) setLatencyMode(json.getString("mode"))
                if (json.has("preset")) setPreset(json.getString("preset"))
                if (json.has("aspect")) setAspect(json.getString("aspect"))
                if (json.has("width") && json.has("height")) setResolution(json.getInt("width"), json.getInt("height"))
                if (json.has("quality")) setQuality(json.getInt("quality"))
                if (json.has("fps")) setTargetFps(json.getInt("fps"))
                if (json.has("focus")) {
                    val f = json.getJSONObject("focus")
                    focusNormalized(f.getDouble("x").toFloat(), f.getDouble("y").toFloat())
                }
            } catch (_: Exception) {}
        }
        return true
    }

    // ---------------------------------------------------------------- controls

    fun setLens(key: String) {
        val lens = state.value.lenses.find { it.key() == key } ?: return
        currentLens = lens
        mainHandler.post { if (running) bind() }
    }

    fun setTorch(on: Boolean) {
        torchOn = on
        mainHandler.post {
            try { camera?.cameraControl?.enableTorch(on) } catch (_: Exception) {}
            state.update { it.copy(torchOn = on) }
        }
    }

    fun setZoom(v: Float) {
        zoomVal = v
        mainHandler.post {
            try { camera?.cameraControl?.setZoomRatio(v) } catch (_: Exception) {}
            state.update { it.copy(zoom = v) }
        }
    }

    fun setExposure(v: Int) {
        exposureVal = v
        mainHandler.post {
            try { camera?.cameraControl?.setExposureCompensationIndex(v) } catch (_: Exception) {}
            state.update { it.copy(exposure = v) }
        }
    }

    // Manual changes take over from Minimal/Auto (switch back to Normal).
    fun setResolution(w: Int, h: Int) {
        if (w > 3840 || h > 2160 || w.toLong() * h > 3840L * 2160L) return
        userResW = w; userResH = h
        latencyMode = "normal"
        appContext?.let { prefs(it).edit().putInt("resW", w).putInt("resH", h).putString("mode", "normal").apply() }
        mainHandler.post { applyEffective() }
    }

    fun setQuality(q: Int) {
        userQuality = q.coerceIn(10, 95)
        latencyMode = "normal"
        appContext?.let { prefs(it).edit().putInt("quality", userQuality).putString("mode", "normal").apply() }
        mainHandler.post { applyEffective() }
    }

    fun setTargetFps(f: Int) {
        userFps = f.coerceIn(5, 60)
        latencyMode = "normal"
        appContext?.let { prefs(it).edit().putInt("fps", userFps).putString("mode", "normal").apply() }
        mainHandler.post { applyEffective() }
    }

    fun focus(point: MeteringPoint) {
        mainHandler.post {
            try {
                val action = FocusMeteringAction.Builder(
                    point,
                    FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB
                ).setAutoCancelDuration(3, TimeUnit.SECONDS).build()
                camera?.cameraControl?.startFocusAndMetering(action)
            } catch (_: Exception) {}
        }
    }

    fun focusNormalized(x: Float, y: Float) {
        val factory = SurfaceOrientedMeteringPointFactory(resW.toFloat(), resH.toFloat())
        focus(factory.createPoint(x * resW, y * resH))
    }

    // ---------------------------------------------------------------- prefs

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("camdroid", Context.MODE_PRIVATE)

    private fun loadPrefs(ctx: Context) {
        val p = prefs(ctx)
        userPreset = p.getString("preset", "fhd") ?: "fhd"
        userAspect = p.getString("aspect", "16:9") ?: "16:9"
        userResW = p.getInt("resW", 1280)
        userResH = p.getInt("resH", 720)
        userQuality = p.getInt("quality", 70)
        userFps = p.getInt("fps", 30)
        orientationMode = p.getString("orientation", "auto") ?: "auto"
        latencyMode = p.getString("mode", "normal") ?: "normal"
        state.update { it.copy(keepScreenOn = p.getBoolean("keepScreenOn", false)) }
    }
}