package com.charlesess6.hikari

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZonedDateTime

class HikariWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    companion object { const val CHANNEL_ID = "hikari_messages" }

    data class AutonomousMessage(
        val text: String,
        val kind: String = "text",
        val title: String? = null,
        val filename: String? = null,
        val memoryUpdate: JSONObject? = null
    )

    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("hikari_native", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("notificationsEnabled", true)) return Result.success()
        if (prefs.getBoolean("appVisible", false)) return Result.success()

        val endpoint = prefs.getString("endpoint", "").orEmpty().trim()
        if (!endpoint.startsWith("https://")) return Result.success()

        val nowMs = System.currentTimeMillis()
        val stateJson = prefs.getString("stateJson", "{}").orEmpty()
        val state = runCatching { JSONObject(stateJson) }.getOrElse { JSONObject() }
        val lastActive = state.optLong("lastActive", nowMs)
        val elapsedAway = (nowMs - lastActive).coerceAtLeast(0L)
        if (elapsedAway < 15 * 60_000L) return Result.success()

        val lastBackground = prefs.getLong("lastBackgroundMessage", 0L)
        if (nowMs - lastBackground < 60 * 60_000L) return Result.success()
        val unanswered = prefs.getInt("unansweredAutonomousMessages", state.optInt("unansweredAutonomousMessages", 0))
        if (unanswered >= 2) return Result.success()

        val playerName = prefs.getString("playerName", "Anonymous").orEmpty()
        val apiState = compactApiState(state, playerName)
        val decision = idleDecision(endpoint, apiState, state, elapsedAway, unanswered) ?: return Result.success()
        if (decision != "YES") return Result.success()

        val generated = fetchAutonomousReply(endpoint, apiState, state, elapsedAway) ?: return Result.success()
        if (prefs.getBoolean("appVisible", false)) return Result.success()
        val visibleText = generated.text.trim()
        if (visibleText.isBlank() || visibleText.equals("YES", true) || visibleText.equals("NO", true) || visibleText.equals("SEND", true) || visibleText.equals("WAIT", true)) {
            return Result.success()
        }

        val queue = runCatching { JSONArray(prefs.getString("remoteMessageQueue", "[]")) }.getOrElse { JSONArray() }
        queue.put(JSONObject().apply {
            put("text", visibleText)
            put("time", nowMs)
            put("kind", generated.kind)
            if (!generated.title.isNullOrBlank()) put("title", generated.title)
            if (!generated.filename.isNullOrBlank()) put("filename", generated.filename)
        })
        val trimmedQueue = JSONArray()
        val start = (queue.length() - 8).coerceAtLeast(0)
        for (i in start until queue.length()) trimmedQueue.put(queue.get(i))

        state.put("lastAutoMessage", nowMs)
        state.put("unansweredAutonomousMessages", unanswered + 1)
        state.put("savedAt", ZonedDateTime.now().toString())
        generated.memoryUpdate?.let { state.put("memory", it) }

        val persisted = prefs.edit()
            .putString("remoteMessageQueue", trimmedQueue.toString())
            .putString("stateJson", state.toString())
            .putLong("lastBackgroundMessage", nowMs)
            .putInt("unansweredAutonomousMessages", unanswered + 1)
            .commit()
        if (!persisted) return Result.retry()

        if (!prefs.getBoolean("appVisible", false)) showNotification(visibleText)
        return Result.success()
    }

    private fun baseUrl(endpoint: String): String {
        val clean = endpoint.trimEnd('/')
        return when {
            clean.endsWith("/api/chat/stream") -> clean.removeSuffix("/api/chat/stream")
            clean.endsWith("/api/chat") -> clean.removeSuffix("/api/chat")
            clean.endsWith("/chat") -> clean.removeSuffix("/chat")
            else -> clean.substringBeforeLast('/', clean)
        }
    }

    private fun compactApiState(state: JSONObject, playerName: String) = JSONObject().apply {
        put("deviceId", state.optString("deviceId", ""))
        put("playerName", playerName.ifBlank { "Anonymous" })
        put("affection", state.optInt("affection", 18))
        put("jealousy", state.optInt("jealousy", 8))
        put("awareness", state.optInt("awareness", 12))
        put("lastActive", state.optLong("lastActive", 0L))
        put("lastAutoMessage", state.optLong("lastAutoMessage", 0L))
        if (!state.has("memory")) put("memories", state.optJSONArray("memories") ?: JSONArray())
    }

    private fun recentMessages(state: JSONObject, limit: Int = 10): JSONArray {
        val source = state.optJSONArray("chatHistory") ?: return JSONArray()
        val result = JSONArray()
        val start = (source.length() - limit).coerceAtLeast(0)
        for (i in start until source.length()) result.put(source.opt(i))
        return result
    }

    private fun idleDecision(endpoint: String, apiState: JSONObject, state: JSONObject, elapsedAway: Long, unanswered: Int): String? = try {
        val conn = (URL(baseUrl(endpoint) + "/api/idle").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 6_000; readTimeout = 8_000; doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
        val body = JSONObject().apply {
            put("deviceId", apiState.optString("deviceId", ""))
            put("elapsedAwayMs", elapsedAway)
            put("unansweredAutonomousMessages", unanswered)
            put("state", apiState)
            put("recent", recentMessages(state))
            put("deviceContext", localContext())
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        if (conn.responseCode !in 200..299) null
        else JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).optString("decision", "NO").trim().uppercase()
    } catch (_: Exception) { null }

    private fun fetchAutonomousReply(endpoint: String, apiState: JSONObject, state: JSONObject, elapsedAway: Long): AutonomousMessage? = try {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 12_000; readTimeout = 25_000; doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
        val body = JSONObject().apply {
            put("mode", "autonomous")
            put("message", "")
            put("state", apiState)
            put("memory", state.optJSONObject("memory") ?: JSONObject())
            put("deviceContext", localContext())
            put("elapsedAwayMs", elapsedAway)
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        if (conn.responseCode !in 200..299) return null
        val data = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        val action = data.optJSONObject("messageAction")
        val text = when {
            action != null -> action.optString("text", action.optString("content", ""))
            else -> data.optString("reply", data.optString("message", ""))
        }.trim()
        if (text.isBlank()) return null
        val kind = action?.optString("kind", "text")?.lowercase()?.takeIf { it in setOf("text", "voice", "note", "file") } ?: "text"
        AutonomousMessage(
            text = text,
            kind = kind,
            title = action?.optString("title", "")?.takeIf { it.isNotBlank() },
            filename = action?.optString("filename", "")?.takeIf { it.isNotBlank() },
            memoryUpdate = data.optJSONObject("memoryUpdate")
        )
    } catch (_: Exception) { null }

    private fun localContext() = JSONObject().apply {
        val now = ZonedDateTime.now()
        put("localDate", now.toLocalDate().toString())
        put("localTime", now.toLocalTime().withNano(0).toString())
        put("timezone", now.zone.id)
        put("dayPart", when (now.hour) { in 0..4 -> "late night"; in 5..11 -> "morning"; in 12..16 -> "afternoon"; in 17..20 -> "evening"; else -> "night" })
    }

    private fun showNotification(text: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(applicationContext, MainActivity::class.java)
        val pending = PendingIntent.getActivity(applicationContext, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("Hikari")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(applicationContext).notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }
}
