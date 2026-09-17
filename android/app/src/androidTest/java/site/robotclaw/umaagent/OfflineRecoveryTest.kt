package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineRecoveryTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun currentConversationAndDraftRestoreBeforeNetworkResponse() {
        compose.runOnUiThread {
            val app = compose.activity.application
            val session = Session("offline-session", "离线会话")
            val snapshot =
                """{"snapshotSequence":9,"transcript":[{"id":"saved-message","role":"assistant","status":"complete","content":"已保存的完整回复","sequence":1}]}"""
            PatStore(app).save("isolated-offline-recovery-test")
            SnapshotCache(app)
                .write(
                    CacheEnvelope(
                        SNAPSHOT_CACHE_VERSION,
                        listOf(session),
                        mapOf(session.id to snapshot),
                        mapOf(session.id to 9L),
                        session.id,
                    )
                )
            DraftStore(app).write(mapOf(session.id to SessionDraft("重建后继续编辑")))
            val model = UmaViewModel(app)
            try {
                val state = model.uiState.value
                assertTrue(state.tokenPresent)
                assertTrue(state.offline)
                assertEquals(session.id, state.selectedSessionId)
                assertEquals("重建后继续编辑", model.draftText(session.id))
                val message = state.conversation!!.single() as UiConversationEntry.MessageEntry
                assertEquals("已保存的完整回复", message.item.content)
            } finally {
                // 构造后的同步断言不等待网络；取消无效测试令牌的登录，清理隔离数据。
                model.viewModelScope.cancel()
                PatStore(app).clear()
                SnapshotCache(app).clear()
                DraftStore(app).clear()
            }
        }
    }
}
