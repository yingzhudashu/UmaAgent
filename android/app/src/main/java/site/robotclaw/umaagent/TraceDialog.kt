package site.robotclaw.umaagent

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

/** 诊断属于当前回复的辅助操作，不在聊天正文中铺开原始 JSON。 */
@Composable
internal fun TraceDialog(
    payload: String,
    onClose: () -> Unit,
    loading: Boolean,
    onLoadMore: () -> Unit,
    error: String,
) {
    val data =
        remember(payload) {
            runCatching { Json.parseToJsonElement(payload) as JsonObject }.getOrNull()
        }
    val spans =
        remember(data) {
            (data?.get("spans") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        }
    val byId = remember(spans) { spans.associateBy { managementText(it, "spanId") } }
    fun depth(span: JsonObject): Int {
        var parent = managementText(span, "parentSpanId")
        val seen = mutableSetOf<String>()
        var count = 0
        // 分页可能尚未包含祖先；不猜测缺失关系，循环或深链不能挤掉手机正文。
        while (parent.isNotBlank() && seen.add(parent) && count < 4) {
            val ancestor = byId[parent] ?: break
            count++
            parent = managementText(ancestor, "parentSpanId")
        }
        return count
    }
    val traceId = data?.get("traceId")?.jsonPrimitive?.contentOrNull.orEmpty()
    val clipboard = LocalClipboardManager.current
    var copyStatus by remember(traceId) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("链路与耗时") },
        text = {
            LazyColumn(
                Modifier.fillMaxWidth().heightIn(max = 440.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (loading)
                    item {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text("读取链路…")
                    }
                if (error.isNotBlank())
                    item {
                        Text(error, color = MaterialTheme.colorScheme.error)
                        TextButton(onLoadMore, enabled = !loading) { Text("重试") }
                    }
                if (!loading && error.isBlank() && spans.isEmpty()) item { Text("暂无可用链路记录") }
                item {
                    SelectionContainer { Text(traceId, style = MaterialTheme.typography.bodySmall) }
                    if (copyStatus.isNotBlank()) Text(copyStatus)
                }
                items(spans, key = { managementText(it, "spanId") }) { span ->
                    Column(Modifier.padding(start = (depth(span) * 12).dp)) {
                        Text(
                            span["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            "${span["durationMs"]?.jsonPrimitive?.contentOrNull?.let { "$it ms" } ?: "耗时未提供"} · ${when(span["status"]?.jsonPrimitive?.contentOrNull) { "ok" -> "完成"
 "cancelled" -> "已取消"
 else -> "错误" }}"
                        )
                        span["errorMessage"]?.jsonPrimitive?.contentOrNull?.let {
                            Text(it, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                if (data?.get("hasMore")?.jsonPrimitive?.booleanOrNull == true)
                    item { TextButton(onLoadMore, enabled = !loading) { Text("加载更多阶段") } }
            }
        },
        confirmButton = { TextButton(onClose) { Text("关闭") } },
        dismissButton = {
            TextButton(
                {
                    copyStatus =
                        runCatching {
                                clipboard.setText(AnnotatedString(traceId))
                                "已复制"
                            }
                            .getOrDefault("复制失败，请选择 ID 复制")
                },
                enabled = traceId.isNotEmpty(),
            ) {
                Text("复制 Trace ID")
            }
        },
    )
}
