package com.shishir.camdroid.engine

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build

/** Registers _camdroid._tcp. so the Windows app discovers the phone automatically. */
class Discovery(private val context: Context) {

    private val nsd = context.getSystemService(NsdManager::class.java)
    private var listener: NsdManager.RegistrationListener? = null

    fun register(port: Int) {
        val name = "CamDroid-${Build.MODEL}".replace(Regex("[^A-Za-z0-9-]"), "-").take(60)
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = "_camdroid._tcp."
            this.port = port
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {}
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        }
        listener = l
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (_: Exception) {}
    }

    fun unregister() {
        try {
            listener?.let { nsd.unregisterService(it) }
        } catch (_: Exception) {}
        listener = null
    }
}