package site.robotclaw.umaagent

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun managementText(value: JsonElement?, key: String): String =
    (value as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

private val managementLabels =
    mapOf(
        "name" to "名称",
        "title" to "标题",
        "status" to "状态",
        "value" to "内容",
        "key" to "记忆项",
        "confidence" to "可信度",
        "scope" to "范围",
        "content" to "正文",
        "path" to "路径",
        "filePath" to "文件路径",
        "sourceName" to "来源",
        "documentCount" to "文档数",
        "error" to "错误",
        "createdAt" to "创建时间",
        "updatedAt" to "更新时间",
        "connected" to "连接状态",
        "toolCount" to "工具数",
        "recommendation" to "建议",
        "evidence" to "依据",
        "risk" to "风险",
        "totals" to "统计",
        "cases" to "用例",
        "passed" to "通过",
        "total" to "总数",
        "durationMs" to "耗时毫秒",
        "summary" to "摘要",
        "trace" to "链路诊断",
        "services" to "服务明细",
        "runs" to "运行",
        "completed" to "完成",
        "failed" to "失败",
        "category" to "分类",
        "mode" to "模式",
        "suiteVersion" to "用例集版本",
        "recoveryFrequency" to "恢复频率",
        "slowModels" to "慢模型",
        "toolFailures" to "工具失败",
        "approvalBottlenecks" to "审批瓶颈",
        "spans" to "记录数",
        "errors" to "错误数",
        "active" to "进行中",
        "incomplete" to "未完成",
        "errorRate" to "错误率",
        "id" to "标识",
        "from" to "开始时间",
        "to" to "结束时间",
        "model" to "模型",
        "provider" to "供应商",
        "tools" to "工具",
        "tool" to "工具",
        "approvals" to "审批",
        "calls" to "调用次数",
        "totalTokens" to "总 Token 数",
        "averageDurationMs" to "平均耗时（毫秒）",
        "requested" to "请求数",
        "denied" to "拒绝数",
        "recoveries" to "恢复次数",
        "cancelled" to "已取消",
        "interrupted" to "已中断",
        "writeFailures" to "遥测写入失败",
        "otlpExportFailures" to "遥测导出失败",
        "latestError" to "最近错误",
        "failures" to "失败次数",
        "service" to "服务",
        "latencyMs" to "耗时分布（毫秒）",
        "stageLatencyMs" to "阶段耗时（毫秒）",
    )

@Composable
internal fun ManagementValue(value: JsonElement?, depth: Int = 0, field: String? = null) {
    when (value) {
        null,
        JsonNull -> Text("未提供", color = MaterialTheme.colorScheme.onSurfaceVariant)
        is JsonPrimitive ->
            Text(
                if (
                    field in listOf("from", "to", "createdAt", "updatedAt") &&
                        value.longOrNull != null
                ) {
                    if (value.longOrNull == 0L) "不限"
                    else
                        java.time.Instant.ofEpochMilli(value.longOrNull!!)
                            .atZone(java.time.ZoneId.systemDefault())
                            .format(
                                java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                            )
                } else if (field == "errorRate" && value.doubleOrNull != null) {
                    "%.2f%%".format(value.doubleOrNull!! * 100)
                } else if (!value.isString && value.booleanOrNull != null) {
                    if (value.booleanOrNull == true) "是" else "否"
                } else if (field == "status")
                    // 只翻译协议状态；记忆正文中 active、true 等字面内容必须原样保留。
                    when (value.content) {
                        "candidate" -> "候选"
                        "active" -> "已启用"
                        "rejected" -> "已拒绝"
                        "pending" -> "待处理"
                        "completed" -> "已完成"
                        "failed" -> "失败"
                        "cancelled" -> "已取消"
                        "running" -> "运行中"
                        "approved" -> "已批准"
                        "proposed" -> "待决策"
                        else -> value.content
                    }
                else value.content
            )
        is JsonArray -> {
            if (value.isEmpty()) Text("暂无记录")
            value.forEach {
                ManagementValue(it, depth + 1)
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
            }
        }
        is JsonObject ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                value.entries
                    .filter { it.key !in listOf("token", "confirmationToken", "publicKey") }
                    .forEach { (key, child) ->
                        if (child is JsonObject || child is JsonArray) {
                            var expanded by remember(value, key) { mutableStateOf(depth == 0) }
                            TextButton({ expanded = !expanded }) {
                                Text(
                                    (if (expanded) "收起 " else "展开 ") +
                                        (managementLabels[key] ?: key)
                                )
                            }
                            if (expanded) ManagementValue(child, depth + 1)
                        } else {
                            Text(
                                managementLabels[key] ?: key,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            ManagementValue(child, depth + 1, key)
                        }
                    }
            }
    }
}

@Composable
internal fun ManagementScreen(
    state: UmaUiState,
    model: UmaViewModel,
    initial: String = "knowledge",
    modifier: Modifier = Modifier,
) {
    val pages =
        if (initial == "quality")
            listOf("diagnostics" to "运行诊断", "evaluations" to "评测历史", "optimization" to "人工优化")
        else if (initial == "memory") listOf("memory" to "记忆审核")
        else if (initial == "profile") listOf("profile" to "助手 Profile")
        else
            listOf("knowledge" to "知识库") +
                if (state.userRole == "admin") listOf("skills" to "技能", "mcp" to "MCP")
                else emptyList()
    var page by rememberSaveable(initial) { mutableStateOf(pages.first().first) }
    var diagnosticDays by rememberSaveable { androidx.compose.runtime.mutableIntStateOf(1) }
    var data by remember { mutableStateOf<JsonElement?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var path by rememberSaveable { mutableStateOf("") }
    var profile by rememberSaveable { mutableStateOf("") }
    var savedProfile by rememberSaveable { mutableStateOf("") }
    val leave = LocalLeaveConfirmation.current
    ConfirmFormLeave({
        name.isNotBlank() || path.isNotBlank() || (page == "profile" && profile != savedProfile)
    }) {
        name = ""
        path = ""
        profile = savedProfile
    }
    var showForm by rememberSaveable { mutableStateOf(false) }
    var detail by remember { mutableStateOf<JsonElement?>(null) }
    var confirmation by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }
    val scope = rememberCoroutineScope()
    fun endpoint() =
        when (page) {
            "diagnostics" -> "/reports/diagnostics"
            "evaluations" -> "/evaluations?limit=100"
            "optimization" -> "/optimization-proposals"
            else -> "/$page"
        }
    suspend fun refresh() {
        // 每次刷新使用同一个结束时间，区间严格为所选天数，避免两次读取时钟产生偏差。
        val target =
            if (page == "diagnostics") {
                val to = System.currentTimeMillis()
                "${endpoint()}?from=${to - diagnosticDays * 86_400_000L}&to=$to"
            } else endpoint()
        data = model.managementRequest(target)
        loaded = true
        if (page == "profile") {
            val remote = managementText(data, "content")
            // 旋转和进程恢复会重新读取服务端，但 rememberSaveable 恢复的未提交草稿不能被覆盖。
            // 显式刷新已通过离开确认清理脏状态，因此也能在这里接纳服务端的新版本。
            if (profile == savedProfile) profile = remote
            savedProfile = remote
        }
    }
    fun perform(action: suspend () -> Unit) {
        if (busy || state.offline) return
        busy = true
        error = ""
        scope.launch {
            try {
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "操作失败，请重试"
            } finally {
                busy = false
            }
        }
    }
    fun mutate(target: String, method: String = "POST", body: JsonObject = buildJsonObject {}) {
        perform {
            model.managementRequest(target, method, body)
            refresh()
        }
    }
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null)
                perform {
                    model.uploadKnowledgeSource(uri)
                    refresh()
                }
        }
    LaunchedEffect(page) {
        data = null
        loaded = false
        error = ""
        busy = true
        try {
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "无法读取"
        } finally {
            busy = false
        }
    }
    BackHandler(detail != null) { detail = null }
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // 多标签页面已由选中标签表达当前内容，省去重复大标题，为手机正文留出空间。
        if (pages.size == 1)
            item {
                Text(
                    pages.find { it.first == page }?.second ?: "资源",
                    style = MaterialTheme.typography.headlineSmall,
                )
            }
        if (pages.size > 1)
            item {
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    pages.forEach { (id, title) ->
                        FilterChip(
                            page == id,
                            {
                                val change = {
                                    page = id
                                    detail = null
                                    name = ""
                                    path = ""
                                    showForm = false
                                }
                                if (leave != null) leave.request(change) else change()
                            },
                            enabled = !busy,
                            label = { Text(title) },
                        )
                    }
                }
            }
        if (busy)
            item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在读取或处理…")
            }
        if (page == "diagnostics")
            item {
                Text("诊断时间窗", style = MaterialTheme.typography.labelLarge)
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf(1 to "最近24小时", 7 to "最近7天", 30 to "最近30天").forEach { (days, label) ->
                        FilterChip(
                            selected = diagnosticDays == days,
                            onClick = {
                                diagnosticDays = days
                                perform { refresh() }
                            },
                            enabled = !busy && !state.offline,
                            label = { Text(label) },
                        )
                    }
                }
            }
        if (error.isNotEmpty()) item { Text(error, color = MaterialTheme.colorScheme.error) }
        item {
            OutlinedButton(
                {
                    val reload = { perform { refresh() } }
                    if (page == "profile" && leave != null) leave.request(reload) else reload()
                },
                enabled = !busy && !state.offline,
            ) {
                Text("刷新")
            }
        }
        if (detail != null) {
            item {
                TextButton({ detail = null }) { Text("返回列表") }
                ManagementValue(detail)
            }
        } else {
            if (page == "knowledge") {
                item {
                    OutlinedTextField(
                        query,
                        { query = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("搜索知识库") },
                    )
                    Button(
                        {
                            perform {
                                data =
                                    model.managementRequest(
                                        "/knowledge/search?q=" +
                                            java.net.URLEncoder.encode(query, "UTF-8")
                                    )
                                loaded = true
                            }
                        },
                        enabled = query.isNotBlank() && !busy && !state.offline,
                    ) {
                        Text("搜索知识")
                    }
                }
                item {
                    Button(
                        { picker.launch(arrayOf("*/*")) },
                        enabled = !busy && !state.offline && state.selectedSessionId != null,
                    ) {
                        Text("上传并索引")
                    }
                    if (state.selectedSessionId == null) Text("上传前请先选择会话")
                }
                if (state.userRole == "admin")
                    item {
                        OutlinedButton(
                            { showForm = true },
                            enabled = !busy && !showForm && !state.offline,
                        ) {
                            Text("添加服务器目录")
                        }
                    }
            }
            if (page == "skills")
                item {
                    Button({ showForm = true }, enabled = !busy && !showForm && !state.offline) {
                        Text("安装技能")
                    }
                    OutlinedButton(
                        { mutate("/skills/refresh") },
                        enabled = !busy && !state.offline,
                    ) {
                        Text("刷新资源")
                    }
                }
            if (showForm && page in listOf("knowledge", "skills"))
                item {
                    if (page == "knowledge")
                        OutlinedTextField(
                            name,
                            { name = it },
                            Modifier.fillMaxWidth(),
                            label = { Text("来源名称") },
                            enabled = !busy && !state.offline,
                        )
                    OutlinedTextField(
                        path,
                        { path = it },
                        Modifier.fillMaxWidth(),
                        label = { Text(if (page == "knowledge") "服务器目录" else "服务器技能路径") },
                        enabled = !busy && !state.offline,
                    )
                    Button(
                        {
                            perform {
                                model.managementRequest(
                                    if (page == "skills") "/skills/install" else "/knowledge",
                                    "POST",
                                    buildJsonObject {
                                        if (page == "skills") {
                                            put("source", "local")
                                            put("reference", path)
                                        } else {
                                            put("name", name)
                                            put("path", path)
                                        }
                                    },
                                )
                                showForm = false
                                name = ""
                                path = ""
                                // 创建回执已成功便清理表单；列表刷新失败只提供读取重试，避免重复创建。
                                refresh()
                            }
                        },
                        enabled =
                            path.isNotBlank() &&
                                (page == "skills" || name.isNotBlank()) &&
                                !busy &&
                                !state.offline,
                    ) {
                        Text("提交")
                    }
                    TextButton(
                        {
                            val close = { showForm = false }
                            if (leave != null) leave.request(close) else close()
                        },
                        enabled = !busy,
                    ) {
                        Text("取消")
                    }
                }
            if (page == "profile")
                item {
                    OutlinedTextField(
                        profile,
                        { profile = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("Profile 内容") },
                        minLines = 6,
                        enabled = loaded && !busy && !state.offline,
                    )
                    Button(
                        {
                            val submitted = profile
                            perform {
                                model.managementRequest(
                                    "/profile",
                                    "PUT",
                                    buildJsonObject { put("content", submitted) },
                                )
                                // 写回执就是保存事实，不能因额外读取失败诱导用户重复写入。
                                savedProfile = submitted
                            }
                        },
                        enabled = loaded && !busy && !state.offline && profile != savedProfile,
                    ) {
                        Text("保存 Profile")
                    }
                }
            if (page == "optimization")
                item {
                    Text("接受只加入人工待办，不自动修改代码或配置。")
                    Button(
                        { mutate("/optimization-proposals/generate") },
                        enabled = !busy && !state.offline,
                    ) {
                        Text("生成只读提案")
                    }
                }
            val rows =
                when (val value = data) {
                    is JsonArray -> value.toList()
                    is JsonObject -> (value["packages"] as? JsonArray)?.toList() ?: listOf(value)
                    else -> emptyList()
                }
            if (loaded && rows.isEmpty()) item { Text("暂无记录") }
            if (page != "profile")
                items(rows) { row ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(
                            Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val id = managementText(row, "id")
                            val status = managementText(row, "status")
                            if (page == "diagnostics") DiagnosticsSummary(row)
                            else {
                                Text(
                                    listOf("name", "title", "key", "sourceName")
                                        .map { managementText(row, it) }
                                        .firstOrNull { it.isNotBlank() } ?: "记录",
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                listOf(
                                        "status",
                                        "value",
                                        "content",
                                        "recommendation",
                                        "evidence",
                                        "error",
                                    )
                                    .forEach { key ->
                                        managementText(row, key)
                                            .takeIf { it.isNotBlank() }
                                            ?.let {
                                                Text(
                                                    it,
                                                    maxLines = 3,
                                                    overflow =
                                                        androidx.compose.ui.text.style.TextOverflow
                                                            .Ellipsis,
                                                )
                                            }
                                    }
                            }
                            // 列表只显示摘要；可发现的详情与单层操作菜单保留所有能力。
                            val enabled = !busy && !state.offline
                            val actions =
                                if (id.isBlank()) emptyList()
                                else
                                    when (page) {
                                        "memory" ->
                                            listOf(
                                                MenuAction("保留记忆", enabled && status != "active") {
                                                    mutate(
                                                        "/memory/$id",
                                                        body =
                                                            buildJsonObject {
                                                                put("status", "active")
                                                            },
                                                    )
                                                },
                                                MenuAction(
                                                    "拒绝记忆",
                                                    enabled && status != "rejected",
                                                ) {
                                                    confirmation =
                                                        "拒绝这条记忆？" to
                                                            {
                                                                model.managementRequest(
                                                                    "/memory/$id",
                                                                    "POST",
                                                                    buildJsonObject {
                                                                        put("status", "rejected")
                                                                    },
                                                                )
                                                                refresh()
                                                            }
                                                },
                                            )
                                        "knowledge" ->
                                            listOf(
                                                MenuAction("重建索引", enabled) {
                                                    mutate("/knowledge/$id/reindex")
                                                },
                                                MenuAction("删除知识源", enabled) {
                                                    confirmation =
                                                        "删除“${managementText(row, "name") }”的索引？原始文件保留。" to
                                                            {
                                                                model.managementRequest(
                                                                    "/knowledge/$id",
                                                                    "DELETE",
                                                                )
                                                                refresh()
                                                            }
                                                },
                                            )
                                        "skills" ->
                                            listOf(
                                                    "enable" to "启用",
                                                    "disable" to "停用",
                                                    "reject" to "拒绝",
                                                )
                                                .map { (action, label) ->
                                                    MenuAction(label, enabled) {
                                                        confirmation =
                                                            "确认${label}技能“${managementText(row, "name") }”？" to
                                                                {
                                                                    model.managementRequest(
                                                                        "/skills/$id/$action",
                                                                        "POST",
                                                                    )
                                                                    refresh()
                                                                }
                                                    }
                                                }
                                        "optimization" ->
                                            if (status == "pending")
                                                listOf(
                                                        "accepted" to "接受为人工待办",
                                                        "rejected" to "拒绝提案",
                                                    )
                                                    .map { (value, label) ->
                                                        MenuAction(label, enabled) {
                                                            mutate(
                                                                "/optimization-proposals/$id/decision",
                                                                body =
                                                                    buildJsonObject {
                                                                        put("status", value)
                                                                    },
                                                            )
                                                        }
                                                    }
                                            else emptyList()
                                        else -> emptyList()
                                    }
                            if (page != "diagnostics")
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TextButton({ detail = row }) { Text("查看详情") }
                                    if (actions.isNotEmpty()) ActionMenu(actions)
                                }
                        }
                    }
                }
        }
    }
    confirmation?.let { (title, action) ->
        AlertDialog(
            onDismissRequest = { if (!busy) confirmation = null },
            title = { Text(title) },
            confirmButton = {
                TextButton(
                    {
                        confirmation = null
                        perform(action)
                    },
                    enabled = !busy,
                ) {
                    Text("确认")
                }
            },
            dismissButton = { TextButton({ confirmation = null }, enabled = !busy) { Text("取消") } },
        )
    }
}
