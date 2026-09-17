package site.robotclaw.umaagent

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** 使用 Core 同一快捷命令入口；输出保留可选文本，管理命令由服务端鉴权。 */
@Composable
internal fun ShortcutDialog(model: UmaViewModel, sessionId: String, onDismiss: () -> Unit) {
    var command by rememberSaveable { mutableStateOf("/help") }
    var query by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    // 编译时直接打包协议目录，不维护另一份容易漂移的 Android 命令表。
    val catalog = remember {
        val data =
            org.json.JSONArray(
                context.assets.open("commands.json").bufferedReader().use { it.readText() }
            )
        (0 until data.length()).map { data.getJSONObject(it) }
    }
    val visible = catalog.filter {
        "${it.getString("command")} ${it.getString("title")} ${it.getString("description")}"
            .contains(query.trim(), ignoreCase = true)
    }
    var output by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    var submitted by rememberSaveable { mutableStateOf("/help") }
    val dismiss = rememberDiscardAction({ !busy && command != submitted }, onDismiss)
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("快捷命令") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    query,
                    { query = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("搜索命令或中文说明") },
                    singleLine = true,
                )
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 216.dp)
                        .verticalScroll(rememberScrollState())
                ) {
                    visible.forEach { item ->
                        val value = item.getString("command")
                        Column(
                            Modifier.fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .selectable(
                                    command == value,
                                    enabled = !busy,
                                    role = Role.RadioButton,
                                ) {
                                    command = value
                                }
                                .padding(8.dp)
                        ) {
                            Text(
                                item.getString("title") +
                                    if (item.getBoolean("admin")) " · 仅管理员" else "",
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(value, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                item.getString("description"),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    if (visible.isEmpty()) Text("没有匹配的命令")
                }
                OutlinedTextField(
                    command,
                    { command = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("命令，例如 /session status") },
                    enabled = !busy,
                )
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                if (output.isNotEmpty())
                    androidx.compose.foundation.text.selection.SelectionContainer { Text(output) }
            }
        },
        confirmButton = {
            TextButton(
                {
                    if (busy) return@TextButton
                    busy = true
                    error = ""
                    scope.launch {
                        runRequestCatching { model.executeShortcut(sessionId, command) }
                            .onSuccess {
                                output = it
                                submitted = command
                            }
                            .onFailure { error = it.message ?: "命令失败" }
                        busy = false
                    }
                },
                enabled = !busy && command.isNotBlank(),
            ) {
                Text("执行")
            }
        },
        dismissButton = { TextButton(dismiss) { Text("关闭") } },
    )
}
