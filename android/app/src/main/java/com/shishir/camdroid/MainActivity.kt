package com.shishir.camdroid

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.shishir.camdroid.engine.CameraEngine
import com.shishir.camdroid.engine.CameraService
import com.shishir.camdroid.ui.CamDroidTheme
import com.shishir.camdroid.ui.MainScreen
import com.shishir.camdroid.ui.SettingsScreen

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("camdroid_ui", MODE_PRIVATE)
        setContent {
            var themeMode by remember { mutableStateOf(prefs.getString("theme", "system") ?: "system") }
            val state by CameraEngine.state.collectAsState()
            var screen by remember { mutableStateOf("main") }
            val context = LocalContext.current

            var cameraGranted by remember {
                mutableStateOf(
                    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                )
            }
            val permLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestMultiplePermissions()
            ) { result ->
                cameraGranted = result[Manifest.permission.CAMERA] == true
            }

            // Auto-start streaming as soon as the app opens (seamless reconnect on PC side).
            LaunchedEffect(cameraGranted) {
                if (cameraGranted && !CameraEngine.isRunning()) {
                    CameraService.start(context)
                }
            }

            // Keep-screen-on flag follows engine state.
            DisposableEffect(state.keepScreenOn) {
                if (state.keepScreenOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            }

            CamDroidTheme(themeMode) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    if (!cameraGranted) {
                        PermissionGate {
                            val perms = mutableListOf(Manifest.permission.CAMERA)
                            if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
                            permLauncher.launch(perms.toTypedArray())
                        }
                    } else {
                        BackHandler(enabled = screen != "main") { screen = "main" }
                        AnimatedContent(
                            targetState = screen,
                            transitionSpec = {
                                (slideInHorizontally(spring()) { it / 4 } + fadeIn())
                                    .togetherWith(slideOutHorizontally(spring()) { -it / 4 } + fadeOut())
                            },
                            label = "screen"
                        ) { target ->
                            when (target) {
                                "settings" -> SettingsScreen(
                                    themeMode = themeMode,
                                    onTheme = {
                                        themeMode = it
                                        prefs.edit().putString("theme", it).apply()
                                    },
                                    onBack = { screen = "main" }
                                )
                                else -> MainScreen(onSettings = { screen = "settings" })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PermissionGate(onGrant: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            Icons.Rounded.Videocam, null,
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.onSurface
        )
        Spacer(Modifier.height(20.dp))
        Text("Camera access needed", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(
            "CamDroid uses your camera to stream video to your PC. Nothing leaves your local network.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(28.dp))
        Button(onClick = onGrant, modifier = Modifier.fillMaxWidth()) {
            Text("Grant camera permission")
        }
    }
}