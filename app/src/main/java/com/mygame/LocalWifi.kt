package com.mygame

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class LocalWifi(
    private val context: Context,
    private val listener: Listener
) {

    interface Listener {
        fun onDeviceFound(device: Device)
        fun onDeviceLost(name: String)
        fun onMessage(json: String)
        fun onLog(message: String)
    }

    data class Device(
        val name: String,
        val host: String,
        val port: Int
    )

    enum class Role {
        NONE,
        HOST,
        CLIENT
    }

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val serviceType = "_babyloncar._tcp."

    var role: Role = Role.NONE
        private set

    var myId: String = UUID.randomUUID().toString()
    var myName: String = Build.MODEL.replace(" ", "_")

    private var serverSocket: ServerSocket? = null
    private var hostSocket: Socket? = null

    private class ClientInfo(
        val socket: Socket,
        var id: String = "",
        var name: String = ""
    )

    private val clients = CopyOnWriteArrayList<ClientInfo>()

    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    private val seen = mutableSetOf<String>()

    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private val resolveLock = Object()
    private var resolving = false

    private var running = false

    fun setMyId(id: String) {
        myId = id
    }

    fun setMyName(name: String) {
        myName = name
    }

    fun startHost(port: Int = 47900) {
        stop()
        running = true
        role = Role.HOST

        try {
            val server = ServerSocket(port)
            serverSocket = server

            registerService(myName, server.localPort)

            thread(name = "HostAcceptThread") {
                while (running && !server.isClosed) {
                    try {
                        val socket = server.accept()
                        val client = ClientInfo(socket)
                        clients.add(client)

                        thread(name = "HostClientThread") {
                            readHostClient(client)
                        }

                    } catch (_: Exception) {
                    }
                }
            }

            listener.onLog("Host started on port $port")

        } catch (e: Exception) {
            listener.onLog("Host error: ${e.message}")
        }
    }

    private fun readHostClient(client: ClientInfo) {
        try {
            val input = DataInputStream(client.socket.getInputStream())

            while (running && !client.socket.isClosed) {
                val raw = input.readUTF()
                handleHostClientMessage(client, raw)
            }

        } catch (_: Exception) {
        } finally {
            removeClient(client)
        }
    }

    private fun handleHostClientMessage(client: ClientInfo, raw: String) {
        try {
            val json = JSONObject(raw)
            val type = json.optString("t")

            if (type == "join") {
                client.id = json.optString("clientId", UUID.randomUUID().toString())
                client.name = json.optString("name", "Player")

                val welcome = welcomeMessage(client)
                sendToSocket(client.socket, welcome)

                val joined = playerJoinedMessage(client.id, client.name)

                broadcastExcept(client.id, joined)
                listener.onMessage(joined)

                listener.onLog("${client.name} joined")
                return
            }

            if (client.id.isEmpty()) {
                return
            }

            if (type == "state") {
                listener.onMessage(raw)
                broadcastExcept(client.id, raw)
                return
            }

            listener.onMessage(raw)
            broadcastExcept(client.id, raw)

        } catch (e: Exception) {
            listener.onLog("Bad message: ${e.message}")
        }
    }

    private fun removeClient(client: ClientInfo) {
        if (!clients.remove(client)) {
            return
        }

        try {
            client.socket.close()
        } catch (_: Exception) {
        }

        if (!running) {
            return
        }

        if (client.id.isEmpty()) {
            return
        }

        val left = playerLeftMessage(client.id)

        listener.onMessage(left)
        broadcastAll(left)

        listener.onLog("Player left: ${client.name}")
    }

    fun join(host: String, port: Int) {
        stop()
        running = true
        role = Role.CLIENT

        thread(name = "JoinHostThread") {
            try {
                val socket = Socket(host, port)
                hostSocket = socket

                sendToSocket(socket, joinMessage())

                thread(name = "ClientReadThread") {
                    readHost(socket)
                }

                listener.onLog("Connecting to $host:$port")

            } catch (e: Exception) {
                listener.onLog("Join failed: ${e.message}")
            }
        }
    }

    private fun readHost(socket: Socket) {
        try {
            val input = DataInputStream(socket.getInputStream())

            while (running && !socket.isClosed) {
                val raw = input.readUTF()
                listener.onMessage(raw)
            }

        } catch (_: Exception) {
        } finally {
            hostSocket = null
            listener.onLog("Disconnected from host")
        }
    }

    fun send(raw: String) {
        when (role) {
            Role.HOST -> {
                broadcastAll(raw)
            }
            Role.CLIENT -> {
                hostSocket?.let {
                    sendToSocket(it, raw)
                }
            }
            Role.NONE -> {
            }
        }
    }

    private fun joinMessage(): String {
        return JSONObject()
            .put("t", "join")
            .put("clientId", myId)
            .put("name", myName)
            .toString()
    }

    private fun welcomeMessage(client: ClientInfo): String {
        val players = JSONArray()

        players.put(playerJson(myId, myName))

        clients.forEach {
            if (it.id.isNotEmpty() && it.id != client.id) {
                players.put(playerJson(it.id, it.name))
            }
        }

        return JSONObject()
            .put("t", "welcome")
            .put("hostId", myId)
            .put("clientId", client.id)
            .put("players", players)
            .toString()
    }

    private fun playerJson(id: String, name: String): JSONObject {
        return JSONObject()
            .put("id", id)
            .put("name", name)
    }

    private fun playerJoinedMessage(id: String, name: String): String {
        return JSONObject()
            .put("t", "playerJoined")
            .put("id", id)
            .put("name", name)
            .toString()
    }

    private fun playerLeftMessage(id: String): String {
        return JSONObject()
            .put("t", "playerLeft")
            .put("id", id)
            .toString()
    }

    private fun broadcastAll(raw: String) {
        clients.forEach { client ->
            sendToSocket(client.socket, raw)
        }
    }

    private fun broadcastExcept(id: String, raw: String) {
        clients.forEach { client ->
            if (client.id != id) {
                sendToSocket(client.socket, raw)
            }
        }
    }

    private fun sendToSocket(socket: Socket, raw: String) {
        try {
            val out = DataOutputStream(socket.getOutputStream())
            out.writeUTF(raw)
            out.flush()
        } catch (_: Exception) {
        }
    }

    fun discover() {
        stopDiscovery()

        seen.clear()

        synchronized(resolveLock) {
            resolveQueue.clear()
            resolving = false
        }

        discoveryListener = object : NsdManager.DiscoveryListener {

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                listener.onLog("Start discovery failed: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
            }

            override fun onDiscoveryStarted(serviceType: String) {
                listener.onLog("Searching devices...")
            }

            override fun onDiscoveryStopped(serviceType: String) {
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceType != serviceType) {
                    return
                }

                val name = info.serviceName ?: return

                if (seen.add(name)) {
                    queueResolve(info)
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                val name = info.serviceName ?: return
                seen.remove(name)
                listener.onDeviceLost(name)
            }
        }

        try {
            nsd.discoverServices(
                serviceType,
                NsdManager.PROTOCOL_DNS_SD,
                discoveryListener
            )
        } catch (e: Exception) {
            listener.onLog("Discover error: ${e.message}")
        }
    }

    private fun queueResolve(info: NsdServiceInfo) {
        synchronized(resolveLock) {
            resolveQueue.add(info)

            if (!resolving) {
                resolveNext()
            }
        }
    }

    private fun resolveNext() {
        val info: NsdServiceInfo

        synchronized(resolveLock) {
            if (resolveQueue.isEmpty()) {
                resolving = false
                return
            }

            resolving = true
            info = resolveQueue.remove()
        }

        try {
            nsd.resolveService(info, object : NsdManager.ResolveListener {

                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    listener.onLog("Resolve failed: $errorCode")
                    resolveNext()
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host?.hostAddress

                    if (host != null) {
                        listener.onDeviceFound(
                            Device(
                                serviceInfo.serviceName,
                                host,
                                serviceInfo.port
                            )
                        )
                    }

                    resolveNext()
                }
            })
        } catch (_: Exception) {
            resolveNext()
        }
    }

    private fun registerService(name: String, port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            setServiceType(serviceType)
            setPort(port)
        }

        registrationListener = object : NsdManager.RegistrationListener {

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                listener.onLog("Registration failed: $errorCode")
            }

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
            }

            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                listener.onLog("Registered as ${serviceInfo.serviceName}")
            }
        }

        try {
            nsd.registerService(
                info,
                NsdManager.PROTOCOL_DNS_SD,
                registrationListener
            )
        } catch (e: Exception) {
            listener.onLog("Register error: ${e.message}")
        }
    }

    private fun stopDiscovery() {
        discoveryListener?.let {
            try {
                nsd.stopServiceDiscovery(it)
            } catch (_: Exception) {
            }
        }

        discoveryListener = null
    }

    private fun stopRegistration() {
        registrationListener?.let {
            try {
                nsd.unregisterService(it)
            } catch (_: Exception) {
            }
        }

        registrationListener = null
    }

    fun stop() {
        running = false
        role = Role.NONE

        stopRegistration()
        stopDiscovery()

        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }

        try {
            hostSocket?.close()
        } catch (_: Exception) {
        }

        clients.forEach {
            try {
                it.socket.close()
            } catch (_: Exception) {
            }
        }

        clients.clear()

        serverSocket = null
        hostSocket = null

        seen.clear()

        synchronized(resolveLock) {
            resolveQueue.clear()
            resolving = false
        }
    }
}
