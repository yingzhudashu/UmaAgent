package site.robotclaw.umaagent

import android.graphics.Bitmap
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.FileProvider
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 大图片经过真实上传、会话加载与清除；验证显示状态和解码内存上限。 */
@RunWith(AndroidJUnit4::class)
class AvatarFlowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun uploadedAvatarIsSampledSharedAndResetImmediately() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            SnapshotCache(app).clear()
            DraftStore(app).clear()
            model = UmaViewModel(app)
            model.login(
                "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
            )
        }
        try {
            compose.waitUntil(20_000) {
                model.uiState.value.executionSettingsLoaded && !model.uiState.value.loading
            }
            compose.runOnUiThread { model.createSession("头像设备验收 ${System.currentTimeMillis()}") }
            compose.waitUntil(10_000) {
                model.uiState.value.conversation != null && !model.uiState.value.loading
            }
            val id = model.uiState.value.selectedSessionId!!
            val file = File(compose.activity.cacheDir, "updates/avatar-large.png")
            file.parentFile!!.mkdirs()
            val original = Bitmap.createBitmap(4096, 2048, Bitmap.Config.ARGB_8888)
            original.eraseColor(Color.MAGENTA)
            file.outputStream().use { original.compress(Bitmap.CompressFormat.PNG, 100, it) }
            original.recycle()
            // 与系统选择器一样使用有 MIME 类型的 content URI；file URI 没有图片类型。
            val uri =
                FileProvider.getUriForFile(
                    compose.activity,
                    "${BuildConfig.APPLICATION_ID}.fileprovider",
                    file,
                )
            compose.runOnUiThread { model.uploadAssistantAvatar(uri, file.name) }
            compose.waitUntil(15_000) {
                model.uiState.value.assistantAvatar != null ||
                    model.uiState.value.error.isNotEmpty()
            }
            assertEquals("", model.uiState.value.error)
            val avatar = model.uiState.value.assistantAvatar!!
            assertTrue("头像应限制解码尺寸", avatar.width <= 512 && avatar.height <= 512)
            assertTrue("RGBA 头像不得超过 1 MiB", avatar.allocationByteCount <= 1024 * 1024)
            assertEquals(Color.MAGENTA, avatar.getPixel(avatar.width / 2, avatar.height / 2))
            compose.runOnUiThread { model.selectSession(id) }
            compose.waitUntil(10_000) {
                model.uiState.value.assistantAvatar != null &&
                    model.uiState.value.assistantAvatar !== avatar
            }
            compose.runOnUiThread { model.resetAssistantAvatar() }
            compose.waitUntil(10_000) {
                model.uiState.value.assistantAvatar == null && !model.uiState.value.loading
            }
            assertNull(
                model.uiState.value.sessions.first { it.id == id }.assistantAvatarAttachmentId
            )
            assertEquals("", model.uiState.value.error)
            // 第二个独立客户端更新选中及非选中会话，Android应只投影事件而无需手动刷新。
            val remote =
                UmaApi(
                    "uma_pat_00000000-0000-4000-8000-000000000003_faux-user-3-token-012345678901234567890123"
                )
            kotlinx.coroutines.runBlocking {
                remote.patchJson(
                    "/sessions/$id",
                    kotlinx.serialization.json.buildJsonObject {
                        put("title", kotlinx.serialization.json.JsonPrimitive("另一设备改名"))
                    },
                )
            }
            compose.waitUntil(10_000) {
                model.uiState.value.sessions.first { it.id == id }.title == "另一设备改名"
            }
            val created = java.util.concurrent.atomic.AtomicBoolean(false)
            compose.runOnUiThread { model.createSession("第二会话") { created.set(true) } }
            compose.waitUntil(10_000) {
                created.get() &&
                    model.uiState.value.selectedSessionId != id &&
                    !model.uiState.value.loading
            }
            kotlinx.coroutines.runBlocking {
                remote.patchJson(
                    "/sessions/$id",
                    kotlinx.serialization.json.buildJsonObject {
                        put("title", kotlinx.serialization.json.JsonPrimitive("后台会话改名"))
                    },
                )
            }
            compose.waitUntil(10_000) {
                model.uiState.value.sessions.first { it.id == id }.title == "后台会话改名"
            }
            assertNotEquals(id, model.uiState.value.selectedSessionId)
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
