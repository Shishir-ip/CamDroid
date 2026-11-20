package com.shishir.camdroid.ui

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.SettingsBrightness
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.shishir.camdroid.admin.LockAdmin
import com.shishir.camdroid.engine.CameraEngine

@Composable
fun SettingsScreen(themeMode: String, onTheme: (String) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var adminActive by remember { mutableStateOf(isAdminActive(context)) }
    val lifecycle = LocalLifecycleOwner.current
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) adminActive = isAdminActive(context)
        }
        lifecycle.lifecycle.addObserver(obs)
        onDispose { lifecycle.lifecycle.removeObserver(obs) }
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
    ) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back")
            }
            Spacer(Modifier.width(4.dp))
            Text("Settings", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(12.dp))

        // Appearance
        SettingsCard {
            SectionLabel("Appearance")
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ThemeChip("System", Icons.Rounded.SettingsBrightness, themeMode == "system") { onTheme("system") }
                ThemeChip("Dark", Icons.Rounded.DarkMode, themeMode == "dark") { onTheme("dark") }
                ThemeChip("Light", Icons.Rounded.LightMode, themeMode == "light") { onTheme("light") }
            }
        }
        Spacer(Modifier.height(12.dp))

        // Lock control
        SettingsCard {
            SectionLabel("Screen lock control")
            Spacer(Modifier.height(6.dp))
            Text(
                if (adminActive) "Enabled — the lock button can turn the screen off while streaming."
                else "Disabled — enable it to lock the screen without stopping the stream.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(12.dp))
            if (adminActive) {
                OutlinedButton(
                    onClick = {
                        try {
                            context.getSystemService(DevicePolicyManager::class.java)
                                .removeActiveAdmin(ComponentName(context, LockAdmin::class.java))
                            adminActive = false
                        } catch (_: Exception) {}
                    },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Disable lock control") }
            } else {
                Button(
                    onClick = {
                        try {
                            context.startActivity(
                                Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                                    putExtra(
                                        DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                                        ComponentName(context, LockAdmin::class.java)
                                    )
                                    putExtra(
                                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                                        "CamDroid uses this only to turn the screen off while the camera keeps streaming."
                                    )
                                }
                            )
                        } catch (_: Exception) {}
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Rounded.Lock, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Enable lock control")
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        // Streaming defaults
        SettingsCard {
            SectionLabel("Streaming")
            Spacer(Modifier.height(6.dp))
            Text(
                "Resolution, aspect ratio, orientation, frame rate and quality are controlled from the CamDroid app on your PC.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(12.dp))
            val engineState by CameraEngine.state.collectAsState()
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("Keep screen on", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Switch(checked = engineState.keepScreenOn, onCheckedChange = { CameraEngine.setKeepScreenOn(it) })
            }
        }
        Spacer(Modifier.height(12.dp))

        // About
        SettingsCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Videocam, null, Modifier.size(28.dp))
                Spacer(Modifier.width(12.dp))
                Column {
                    Text("CamDroid", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text("Version 1.2.0", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.outlineVariant)
            Text(
                "Designed & built by Shishir",
                fontSize = 13.sp, fontWeight = FontWeight.Medium
            )
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = {
                    try {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/Shishir-ip/CamDroid"))
                        )
                    } catch (_: Exception) {}
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(Icons.Rounded.Code, null, Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("GitHub — source & updates")
            }
            Spacer(Modifier.height(10.dp))
            Text(
                "Your video never leaves your local network. No accounts, no cloud, no tracking.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(16.dp)) { content() }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(), fontSize = 10.sp, fontWeight = FontWeight.Bold,
        letterSpacing = 1.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun ThemeChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    onClick: () -> Unit
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, fontSize = 12.sp) },
        leadingIcon = { Icon(icon, null, Modifier.size(15.dp)) }
    )
}

private fun isAdminActive(context: Context): Boolean = try {
    context.getSystemService(DevicePolicyManager::class.java)
        .isAdminActive(ComponentName(context, LockAdmin::class.java))
} catch (_: Exception) { false }