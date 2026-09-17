package site.robotclaw.umaagent

import android.content.Context
import android.util.AtomicFile
import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
internal data class SessionDraft(
    val text: String = "",
    val attachments: List<PendingAttachment> = emptyList(),
    val pending: PendingSend? = null,
)

@Serializable
internal data class PendingSend(
    val messageId: String,
    val text: String,
    val attachmentIds: List<String>,
    val mode: String,
)

/** 草稿与服务端快照分离。会话切换、旋转和进程重建都不能清掉未提交的正文或附件。 */
internal class DraftStore(context: Context) {
    private val file = AtomicFile(File(context.filesDir, "drafts.json"))
    private val json = Json

    fun read(): Map<String, SessionDraft> = runCatching {
        if (file.baseFile.exists())
            json.decodeFromString<Map<String, SessionDraft>>(
                file.readFully().toString(Charsets.UTF_8)
            )
        else emptyMap()
    }
        .getOrDefault(emptyMap())

    fun write(drafts: Map<String, SessionDraft>) {
        val output = file.startWrite()
        try {
            output.write(json.encodeToString(drafts).toByteArray(Charsets.UTF_8))
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    fun clear() = file.delete()
}
