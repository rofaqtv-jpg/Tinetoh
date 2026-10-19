package com.mygame

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var wifi: LocalWifi

    private var uploadMessage: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val REQUEST_SELECT_FILE = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.setBackgroundColor(Color.BLACK)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.allowContentAccess = true
        webView.settings.databaseEnabled = true
        webView.settings.useWideViewPort = true
        webView.settings.loadWithOverviewMode = true
@Suppress("DEPRECATION")
webView.settings.allowFileAccessFromFileURLs = true

@Suppress("DEPRECATION")
webView.settings.allowUniversalAccessFromFileURLs = true
        webView.webViewClient = WebViewClient()
        webView.settings.allowFileAccessFromFileURLs = true
     webView.settings.allowUniversalAccessFromFileURLs = true
        wifi = LocalWifi(this, object : LocalWifi.Listener {

            override fun onDeviceFound(device: LocalWifi.Device) {
                callJs(
                    "window.NetworkBridge && window.NetworkBridge.onDeviceFound(" +
                            JSONObject.quote(device.name) + ", " +
                            JSONObject.quote(device.host) + ", " +
                            device.port +
                            ");"
                )
            }

            override fun onDeviceLost(name: String) {
                callJs(
                    "window.NetworkBridge && window.NetworkBridge.onDeviceLost(" +
                            JSONObject.quote(name) +
                            ");"
                )
            }

            override fun onMessage(json: String) {
                callJs(
                    "window.NetworkBridge && window.NetworkBridge.receive(" +
                            JSONObject.quote(json) +
                            ");"
                )
            }

            override fun onLog(message: String) {
                callJs(
                    "window.NetworkBridge && window.NetworkBridge.onLog(" +
                            JSONObject.quote(message) +
                            ");"
                )
            }
        })

        webView.webChromeClient = object : WebChromeClient() {

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {

                if (uploadMessage != null) {
                    uploadMessage?.onReceiveValue(null)
                }

                uploadMessage = filePathCallback

                try {
                    val intent = fileChooserParams.createIntent()
                    startActivityForResult(intent, REQUEST_SELECT_FILE)
                    return true
                } catch (e: Exception) {
                    uploadMessage = null
                    return false
                }
            }
        }

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        setContentView(webView)

        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == REQUEST_SELECT_FILE) {
            if (uploadMessage == null) {
                return
            }

            uploadMessage?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            )

            uploadMessage = null
        }
    }

    private fun callJs(script: String) {
        runOnUiThread {
            webView.evaluateJavascript(script, null)
        }
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun getDeviceName(): String {
            return wifi.myName
        }

        @JavascriptInterface
        fun getMyId(): String {
            return wifi.myId
        }

        @JavascriptInterface
        fun startHost() {
            wifi.startHost()
        }

        @JavascriptInterface
        fun discover() {
            wifi.discover()
        }

        @JavascriptInterface
        fun join(host: String, port: Int) {
            wifi.join(host, port)
        }

        @JavascriptInterface
        fun send(json: String) {
            wifi.send(json)
        }
    }

    override fun onDestroy() {
        wifi.stop()
        webView.destroy()
        super.onDestroy()
    }
}
