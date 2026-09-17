package site.robotclaw.umaagent

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

/** 诊断首屏呈现业务摘要；重复区间与原始对象不再层层展开占用手机正文。 */
@Composable
internal fun DiagnosticsSummary(value: JsonElement) {
    val report = value as? JsonObject ?: return
    val summary = report["summary"] as? JsonObject
    val runs = summary?.get("runs")
    val model = summary?.get("model")
    val tools = summary?.get("tools")
    val trace = report["trace"] as? JsonObject
    fun field(data: JsonElement?, name: String) = managementText(data, name).ifEmpty { "未提供" }
    // 统计保留服务端精度，展示统一到十分之一毫秒，避免长小数挤占手机正文。
    fun duration(data: JsonElement?, name: String) =
        managementText(data, name)
            .toDoubleOrNull()
            ?.takeIf { it.isFinite() }
            ?.let { "%.1f ms".format(java.util.Locale.ROOT, it) } ?: "未提供"
    fun percent(data: JsonElement?, name: String, samples: String): String {
        if ((samples.toLongOrNull() ?: 0) == 0L) return "未提供"
        return managementText(data, name).toDoubleOrNull()?.let { "%.1f%%".format(it * 100) }
            ?: "未提供"
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("统计范围", style = MaterialTheme.typography.labelLarge)
        ManagementValue(report["from"], field = "from")
        ManagementValue(report["to"], field = "to")
        Text("运行", style = MaterialTheme.typography.titleMedium)
        Text(
            "已完成 ${field(runs, "completed")}/${field(runs, "total")} · 失败 ${field(runs, "failed")}"
        )
        Text("已取消 ${field(runs, "cancelled")} · 已中断 ${field(runs, "interrupted")}")
        Text("恢复频率 ${percent(report, "recoveryFrequency", field(runs, "total"))}")
        HorizontalDivider()
        Text("模型与工具", style = MaterialTheme.typography.titleMedium)
        Text("模型 ${field(model, "calls")} 次 · 失败 ${field(model, "failed")}")
        Text(
            "模型平均耗时 ${duration(model, "averageDurationMs")} · Token ${field(model, "totalTokens")}"
        )
        Text("工具 ${field(tools, "calls")} 次 · 失败 ${field(tools, "failed")}")
        DiagnosticDetail("模型明细", report["slowModels"])
        DiagnosticDetail("工具失败明细", report["toolFailures"])
        DiagnosticDetail("审批明细", report["approvalBottlenecks"])
        HorizontalDivider()
        Text("Trace", style = MaterialTheme.typography.titleMedium)
        Text(
            "${field(trace, "spans")} 个阶段 · ${field(trace, "active")} 个执行中 · ${field(trace, "incomplete")} 个未完整结束"
        )
        Text(
            "错误率 ${percent(trace, "errorRate", field(trace, "spans"))} · 写入失败 ${field(trace, "writeFailures")}"
        )
        Text("OTLP 导出失败 ${field(trace, "otlpExportFailures")}")
        (trace?.get("stageLatencyMs") as? JsonObject)?.forEach { (stage, latency) ->
            Text(stage, style = MaterialTheme.typography.labelLarge)
            Text(
                "p50 ${duration(latency, "p50")} · p95 ${duration(latency, "p95")} · p99 ${duration(latency, "p99")}"
            )
        }
        DiagnosticDetail("服务明细", trace?.get("services"))
    }
}

@Composable
private fun DiagnosticDetail(title: String, value: JsonElement?) {
    var expanded by remember { mutableStateOf(false) }
    TextButton({ expanded = !expanded }) { Text((if (expanded) "收起" else "展开") + title) }
    if (expanded) ManagementValue(value)
}
