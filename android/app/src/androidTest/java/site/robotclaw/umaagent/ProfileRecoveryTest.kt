package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 验证恢复后真正重新读取服务端 Profile 时，未提交草稿仍然保留。 */
@RunWith(AndroidJUnit4::class)
class ProfileRecoveryTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun restoredDraftSurvivesProfileReload() {
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
            val restoration = StateRestorationTester(compose)
            restoration.setContent {
                val state by model.uiState.collectAsState()
                UmaAgentTheme { Surface { ManagementScreen(state, model, "profile") } }
            }
            fun awaitEditor() {
                compose.waitUntil(10_000) {
                    compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().any {
                        !it.config.contains(SemanticsProperties.Disabled)
                    }
                }
            }
            awaitEditor()
            val draft = "旋转恢复后必须保留的 Profile 草稿"
            compose.onNode(hasSetTextAction()).performTextReplacement(draft)
            restoration.emulateSavedInstanceStateRestore()
            awaitEditor()
            compose.onNode(hasSetTextAction()).assertTextContains(draft)
            compose.onNodeWithText("保存 Profile").assertIsEnabled()
            // 页面作用域立即销毁，已发起写入仍归账号 ViewModel 所有。
            val saved = "离开页面后仍须完成的 Profile 写入"
            compose.runOnUiThread {
                val pageScope = CoroutineScope(Dispatchers.Main.immediate + Job())
                pageScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    model.managementRequest("/profile", "PUT", buildJsonObject { put("content", saved) })
                }
                pageScope.cancel()
            }
            compose.waitUntil(10_000) {
                runBlocking { managementText(model.managementRequest("/profile"), "content") == saved }
            }
            val created = java.util.concurrent.atomic.AtomicBoolean(false)
            compose.runOnUiThread { model.createSession("知识上传生命周期") { created.set(true) } }
            compose.waitUntil(10_000) { created.get() && model.uiState.value.selectedSessionId != null }
            val file = java.io.File(compose.activity.cacheDir, "lifecycle-knowledge-${System.currentTimeMillis()}.txt")
            file.writeText("页面离开后继续登记本次知识源")
            val before = runBlocking { model.managementRequest("/knowledge") } as kotlinx.serialization.json.JsonArray
            val knownIds = before.map { managementText(it, "id") }.toSet()
            compose.runOnUiThread {
                val pageScope = CoroutineScope(Dispatchers.Main.immediate + Job())
                pageScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    model.uploadKnowledgeSource(android.net.Uri.fromFile(file))
                }
                pageScope.cancel()
            }
            compose.waitUntil(15_000) {
                runBlocking {
                    (model.managementRequest("/knowledge") as kotlinx.serialization.json.JsonArray)
                        .any { managementText(it, "id") !in knownIds }
                }
            }
        } finally {
            compose.runOnUiThread { model.viewModelScope.cancel() }
        }
    }
}
