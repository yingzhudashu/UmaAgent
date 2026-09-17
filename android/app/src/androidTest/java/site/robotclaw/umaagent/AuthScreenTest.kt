package site.robotclaw.umaagent

import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.cancelChildren
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 使用合成令牌验证进入门禁，不在剪贴板或测试日志中放真实凭据。 */
@RunWith(AndroidJUnit4::class)
class AuthScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun registrationRequiresCopyOrManualSave() {
        lateinit var model: UmaViewModel
        compose.runOnUiThread {
            val app = compose.activity.application
            PatStore(app).clear()
            model = UmaViewModel(app)
            model.viewModelScope.coroutineContext.cancelChildren()
        }
        val state = mutableStateOf(UmaUiState())
        compose.setContent { UmaAgentTheme { Surface { AuthScreen(state.value, model) } } }
        compose.onNodeWithText("创建新账户").performScrollTo().performClick()
        compose.runOnIdle { state.value = state.value.copy(registrationToken = "test-only-registration-token") }
        val enter = compose.onNodeWithText("继续进入")
        enter.performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("我已手动保存令牌").performClick()
        enter.assertIsEnabled()
        compose.onNodeWithText("我已手动保存令牌").performClick()
        enter.assertIsNotEnabled()
        compose.onNodeWithText("复制令牌").performClick()
        enter.assertIsEnabled()
        // 新发行的令牌必须重新确认，旧令牌的复制状态不能跨发行继承。
        compose.runOnIdle { state.value = state.value.copy(registrationToken = "second-test-only-token") }
        enter.assertIsNotEnabled()
    }
}
