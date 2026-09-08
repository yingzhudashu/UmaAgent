package site.robotclaw.umaagent

import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material.icons.filled.MoreHoriz

import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.Task
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Shell 统一管理导航和系统栏留白，内容页只接收 Scaffold 已计算的空间。 */
private enum class MobileSection(val label: String) {
    Chat("对话"),
    Xianyu("咸鱼"),
    Sessions("会话"),
    Tasks("任务"),
    Schedules("调度"),
    Resources("资源"),
    Settings("设置"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AuthenticatedScreen(state: UmaUiState, model: UmaViewModel) {
    var sectionName by rememberSaveable(state.workspace) { mutableStateOf(if (state.workspace == "xianyu") MobileSection.Xianyu.name else MobileSection.Chat.name) }
    val visibleSections = remember(state.userRole) {
        MobileSection.entries.filter { it != MobileSection.Xianyu || state.userRole == "admin" }
    }
    var moreOpen by remember { mutableStateOf(false) }
    val primarySections = visibleSections.filter { it in listOf(MobileSection.Chat, MobileSection.Sessions, MobileSection.Tasks, MobileSection.Settings) }
    val moreSections = visibleSections.filter { it !in primarySections }
    val section = visibleSections.firstOrNull { it.name == sectionName } ?: visibleSections.first()
    val selectedSession = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val workspaceTitle = if (state.workspace == "xianyu") "咸鱼工作台" else "UmaAgent"
    val iconFor: @Composable (MobileSection) -> Unit = { item ->
        Icon(
            imageVector = when (item) {
                MobileSection.Chat -> Icons.AutoMirrored.Filled.Chat
                MobileSection.Xianyu -> Icons.Default.Store
                MobileSection.Sessions -> Icons.AutoMirrored.Filled.List
                MobileSection.Tasks -> Icons.Default.Task
                MobileSection.Schedules -> Icons.Default.Event
                MobileSection.Resources -> Icons.Default.Folder
                MobileSection.Settings -> Icons.Default.Settings
            },
            contentDescription = item.label,
        )
    }
    fun navigate(item: MobileSection) {
        sectionName = item.name
        if (item == MobileSection.Xianyu && state.workspace != "xianyu") model.refreshXianyuWorkspace()
        if (item != MobileSection.Xianyu && state.workspace == "xianyu") model.loadAgentWorkspace()
    }

    BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))) {
        val wide = maxWidth >= 600.dp
        Scaffold(
            modifier = Modifier.imePadding(),
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            topBar = {
                // TopAppBar 与底栏自行消费系统 Insets，Scaffold 内容区不重复添加。
                TopAppBar(
                    modifier = Modifier.statusBarsPadding(),
                    windowInsets = WindowInsets(0, 0, 0, 0),
                    title = {
                        Column {
                            Text(workspaceTitle, Modifier.testTag("workspace-title"), style = MaterialTheme.typography.titleLarge)
                            Text(selectedSession?.title ?: "选择一个会话开始工作", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    actions = {
                        Text(if (state.offline) "离线只读" else "已连接", Modifier.padding(horizontal = 12.dp),
                            style = MaterialTheme.typography.labelMedium, color = if (state.offline) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                        if (state.offline) TextButton({ model.retryLogin() }, enabled = !state.loading) { Text("重连") }
                    },
                )
            },
            bottomBar = {
                if (!wide) {
                    NavigationBar(Modifier.navigationBarsPadding(), windowInsets = WindowInsets(0, 0, 0, 0)) {
                        primarySections.forEach { item ->
                            NavigationBarItem(
                                selected = item == section,
                                onClick = { navigate(item) },
                                icon = { iconFor(item) },
                                label = { Text(item.label) },
                            )
                        }
                        NavigationBarItem(
                                selected = section in moreSections,
                                onClick = { moreOpen = true },
                                icon = { Box {
                            Icon(Icons.Default.MoreHoriz, contentDescription = "更多页面")
                            // 菜单锚定到实际按钮，避免额外的空 Row 子项挤占导航栏宽度。
                            DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                                moreSections.forEach { item ->
                                    DropdownMenuItem(text = { Text(item.label) }, leadingIcon = { iconFor(item) },
                                        onClick = { moreOpen = false; navigate(item) })
                                }
                            }
                        } },
                                label = { Text(if (section in moreSections) section.label else "更多") },
                        )
                    }
                }
            },
        ) { padding ->
            Row(Modifier.fillMaxSize().padding(padding).then(if (wide) Modifier.navigationBarsPadding() else Modifier)) {
                if (wide) {
                    NavigationRail(Modifier.verticalScroll(rememberScrollState()), windowInsets = WindowInsets(0, 0, 0, 0)) {
                        visibleSections.forEach { item ->
                            NavigationRailItem(selected = item == section, onClick = { navigate(item) }, icon = { iconFor(item) }, label = { Text(item.label) })
                        }
                    }
                }
                Column(Modifier.weight(1f).fillMaxSize()) {
                    if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    ErrorBanner(state.error)
                    when (section) {
            MobileSection.Chat -> ChatScreen(
                state,
                model,
                onOpenSessions = { navigate(MobileSection.Sessions) },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Xianyu -> XianyuWorkspaceScreen(state, model, Modifier.weight(1f))
            MobileSection.Sessions -> SessionsScreen(
                state,
                model,
                onOpenChat = { navigate(MobileSection.Chat) },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Tasks -> TasksScreen(
                state,
                model,
                onOpenTaskSession = { sessionId ->
                    model.selectSession(sessionId)
                    navigate(MobileSection.Chat)
                },
                modifier = Modifier.weight(1f),
            )
            MobileSection.Schedules -> SchedulesScreen(state, model, Modifier.weight(1f))
            MobileSection.Resources -> ResourcesScreen(state, model, Modifier.weight(1f))
            MobileSection.Settings -> SettingsScreen(state, model, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}
