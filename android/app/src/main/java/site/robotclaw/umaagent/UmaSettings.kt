package site.robotclaw.umaagent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** 账户、连接与更新设置集中展示，避免与渠道退出语义混淆。 */
@Composable
internal fun SettingsScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Surface(
                Modifier.fillMaxWidth(),
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = MaterialTheme.shapes.large,
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(18.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Surface(
                        Modifier.size(52.dp),
                        shape = CircleShape,
                        color = MaterialTheme.colorScheme.primary,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text("U", color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("应用设置", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        Text(
                            if (state.userRole == "admin") "管理员工作区" else "个人工作区",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                }
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
                            color = if (state.offline) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
                        )
                    },
                )
                HorizontalDivider()
                SettingsRow(
                    badge = "号",
                    title = "当前身份",
                    supporting = if (state.userRole == "admin") "管理员，可访问咸鱼工作台" else "普通用户",
                    trailing = { Text(if (state.workspace == "xianyu") "咸鱼" else "UmaAgent", style = MaterialTheme.typography.labelMedium) },
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
                if (state.userRole == "admin") {
                    SettingsRow(
                        badge = "换",
                        title = "切换普通 UmaAgent 账号",
                        supporting = "保留咸鱼后台运行，仅切换当前客户端账号",
                        trailing = {
                            TextButton({ model.switchAccount() }, enabled = !state.loading) { Text("切换") }
                        },
                    )
                    HorizontalDivider()
                }
                SettingsRow(
                    badge = "退",
                    title = "退出当前 UmaAgent 账号",
                    supporting = "清除本机保存的访问令牌和离线缓存",
                    trailing = {
                        TextButton({ model.logout() }) { Text("退出") }
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
            Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surface,
            shape = MaterialTheme.shapes.medium,
            tonalElevation = 1.dp,
        ) {
            Column(content = content)
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
    ListItem(
        leadingContent = {
            Surface(
                Modifier.size(34.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.secondaryContainer,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(badge, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
                }
            }
        },
        headlineContent = { Text(title) },
        supportingContent = { Text(supporting, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        trailingContent = trailing,
    )
}

@Composable
internal fun UpdatePanel(state: UmaUiState, model: UmaViewModel) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("当前版本", style = MaterialTheme.typography.bodyLarge)
            Text("${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）", style = MaterialTheme.typography.labelLarge)
        }
        when {
            state.updateChecking -> Text("正在检查更新")
            state.updateDownloading -> Text("正在下载 ${state.updateProgress}%")
            state.updateManifest != null -> {
                Text("发现新版本 ${state.updateManifest.versionName}", color = MaterialTheme.colorScheme.primary)
                state.updateManifest.releaseNotes.take(3).forEach { Text("• $it") }
                Button({ model.downloadUpdate() }, Modifier.fillMaxWidth()) { Text("下载并安装") }
            }
            else -> Text("已是最新版本", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.updateError.isNotBlank()) Text(state.updateError, color = MaterialTheme.colorScheme.error)
        OutlinedButton(
            { model.checkForUpdate() },
            Modifier.fillMaxWidth(),
            enabled = !state.updateChecking && !state.updateDownloading,
        ) { Text("检查更新") }
    }
}
