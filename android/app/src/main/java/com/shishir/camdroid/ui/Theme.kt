package com.shishir.camdroid.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val LiveGreen = Color(0xFF22C55E)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFF5F5F7),
    onPrimary = Color(0xFF0A0A0B),
    secondary = LiveGreen,
    background = Color(0xFF000000),
    onBackground = Color(0xFFF5F5F7),
    surface = Color(0xFF0E0E10),
    onSurface = Color(0xFFF5F5F7),
    surfaceVariant = Color(0xFF17171A),
    onSurfaceVariant = Color(0xFFA1A1AA),
    outline = Color(0xFF2A2A2E),
    outlineVariant = Color(0xFF1F1F23),
    error = Color(0xFFF87171)
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF0A0A0B),
    onPrimary = Color(0xFFFFFFFF),
    secondary = Color(0xFF16A34A),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF0A0A0B),
    surface = Color(0xFFF6F6F7),
    onSurface = Color(0xFF0A0A0B),
    surfaceVariant = Color(0xFFECECEE),
    onSurfaceVariant = Color(0xFF52525B),
    outline = Color(0xFFD4D4D8),
    outlineVariant = Color(0xFFE4E4E7),
    error = Color(0xFFDC2626)
)

@Composable
fun CamDroidTheme(themeMode: String, content: @Composable () -> Unit) {
    val dark = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        content = content
    )
}