package com.shishir.camdroid.util

import java.net.Inet4Address
import java.net.NetworkInterface

object Net {
    /** Best-effort LAN IPv4 (prefers wlan0). */
    fun lanIp(): String {
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces().toList()
            val candidates = mutableListOf<Pair<Int, String>>()
            for (iface in ifaces) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.inetAddresses) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) {
                        val score = when {
                            iface.name.startsWith("wlan") -> 0
                            iface.name.startsWith("eth") -> 1
                            else -> 2
                        }
                        val address = addr.hostAddress ?: continue
                        candidates.add(score to address)
                    }
                }
            }
            return candidates.minByOrNull { it.first }?.second ?: "127.0.0.1"
        } catch (_: Exception) {
            return "127.0.0.1"
        }
    }
}