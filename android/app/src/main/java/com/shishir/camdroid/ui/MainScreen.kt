@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.shishir.camdroid.ui

import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.FlashlightOff
import androidx.compose.material.icons.rounded.FlashlightOn
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.QrCode2
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.material.icons.rounded.Usb
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.camera.view.PreviewView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.shishir.camdroid.admin.LockAdmin
import com.shishir.camdroid.engine.CameraEngine
import com.shishir.camdroid.engine.CameraService
import com.shishir.camdroid.engine.EngineState
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

@Composable
fun MainScreen(onSettings: () -> Unit) {
    val state by CameraEngine.state.collectAsState()
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var showQr by remember { mutableStateOf(false) }
    var previewView by remember { mutableStateOf<PreviewView?>(null) }
    var focusPoint by remember { mutableStateOf<Offset?>(null) }
    var focusTick by remember { mutableStateOf(0L) }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
    ) {
        Spacer(Modifier.height(8.dp))
        TopBar(state, onSettings) { CameraService.stop(context) }
        Spacer(Modifier.height(12.dp))

        // ------------------------------------------------ preview
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(RoundedCornerShape(24.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            if (state.running) {
                AndroidView(
                    factory = { ctx ->
                        PreviewView(ctx).apply {
                            scaleType = PreviewView.ScaleType.FILL_CENTER
                            previewView = this
                            CameraEngine.attachPreview(surfaceProvider)
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                    onRelease = { CameraEngine.attachPreview(null) }
                )
                Box(
                    Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTapGestures { off ->
                                focusPoint = off
                                focusTick = System.currentTimeMillis()
                                previewView?.meteringPointFactory
                                    ?.createPoint(off.x, off.y)
                                    ?.let { CameraEngine.focus(it) }
                            }
                        }
                        .pointerInput(Unit) {
                            detectTransformGestures { _, _, zoom, _ ->
                                val s = CameraEngine.state.value
                                CameraEngine.setZoom((s.zoom * zoom).coerceIn(s.minZoom, s.maxZoom))
                            }
                        }
                )
                FocusRing(focusPoint, focusTick)
                Row(
                    Modifier.align(Alignment.TopStart).padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    OverlayChip("${state.width}×${state.height}")
                    OverlayChip("${state.fps} fps")
                }
                Row(Modifier.align(Alignment.TopEnd).padding(12.dp)) {
                    OverlayChip("${state.clients}", icon = {
                        Icon(Icons.Rounded.Person, null, Modifier.size(12.dp), tint = Color.White)
                    })
                }
                Row(Modifier.align(Alignment.BottomStart).padding(12.dp)) {
                    OverlayChip(state.lensLabel.ifEmpty { "Camera" })
                }
                if (state.torchAvailable) {
                    Surface(
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            CameraEngine.setTorch(!state.torchOn)
                        },
                        shape = CircleShape,
                        color = if (state.torchOn) Color.White else Color.Black.copy(alpha = 0.45f),
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp).size(44.dp)
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                if (state.torchOn) Icons.Rounded.FlashlightOn else Icons.Rounded.FlashlightOff,
                                null,
                                tint = if (state.torchOn) Color.Black else Color.White,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                }
            } else {
                Column(
                    Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    if (state.error != null) {
                        Text(state.error!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    } else {
                        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.height(12.dp))
                        Text("Starting camera…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        StatsRow(state)
        Spacer(Modifier.height(12.dp))
        ConnectionCard(state, showQr) { showQr = !showQr }
        Spacer(Modifier.height(12.dp))
        StatusCard(state)
        Spacer(Modifier.height(12.dp))
        LockSection()
        Spacer(Modifier.height(28.dp))
    }
}

// ------------------------------------------------------------------ top bar

@Composable
private fun TopBar(state: EngineState, onSettings: () -> Unit, onStop: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Videocam, null, Modifier.size(24.dp))
        Spacer(Modifier.width(8.dp))
        Text("CamDroid", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        LivePill(state.running)
        Spacer(Modifier.weight(1f))
        if (state.running) {
            IconButton(onClick = onStop) {
                Icon(Icons.Rounded.StopCircle, "Stop streaming", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        IconButton(onClick = onSettings) {
            Icon(Icons.Rounded.Settings, "Settings", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun LivePill(live: Boolean) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 1f, targetValue = 0.25f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "alpha"
    )
    Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceVariant) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(if (live) LiveGreen.copy(alpha = alpha) else MaterialTheme.colorScheme.outline)
            )
            Spacer(Modifier.width(6.dp))
            Text(
                if (live) "LIVE" else "OFF",
                fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
                color = if (live) LiveGreen else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

// ------------------------------------------------------------------ preview helpers

@Composable
private fun OverlayChip(text: String, icon: (@Composable () -> Unit)? = null) {
    Surface(shape = RoundedCornerShape(50), color = Color.Black.copy(alpha = 0.45f)) {
        Row(
            Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            icon?.invoke()
            Text(text, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun FocusRing(point: Offset?, tick: Long) {
    val anim = remember { Animatable(0f) }
    LaunchedEffect(tick) {
        if (tick > 0) {
            anim.snapTo(1f)
            anim.animateTo(0f, tween(800))
        }
    }
    if (point != null && anim.value > 0.01f) {
        Box(
            Modifier
                .offset { IntOffset((point.x - 36).roundToInt(), (point.y - 36).roundToInt()) }
                .size(72.dp)
                .border(2.dp, Color.White.copy(alpha = anim.value), CircleShape)
        )
    }
}

// ------------------------------------------------------------------ stats

@Composable
private fun StatsRow(state: EngineState) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.running) {
        while (state.running) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val upSec = if (state.startedAt > 0) ((now - state.startedAt) / 1000).coerceAtLeast(0) else 0
    val uptime = "%02d:%02d".format(upSec / 60, upSec % 60)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatTile(Modifier.weight(1f), "${state.fps}", "FPS")
        StatTile(Modifier.weight(1f), "%.1f".format(state.kbps / 1000f), "MBIT/S")
        StatTile(Modifier.weight(1f), if (state.battery >= 0) "${state.battery}%" else "—", "BATTERY")
        StatTile(Modifier.weight(1f), uptime, "UPTIME")
    }
}

@Composable
private fun StatTile(modifier: Modifier, value: String, label: String) {
    Surface(modifier = modifier, shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(2.dp))
            Text(label, fontSize = 9.sp, letterSpacing = 1.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// ------------------------------------------------------------------ connection

@Composable
private fun ConnectionCard(state: EngineState, showQr: Boolean, onQr: () -> Unit) {
    val context = LocalContext.current
    val url = "http://${state.ip}:${state.port}"
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Wifi, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Wi-Fi", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(url, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("CamDroid", url))
                }) { Icon(Icons.Rounded.ContentCopy, "Copy", Modifier.size(18.dp)) }
                IconButton(onClick = onQr) { Icon(Icons.Rounded.QrCode2, "QR", Modifier.size(20.dp)) }
            }
            AnimatedVisibility(visible = showQr) {
                Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
                    Surface(color = Color.White, shape = RoundedCornerShape(12.dp)) {
                        androidx.compose.foundation.Image(
                            qrImage(url, 480), null,
                            Modifier.padding(10.dp).size(170.dp)
                        )
                    }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outlineVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Usb, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Column {
                    Text("USB", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Plug in the cable — the Windows app connects automatically",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

// ------------------------------------------------------------------ status (read-only)

@Composable
private fun StatusCard(state: EngineState) {
    // Label reflects the ACTUAL capture size (the device may fall back below the requested preset).
    val longEdge = maxOf(state.captureWidth, state.captureHeight)
    val presetLabel = when {
        longEdge >= 3840 -> "UHD"; longEdge >= 2560 -> "QHD"; longEdge >= 1920 -> "Full HD"; longEdge >= 1280 -> "HD"; else -> "SD"
    }
    val orientLabel = when (state.orientation) {
        "portrait" -> "Portrait"; "landscape" -> "Landscape"; else -> "Auto"
    }
    val modeLabel = when (state.latencyMode) {
        "minimal" -> "Minimal"; "auto" -> "Auto"; else -> "Normal"
    }
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(16.dp)) {
            Text(
                "STREAM STATUS", fontSize = 10.sp, fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(10.dp))
            InfoRow("Camera", state.lensLabel.ifEmpty { "—" })
            InfoRow("Resolution", "$presetLabel · ${state.captureWidth}×${state.captureHeight}")
            InfoRow("Aspect ratio", state.aspect)
            InfoRow("Orientation", orientLabel)
            InfoRow("Latency mode", modeLabel)
            InfoRow("Output", "${state.width}×${state.height} @ ${state.fps} fps")
            InfoRow("Quality", "${state.quality}%")
            Spacer(Modifier.height(10.dp))
            Text(
                "Adjust these from the CamDroid app on your PC.",
                fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ------------------------------------------------------------------ lock

@Composable
private fun LockSection() {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var adminActive by remember { mutableStateOf(isAdminActive(context)) }
    val lifecycle = LocalLifecycleOwner.current
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) adminActive = isAdminActive(context)
        }
        lifecycle.lifecycle.addObserver(obs)
        onDispose { lifecycle.lifecycle.removeObserver(obs) }
    }

    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(16.dp)) {
            if (adminActive) {
                Button(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        try {
                            context.getSystemService(DevicePolicyManager::class.java).lockNow()
                        } catch (_: Exception) {}
                    },
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Icon(Icons.Rounded.Lock, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Lock screen · keep streaming", fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "The screen really turns off. The camera keeps streaming with zero interruption.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                Button(
                    onClick = {
                        try {
                            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                                putExtra(
                                    DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                                    ComponentName(context, LockAdmin::class.java)
                                )
                                putExtra(
                                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                                    "CamDroid uses this only to turn the screen off while the camera keeps streaming."
                                )
                            }
                            context.startActivity(intent)
                        } catch (_: Exception) {}
                    },
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Icon(Icons.Rounded.Lock, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Enable lock control", fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "One-time permission. Lets the lock button turn the screen off while streaming continues.",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

private fun isAdminActive(context: Context): Boolean = try {
    context.getSystemService(DevicePolicyManager::class.java)
        .isAdminActive(ComponentName(context, LockAdmin::class.java))
} catch (_: Exception) { false }