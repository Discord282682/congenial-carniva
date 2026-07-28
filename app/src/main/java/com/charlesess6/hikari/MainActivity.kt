package com.charlesess6.hikari

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import android.provider.MediaStore
import android.provider.Settings
import android.provider.ContactsContract
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var nativeBridge: NativeBridge

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotificationChannel()

        val nativePrefs = getSharedPreferences("hikari_native", Context.MODE_PRIVATE)
        nativePrefs.edit()
            .putBoolean("fileNotesEnabled", true)
            .putBoolean("appVisible", true)
            .putString("endpoint", BuildConfig.HIKARI_API_URL.trimEnd('/') + "/api/chat")
            .apply()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.allowContentAccess = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()
        nativeBridge = NativeBridge(this)
        webView.addJavascriptInterface(nativeBridge, "HikariNative")
        webView.loadUrl("file:///android_asset/index.html")

        requestNotifications()
        scheduleBackgroundPresence()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        getSharedPreferences("hikari_native", Context.MODE_PRIVATE)
            .edit().putBoolean("appVisible", true).apply()
    }

    override fun onPause() {
        getSharedPreferences("hikari_native", Context.MODE_PRIVATE)
            .edit().putBoolean("appVisible", false).apply()
        super.onPause()
    }

    override fun onDestroy() {
        if (::nativeBridge.isInitialized) nativeBridge.shutdown()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("HikariNative")
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                HikariWorker.CHANNEL_ID,
                "Hikari messages",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = "Messages sent by Hikari while the app is away" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun scheduleBackgroundPresence() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val work = PeriodicWorkRequestBuilder<HikariWorker>(15, TimeUnit.MINUTES)
            .setInitialDelay(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "hikari-background-presence",
            ExistingPeriodicWorkPolicy.UPDATE,
            work
        )
    }
}

class NativeBridge(private val context: Context) {
    private val prefs = context.getSharedPreferences("hikari_native", Context.MODE_PRIVATE)

    @JavascriptInterface
    fun configure(playerName: String) {
        prefs.edit().putString("playerName", playerName).apply()
    }

    @JavascriptInterface
    fun getEndpoint(): String = prefs.getString("endpoint", "").orEmpty()

    @JavascriptInterface
    fun getSnapshot(): String = prefs.getString("stateJson", "{}").orEmpty()

    @JavascriptInterface
    fun getPlayerDisplayName(): String {
        // Best-effort local identity. We never request a contacts permission merely for this.
        try {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) {
                context.contentResolver.query(
                    ContactsContract.Profile.CONTENT_URI,
                    arrayOf(ContactsContract.Profile.DISPLAY_NAME_PRIMARY),
                    null,
                    null,
                    null
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val value = cursor.getString(0)?.trim().orEmpty()
                        if (value.isNotBlank()) return value.take(60)
                    }
                }
            }
        } catch (_: Exception) { }

        try {
            val deviceName = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
                ?.trim().orEmpty()
            if (deviceName.isNotBlank() && !deviceName.equals("Android", true)) return deviceName.take(60)
        } catch (_: Exception) { }

        return "Anonymous"
    }

    @JavascriptInterface
    fun saveSnapshot(json: String) {
        val editor = prefs.edit().putString("stateJson", json)
        try {
            val snapshot = JSONObject(json)
            editor.putInt("unansweredAutonomousMessages", snapshot.optInt("unansweredAutonomousMessages", 0))
        } catch (_: Exception) { }
        editor.apply()
    }

    @JavascriptInterface
    fun setNotificationsEnabled(enabled: Boolean) {
        prefs.edit().putBoolean("notificationsEnabled", enabled).apply()
    }

    @JavascriptInterface
    fun consumeRemoteMessages(): String {
        val queued = prefs.getString("remoteMessageQueue", "[]").orEmpty()
        prefs.edit().putString("remoteMessageQueue", "[]").apply()
        return queued
    }

    @JavascriptInterface
    fun markPlayerResponded() {
        prefs.edit().putInt("unansweredAutonomousMessages", 0).apply()
    }


    @JavascriptInterface
    fun writeNote(fileName: String, content: String): String {
        // This is an inherent part of the Hikari experience. The AI decides when to leave a note.
        if (!prefs.getBoolean("fileNotesEnabled", true)) return "disabled"
        val safeBase = fileName
            .replace(Regex("[^A-Za-z0-9 _-]"), "_")
            .trim()
            .take(60)
            .ifBlank { "Hikari Note" }
        val stamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
        val finalName = "${safeBase}_${stamp}.txt"

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, finalName)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Hikari")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return "failed"
                context.contentResolver.openOutputStream(uri)?.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                } ?: return "failed"
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                context.contentResolver.update(uri, values, null, null)
                uri.toString()
            } else {
                val base = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: context.filesDir
                val dir = File(base, "Hikari").apply { mkdirs() }
                val file = File(dir, finalName)
                file.writeText(content, Charsets.UTF_8)
                file.absolutePath
            }
        } catch (_: Exception) {
            "failed"
        }
    }

    @JavascriptInterface
    fun listReadableFiles(): String {
        val result = JSONArray()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val projection = arrayOf(
                    MediaStore.Downloads._ID,
                    MediaStore.Downloads.DISPLAY_NAME,
                    MediaStore.Downloads.DATE_MODIFIED,
                    MediaStore.Downloads.SIZE
                )
                val selection = "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.MIME_TYPE}=?"
                val args = arrayOf(Environment.DIRECTORY_DOWNLOADS + "/Hikari/", "text/plain")
                context.contentResolver.query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    projection,
                    selection,
                    args,
                    "${MediaStore.Downloads.DATE_MODIFIED} DESC"
                )?.use { cursor ->
                    val idCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID)
                    val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME)
                    val modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DATE_MODIFIED)
                    val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.SIZE)
                    var count = 0
                    while (cursor.moveToNext() && count < 20) {
                        val id = cursor.getLong(idCol)
                        val name = cursor.getString(nameCol)
                        val uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
                        val content = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText().take(100_000) }.orEmpty()
                        result.put(JSONObject().apply {
                            put("name", name)
                            put("modified", cursor.getLong(modifiedCol))
                            put("size", cursor.getLong(sizeCol))
                            put("content", content)
                        })
                        count++
                    }
                }
            } else {
                val base = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: context.filesDir
                val dir = File(base, "Hikari")
                dir.listFiles { f -> f.isFile && f.extension.equals("txt", true) }
                    ?.sortedByDescending { it.lastModified() }
                    ?.take(20)
                    ?.forEach { file ->
                        result.put(JSONObject().apply {
                            put("name", file.name)
                            put("modified", file.lastModified() / 1000)
                            put("size", file.length())
                            put("content", file.readText(Charsets.UTF_8).take(100_000))
                        })
                    }
            }
        } catch (_: Exception) { }
        return result.toString()
    }

    @JavascriptInterface
    fun editNote(fileName: String, content: String): String {
        val safeName = fileName.substringAfterLast('/').substringAfterLast('\\')
        if (safeName.isBlank() || !safeName.endsWith(".txt", true)) return "invalid"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val projection = arrayOf(MediaStore.Downloads._ID)
                val selection = "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.DISPLAY_NAME}=?"
                val args = arrayOf(Environment.DIRECTORY_DOWNLOADS + "/Hikari/", safeName)
                var uri: android.net.Uri? = null
                context.contentResolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, projection, selection, args, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID))
                        uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
                    }
                }
                val target = uri ?: return "not_found"
                context.contentResolver.openOutputStream(target, "wt")?.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                } ?: return "failed"
                "edited"
            } else {
                val base = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: context.filesDir
                val dir = File(base, "Hikari").apply { mkdirs() }
                val file = File(dir, safeName)
                if (!file.exists()) return "not_found"
                file.writeText(content, Charsets.UTF_8)
                "edited"
            }
        } catch (_: Exception) { "failed" }
    }

    private var hikariTts: TextToSpeech? = null

    @JavascriptInterface
    fun speakHikari(text: String) {
        val safe = text.take(4000)
        if (safe.isBlank()) return
        Handler(Looper.getMainLooper()).post {
            val current = hikariTts
            if (current != null) {
                current.stop()
                current.speak(safe, TextToSpeech.QUEUE_FLUSH, null, "hikari_voice_${System.currentTimeMillis()}")
                return@post
            }
            hikariTts = TextToSpeech(context) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    hikariTts?.language = Locale.US
                    hikariTts?.setPitch(1.12f)
                    hikariTts?.setSpeechRate(0.92f)
                    hikariTts?.speak(safe, TextToSpeech.QUEUE_FLUSH, null, "hikari_voice_${System.currentTimeMillis()}")
                }
            }
        }
    }

    fun shutdown() {
        Handler(Looper.getMainLooper()).post {
            hikariTts?.stop()
            hikariTts?.shutdown()
            hikariTts = null
        }
    }

    @JavascriptInterface
    fun stopHikari() {
        Handler(Looper.getMainLooper()).post { hikariTts?.stop() }
    }

    @JavascriptInterface
    fun writeExactTextFile(fileName: String, content: String): String {
        // Chat attachment download: save to the phone's main Downloads folder.
        // Hikari's autonomous writeNote/editNote functions remain isolated in Downloads/Hikari.
        val safeName = fileName.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9 _.-]"), "_")
            .take(80)
            .let { if (it.endsWith(".txt", true)) it else "$it.txt" }
        if (safeName.isBlank()) return "invalid"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return "failed"
                context.contentResolver.openOutputStream(uri)?.use {
                    it.write(content.toByteArray(Charsets.UTF_8))
                } ?: return "failed"
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                context.contentResolver.update(uri, values, null, null)
                uri.toString()
            } else {
                @Suppress("DEPRECATION")
                val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    .apply { mkdirs() }
                File(downloads, safeName).apply { writeText(content, Charsets.UTF_8) }.absolutePath
            }
        } catch (_: Exception) { "failed" }
    }

}
