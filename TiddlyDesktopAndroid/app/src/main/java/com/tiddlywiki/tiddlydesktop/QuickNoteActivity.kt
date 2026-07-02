package com.tiddlywiki.tiddlydesktop

import android.os.Bundle
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.Toast
import com.tiddlywiki.tiddlydesktop.host.WikiLauncher
import com.tiddlywiki.tiddlydesktop.host.WikiListStore
import com.tiddlywiki.tiddlydesktop.host.WikiUrl
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Quick Note input (launched by the home-screen widget). Shows a wiki chooser + a text box; on Done
 * the note is delivered to the chosen wiki as a new tiddler via the existing share-payload path
 * (WikiLauncher.open(..., sharePayload) → __tdImportShare adds the tiddler and saves).
 */
class QuickNoteActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val wikis = WikiListStore.load(this)
        if (wikis.isEmpty()) {
            Toast.makeText(this, R.string.quicknote_no_wikis, Toast.LENGTH_LONG).show()
            finish(); return
        }

        setContentView(R.layout.activity_quick_note)
        val spinner = findViewById<Spinner>(R.id.quicknote_wiki_spinner)
        val noteInput = findViewById<EditText>(R.id.quicknote_text)

        ArrayAdapter(this, android.R.layout.simple_spinner_item, wikis.map { it.title }).also {
            it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            spinner.adapter = it
        }

        noteInput.requestFocus()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)

        findViewById<Button>(R.id.quicknote_cancel).setOnClickListener { finish() }
        findViewById<Button>(R.id.quicknote_done).setOnClickListener {
            val text = noteInput.text.toString().trim()
            if (text.isEmpty()) {
                Toast.makeText(this, R.string.quicknote_empty, Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            val ok = sendNote(wikis[spinner.selectedItemPosition], text)
            Toast.makeText(this, if (ok) R.string.quicknote_sent else R.string.quicknote_failed, Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    private fun sendNote(wiki: WikiListStore.Wiki, text: String): Boolean {
        val decoded = WikiUrl.decode(wiki.url) ?: return false
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val tiddler = JSONObject()
            .put("title", getString(R.string.quicknote_title) + " " + stamp)
            .put("text", text)
            .put("tags", "QuickNote")
            .put("type", "text/vnd.tiddlywiki")
        val payload = JSONArray().put(tiddler).toString()
        return runCatching {
            // Deliver via the native ShareQueue (keyed by the wiki path) — the same path shareToWiki
            // uses. WikiActivity's drainShares() reads it on load and __tdImportShare adds the tiddler
            // (with created/modified fields) then saves. (EXTRA_SHARE_PAYLOAD is a dead param.)
            com.tiddlywiki.tiddlydesktop.node.ShareQueue.enqueue(this, decoded.path, payload)
            WikiLauncher.open(
                this, decoded.path, wiki.title, decoded.isFolder,
                wiki.backupsEnabled, wiki.backupCount, wiki.backupDir
            )
            true
        }.getOrDefault(false)
    }
}
