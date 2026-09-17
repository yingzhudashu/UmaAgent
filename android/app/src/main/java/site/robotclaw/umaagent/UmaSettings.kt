package site.robotclaw.umaagent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** 账户、连接与更新设置集中展示，避免与渠道退出语义混淆。 */
@Composable
internal fun SettingsScreen(
    state: UmaUiState,
    model: UmaViewModel,
    onOpenProfile: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val switchAccount = rememberDiscardAction(model::hasUnsentDrafts, model::switchAccount)
    val logout = rememberDiscardAction(model::hasUnsentDrafts, model::logout)
    LazyColumn(
        modifier.testTag("settings-list"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            SettingsSection("执行权限") {
                SettingsRow(
                    "权",
                    "免审批",
                    "当前账号的工具、命令与调度在所有设备统一生效",
                    trailing = {
                        Switch(
                            modifier = Modifier.semantics { contentDescription = "免审批" },
                            checked = state.autoApprove,
                            onCheckedChange = model::setAutoApprove,
                            enabled =
                                state.executionSettingsLoaded &&
                                    !state.offline &&
                                    !state.savingExecutionSettings,
                        )
                    },
                )
                if (state.savingExecutionSettings) Text("正在保存…", Modifier.padding(16.dp))
            }
        }
        item {
            SettingsSection("本机外观") {
                SettingsRow(
                    "色",
                    "主题",
                    "仅影响这台设备，字号跟随系统设置",
                    trailing = {
                        ActionMenu(
                            listOf(
                                MenuAction("跟随系统") { model.setTheme("system") },
                                MenuAction("浅色") { model.setTheme("light") },
                                MenuAction("深色") { model.setTheme("dark") },
                            ),
                            label =
                                when (state.themeMode) {
                                    "light" -> "浅色"
                                    "dark" -> "深色"
                                    else -> "跟随系统"
                                },
                        )
                    },
                )
            }
        }
        item {
            SettingsSection("助手偏好") {
                TextButton(onOpenProfile, Modifier.fillMaxWidth()) { Text("助手 Profile") }
            }
        }
        item {
            SettingsSection("连接") {
                SettingsRow(
                    badge = "网",
                    title = "服务状态",
                    supporting = BuildConfig.UMA_BASE_URL,
                    trailing = {
                        Text(
                            if (state.offline) "离线只读" else "服务正常",
                            style = MaterialTheme.typography.labelMedium,
                            color =
                                if (state.offline) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.secondary,
                        )
                    },
                )
                HorizontalDivider()
                SettingsRow(
                    badge = "号",
                    title = "当前身份",
                    supporting = if (state.userRole == "admin") "管理员，可访问咸鱼工作台" else "普通用户",
                    trailing = {
                        Text(
                            if (state.workspace == "xianyu") "咸鱼" else "UmaAgent",
                            style = MaterialTheme.typography.labelMedium,
                        )
                    },
                )
            }
        }
        item {
            SettingsSection("应用更新") {
                UpdatePanel(state, model)
            }
        }
        item {
            SettingsSection("账户") {
                // 普通环境切换与退出都只清本机身份，合并为一个入口；测试网关退出单独保留。
                SettingsRow(
                    badge = "换",
                    title = "切换账号",
                    supporting = "清除本机令牌、缓存和草稿后重新登录；后台渠道继续运行",
                    trailing = { TextButton(switchAccount, enabled = !state.loading) { Text("切换") } },
                )
                if (BuildConfig.STAGING_BUILD)
                    SettingsRow(
                        badge = "退",
                        title = "退出账号及测试网关",
                        supporting = "同时清除本机账号数据和测试网关认证",
                        trailing = {
                            TextButton(logout, enabled = !state.loading) { Text("退出") }
                        },
                    )
            }
        }
        item {
            Text(
                "UmaAgent ${BuildConfig.VERSION_NAME} · Android",
                Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(
            title,
            Modifier.padding(horizontal = 4.dp),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Surface(
            Modifier.fillMaxWidth().padding(horizontal = 2.dp),
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.medium,
            tonalElevation = 1.dp,
        ) {
            Column(
                Modifier.padding(vertical = 4.dp),
                content = content,
            )
        }
    }
}

@Composable
internal fun SettingsRow(
    badge: String,
    title: String,
    supporting: String,
    trailing: @Composable (() -> Unit)? = null,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        // 大字号或窄栏下将操作移到下一行，避免尾部按钮把说明挤成逐字竖排。
        if (LocalDensity.current.fontScale >= 1.5f || maxWidth < 300.dp) {
            Column(
                Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                Text(
                    supporting,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                trailing?.let { Box(Modifier.align(Alignment.End)) { it() } }
            }
        } else
            ListItem(
                leadingContent = {
                    Surface(
                        Modifier.size(34.dp),
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                badge,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                        }
                    }
                },
                headlineContent = { Text(title) },
                supportingContent = { Text(supporting) },
                trailingContent = trailing,
            )
    }
}

@Composable
internal fun UpdatePanel(state: UmaUiState, model: UmaViewModel) {
    Column(
        Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("当前版本", style = MaterialTheme.typography.bodyLarge)
            Text(
                "${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）",
                style = MaterialTheme.typography.labelLarge,
            )
        }
        when {
            state.updateChecking -> Text("正在检查更新")
            state.updateDownloading -> Text("正在下载 ${state.updateProgress}%")
            state.updateManifest != null -> {
                Text(
                    "发现新版本 ${state.updateManifest.versionName}",
                    color = MaterialTheme.colorScheme.primary,
                )
                state.updateManifest.releaseNotes.take(3).forEach { Text("• $it") }
                Button({ model.downloadUpdate() }, Modifier.fillMaxWidth()) { Text("下载并安装") }
            }
            state.updateChecked && state.updateError.isBlank() ->
                Text("已是最新版本", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> Text("尚未确认更新状态", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.updateError.isNotBlank())
            Text(state.updateError, color = MaterialTheme.colorScheme.error)
        OutlinedButton(
            { model.checkForUpdate() },
            Modifier.fillMaxWidth(),
            enabled = !state.updateChecking && !state.updateDownloading,
        ) {
            Text("检查更新")
        }
    }
}
