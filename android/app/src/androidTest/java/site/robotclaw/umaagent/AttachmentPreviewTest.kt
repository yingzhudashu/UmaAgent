package site.robotclaw.umaagent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 图片失败后切换附件必须重新解码，不保留旧失败状态或旧位图。 */
@RunWith(AndroidJUnit4::class)
class AttachmentPreviewTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun invalidImageCanBeReplacedByDecodedImage() {
        val bytes =
            ByteArrayOutputStream().use { output ->
                val bitmap = Bitmap.createBitmap(80, 40, Bitmap.Config.ARGB_8888)
                try {
                    bitmap.eraseColor(android.graphics.Color.GREEN)
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                    output.toByteArray()
                } finally {
                    bitmap.recycle()
                }
            }
        val preview = mutableStateOf(AttachmentPreview("invalid", "损坏图片", byteArrayOf(1, 2)))
        compose.setContent { UmaAgentTheme { AttachmentPreviewDialog(preview.value) {} } }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("无法预览此图片").fetchSemanticsNodes().isNotEmpty()
        }
        compose.runOnIdle { preview.value = AttachmentPreview("valid", "正确图片", bytes) }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithContentDescription("正确图片").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("正确图片").assertIsDisplayed()
        compose.onNodeWithText("无法预览此图片").assertDoesNotExist()
        compose.onNodeWithText("关闭").assertIsDisplayed()
    }
}
