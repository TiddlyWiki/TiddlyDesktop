package com.tiddlywiki.tiddlydesktop.node

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Queue of shared content awaiting import into a specific wiki. Written as files (not Intent
 * extras) so large payloads (base64 images/files) can't hit Binder's TransactionTooLargeException,
 * and so a wiki that's ALREADY open can pick up the share when it next resumes.
 *
 * Each file: { "wiki": <wiki path>, "tiddlers": <JSON array string of tiddler fields> }.
 */
object ShareQueue {

    private const val TAG = "ShareQueue"
    private const val DIR = "shares"

    fun enqueue(context: Context, wikiPath: String, tiddlersJson: String) {
        runCatching {
            val dir = File(context.filesDir, DIR).apply { mkdirs() }
            val obj = JSONObject().put("wiki", wikiPath).put("tiddlers", tiddlersJson)
            File(dir, "${System.currentTimeMillis()}-${UUID.randomUUID()}.json").writeText(obj.toString())
        }.onFailure { Log.e(TAG, "enqueue failed: ${it.message}") }
    }

    /** Return (and delete) the pending tiddler payloads targeted at [wikiPath], oldest first. */
    fun drain(context: Context, wikiPath: String): List<String> {
        val dir = File(context.filesDir, DIR)
        if (!dir.isDirectory) return emptyList()
        val out = ArrayList<String>()
        dir.listFiles()?.sortedBy { it.name }?.forEach { f ->
            runCatching {
                val obj = JSONObject(f.readText())
                if (obj.optString("wiki") == wikiPath) {
                    out.add(obj.optString("tiddlers"))
                    f.delete()
                }
            }
        }
        return out
    }
}
