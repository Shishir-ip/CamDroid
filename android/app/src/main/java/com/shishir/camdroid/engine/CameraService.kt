package com.shishir.camdroid.engine

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.shishir.camdroid.MainActivity
import com.shishir.camdroid.R
import com.shishir.camdroid.admin.LockAdmin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service (type=camera) that owns the streaming engine.
 * Holds partial wake + wifi locks so the camera keeps running with the screen off.
 */
class CameraService : LifecycleService() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var started = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_LOCK -> {
                lockScreen()
                return START_STICKY
            }
        }
        if (!started) {
            started = true
            ServiceCompat.startForeground(
                this, NOTIF_ID, buildNotification("Starting camera…"),
                if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0
            )
            acquireLocks()
            CameraEngine.start(this, this)
            observeStats()
        }
        return START_STICKY
    }

    private fun observeStats() {
        lifecycleScope.launch {
            var lastUpdate = 0L
            CameraEngine.state.collect { s ->
                val now = System.currentTimeMillis()
                if (now - lastUpdate < 2000) return@collect
                lastUpdate = now
                if (!s.running) return@collect
                val text = "${s.width}×${s.height} · ${s.fps} fps · ${s.clients} viewer" +
                    if (s.clients == 1) "" else "s"
                val nm = getSystemService(NotificationManager::class.java)
                nm.notify(NOTIF_ID, buildNotification(text))
            }
        }
    }

    private fun buildNotification(text: String): android.app.Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, CameraService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val lock = PendingIntent.getService(
            this, 2, Intent(this, CameraService::class.java).setAction(ACTION_LOCK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_camdroid)
            .setContentTitle("CamDroid is streaming")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop", stop)
        if (isAdminActive()) {
            builder.addAction(0, "Lock screen", lock)
        }
        return builder.build()
    }

    private fun lockScreen() {
        try {
            val dpm = getSystemService(DevicePolicyManager::class.java)
            if (dpm.isAdminActive(ComponentName(this, LockAdmin::class.java))) {
                dpm.lockNow()
            }
        } catch (_: Exception) {}
    }

    private fun isAdminActive(): Boolean = try {
        getSystemService(DevicePolicyManager::class.java)
            .isAdminActive(ComponentName(this, LockAdmin::class.java))
    } catch (_: Exception) { false }

    private fun acquireLocks() {
        try {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "camdroid:stream").apply {
                setReferenceCounted(false)
                acquire(12 * 60 * 60 * 1000L)
            }
            val wm = getSystemService(WifiManager::class.java)
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "camdroid:wifi").apply {
                setReferenceCounted(false)
                acquire()
            }
            multicastLock = wm.createMulticastLock("camdroid:mdns").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {}
    }

    private fun releaseLocks() {
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        try { multicastLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        wakeLock = null; wifiLock = null; multicastLock = null
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL_ID, "Streaming", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while CamDroid streams to your PC"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        CameraEngine.stop()
        releaseLocks()
        started = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    companion object {
        const val ACTION_STOP = "com.shishir.camdroid.STOP"
        const val ACTION_LOCK = "com.shishir.camdroid.LOCK"
        const val CHANNEL_ID = "camdroid_stream"
        const val NOTIF_ID = 42

        fun start(context: Context) {
            val intent = Intent(context, CameraService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, CameraService::class.java).setAction(ACTION_STOP))
        }
    }
}