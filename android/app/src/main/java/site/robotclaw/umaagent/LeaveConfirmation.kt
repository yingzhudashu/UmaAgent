package site.robotclaw.umaagent

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester

/** 只管理当前导航内容中的未提交表单，不保存业务数据，也不代替写请求回执。 */
internal class LeaveConfirmation {
    val forms = mutableStateMapOf<Any, Pair<() -> Boolean, () -> Unit>>()
    var pending by mutableStateOf<(() -> Unit)?>(null)

    fun request(action: () -> Unit) {
        if (forms.values.any { it.first() }) pending = action else action()
    }
}

internal val LocalLeaveConfirmation = staticCompositionLocalOf<LeaveConfirmation?> { null }

/** 注册当前表单；导航销毁后解绑。读取最新脏状态，避免捕获保存前的旧值。 */
@Composable
internal fun ConfirmFormLeave(
    dirty: () -> Boolean,
    confirmation: LeaveConfirmation? = LocalLeaveConfirmation.current,
    onDiscard: () -> Unit,
) {
    if (confirmation == null) return
    val latest by rememberUpdatedState(dirty)
    val discard by rememberUpdatedState(onDiscard)
    val key = remember { Any() }
    DisposableEffect(confirmation) {
        confirmation.forms[key] = ({ latest() }) to ({ discard() })
        onDispose { confirmation.forms.remove(key) }
    }
}

/** 编辑弹窗独立确认，只放弃该弹窗的修改，不清空背后页面或其他表单。 */
@Composable
internal fun rememberDiscardAction(dirty: () -> Boolean, onDiscard: () -> Unit): () -> Unit {
    val confirmation = remember { LeaveConfirmation() }
    val discard by rememberUpdatedState(onDiscard)
    ConfirmFormLeave(dirty, confirmation) {}
    LeaveConfirmationDialog(confirmation)
    return { confirmation.request { discard() } }
}

@Composable
internal fun LeaveConfirmationDialog(confirmation: LeaveConfirmation) {
    if (confirmation.pending == null) return
    val focus = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = { confirmation.pending = null },
        title = { Text("放弃未保存内容？") },
        text = { Text("离开后，本次未保存的修改将丢失。") },
        dismissButton = {
            TextButton({ confirmation.pending = null }, Modifier.focusRequester(focus)) {
                Text("继续编辑")
            }
            // AlertDialog 内容在独立窗口组合，焦点请求必须随按钮进入该窗口。
            LaunchedEffect(Unit) { focus.requestFocus() }
        },
        confirmButton = {
            TextButton({
                val action = confirmation.pending
                confirmation.pending = null
                confirmation.forms.values.toList().filter { it.first() }.forEach { it.second() }
                action?.invoke()
            }) {
                Text("放弃并离开")
            }
        },
    )
}
