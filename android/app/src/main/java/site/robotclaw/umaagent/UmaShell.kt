package site.robotclaw.umaagent

import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.Task
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

/** Shell 统一管理导航和系统栏留白，内容页只接收 Scaffold 已计算的空间。 */
private enum class MobileSection(val label: String) {
    Chat("对话"),
    Xianyu("咸鱼"),
    Sessions("会话"),
    Tasks("任务"),
    Schedules("调度"),
    Resources("资源"),
    Memory("记忆"),
    Quality("质量"),
    Settings("设置"),
    Profile("助手 Profile"),
    SessionSettings("会话设置"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AuthenticatedScreen(state: UmaUiState, model: UmaViewModel) {
    val navigation = rememberNavController()
    val activity = LocalActivity.current
    val leave = remember { LeaveConfirmation() }
    val startSection = remember {
        if (state.workspace == "xianyu") MobileSection.Xianyu else MobileSection.Chat
    }
    val backStack by navigation.currentBackStackEntryAsState()
    val sectionName = backStack?.destination?.route ?: startSection.name
    val visibleSections =
        remember(state.userRole) {
            MobileSection.entries.filter {
                it !in listOf(MobileSection.Profile, MobileSection.SessionSettings) &&
                    ((it !in listOf(MobileSection.Xianyu, MobileSection.Quality)) ||
                        state.userRole == "admin")
            }
        }
    var moreOpen by remember { mutableStateOf(false) }
    val primarySections = visibleSections.filter {
        it in listOf(MobileSection.Chat, MobileSection.Sessions, MobileSection.Tasks)
    }
    val moreSections = visibleSections.filter { it !in primarySections }
    val section = MobileSection.entries.first { it.name == sectionName }
    val secondary = section !in primarySections && section != startSection
    val chatHeader = section == MobileSection.Chat && state.selectedSessionId != null
    val workspaceTitle = if (state.workspace == "xianyu") "咸鱼工作台" else "UmaAgent"
    val iconFor: @Composable (MobileSection) -> Unit = { item ->
        Icon(
            imageVector =
                when (item) {
                    MobileSection.Chat -> Icons.AutoMirrored.Filled.Chat
                    MobileSection.Xianyu -> Icons.Default.Store
                    MobileSection.Sessions -> Icons.AutoMirrored.Filled.List
                    MobileSection.Tasks -> Icons.Default.Task
                    MobileSection.Schedules -> Icons.Default.Event
                    MobileSection.Memory -> Icons.Default.Folder
                    MobileSection.Quality -> Icons.Default.Task
                    MobileSection.Resources -> Icons.Default.Folder
                    MobileSection.Settings,
                    MobileSection.Profile,
                    MobileSection.SessionSettings -> Icons.Default.Settings
                },
            contentDescription = item.label,
        )
    }
    fun navigate(item: MobileSection) {
        leave.request {
            navigation.navigate(item.name) {
                launchSingleTop = true
                if (item in primarySections) {
                    popUpTo(startSection.name) { saveState = true }
                    restoreState = true
                }
            }
            if (item == MobileSection.Xianyu && state.workspace != "xianyu")
                model.refreshXianyuWorkspace()
            if (item != MobileSection.Xianyu && state.workspace == "xianyu")
                model.loadAgentWorkspace()
        }
    }
    BackHandler(section != startSection) { leave.request { navigation.popBackStack() } }
    LeaveConfirmationDialog(leave)

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
    ) {
        val wide = maxWidth >= 600.dp
        val dual = maxWidth >= 840.dp
        val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
        Scaffold(
            // Only the conversation composer consumes IME insets. Applying IME padding
            // to the whole shell lifts the navigation bar and creates a large gap above
            // the keyboard on Android.
            modifier = Modifier,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            topBar = {
                // TopAppBar 与底栏自行消费系统 Insets，Scaffold 内容区不重复添加。
                if (!chatHeader)
                    TopAppBar(
                        modifier = Modifier.statusBarsPadding().testTag("workspace-top-bar"),
                        windowInsets = WindowInsets(0, 0, 0, 0),
                        navigationIcon = {
                            if (secondary)
                                IconButton({ leave.request { navigation.popBackStack() } }) {
                                    Icon(
                                        Icons.AutoMirrored.Filled.ArrowBack,
                                        contentDescription =
                                            if (section == MobileSection.Profile) "返回设置" else "返回",
                                    )
                                }
                        },
                        title = {
                            Text(
                                if (section == MobileSection.Chat) workspaceTitle
                                else section.label,
                                Modifier.testTag("workspace-title"),
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        actions = {
                            Text(
                                if (state.offline) "离线只读" else "已连接",
                                Modifier.padding(horizontal = 12.dp),
                                style = MaterialTheme.typography.labelMedium,
                                color =
                                    if (state.offline) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.primary,
                            )
                            if (state.offline)
                                TextButton({ model.retryLogin() }, enabled = !state.loading) {
                                    Text("重连")
                                }
                        },
                    )
            },
            bottomBar = {
                if (!wide && !keyboardOpen && !secondary) {
                    CompactNavigationBar(
                        primarySections = primarySections,
                        moreSections = moreSections,
                        selected = section,
                        iconFor = iconFor,
                        onNavigate = ::navigate,
                        moreOpen = moreOpen,
                        onMoreOpenChange = { moreOpen = it },
                    )
                }
            },
        ) { padding ->
            Row(
                Modifier.fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding)
                    .then(if (wide || secondary) Modifier.navigationBarsPadding() else Modifier)
                    .then(if (secondary) Modifier.imePadding() else Modifier)
            ) {
                if (wide && !secondary) {
                    NavigationRail(
                        Modifier.then(if (chatHeader) Modifier.statusBarsPadding() else Modifier)
                            .verticalScroll(rememberScrollState()),
                        windowInsets = WindowInsets(0, 0, 0, 0),
                    ) {
                        visibleSections.forEach { item ->
                            NavigationRailItem(
                                modifier = Modifier.testTag("navigation-${item.name.lowercase()}"),
                                selected = item == section,
                                onClick = { navigate(item) },
                                icon = { iconFor(item) },
                                label = { Text(item.label) },
                            )
                        }
                    }
                }
                Column(
                    Modifier.weight(1f)
                        .fillMaxSize()
                        .then(if (chatHeader) Modifier.statusBarsPadding() else Modifier)
                ) {
                    if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    ErrorBanner(state.error)
                    CompositionLocalProvider(LocalLeaveConfirmation provides leave) {
                        NavHost(
                            navigation,
                            startDestination = startSection.name,
                            modifier = Modifier.weight(1f),
                        ) {
                            (visibleSections +
                                    listOf(MobileSection.Profile, MobileSection.SessionSettings))
                                .forEach { page ->
                                    composable(page.name) {
                                        Column(Modifier.fillMaxSize()) {
                                            when (page) {
                                                MobileSection.Chat ->
                                                    Row(Modifier.weight(1f).fillMaxWidth()) {
                                                        if (dual)
                                                            SessionsScreen(
                                                                state,
                                                                model,
                                                                onOpenChat = {
                                                                    navigate(MobileSection.Chat)
                                                                },
                                                                onOpenSettings = {
                                                                    navigate(
                                                                        MobileSection
                                                                            .SessionSettings
                                                                    )
                                                                },
                                                                modifier = Modifier.width(320.dp),
                                                            )
                                                        ChatScreen(
                                                            state,
                                                            model,
                                                            onOpenSessions = {
                                                                navigate(MobileSection.Sessions)
                                                            },
                                                            onOpenSettings = {
                                                                navigate(
                                                                    MobileSection.SessionSettings
                                                                )
                                                            },
                                                            modifier = Modifier.weight(1f),
                                                        )
                                                    }
                                                MobileSection.Xianyu ->
                                                    XianyuWorkspaceScreen(
                                                        state,
                                                        model,
                                                        Modifier.weight(1f),
                                                    )
                                                MobileSection.Sessions ->
                                                    SessionsScreen(
                                                        state,
                                                        model,
                                                        onOpenChat = {
                                                            navigate(MobileSection.Chat)
                                                        },
                                                        onOpenSettings = {
                                                            navigate(MobileSection.SessionSettings)
                                                        },
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                MobileSection.Tasks ->
                                                    TasksScreen(
                                                        state,
                                                        model,
                                                        onOpenTaskSession = { sessionId ->
                                                            leave.request {
                                                                model.selectSession(sessionId)
                                                                navigate(MobileSection.Chat)
                                                            }
                                                        },
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                MobileSection.Schedules ->
                                                    SchedulesScreen(
                                                        state,
                                                        model,
                                                        Modifier.weight(1f),
                                                    )
                                                MobileSection.Resources ->
                                                    ManagementScreen(
                                                        state,
                                                        model,
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                MobileSection.Memory ->
                                                    ManagementScreen(
                                                        state,
                                                        model,
                                                        "memory",
                                                        Modifier.weight(1f),
                                                    )
                                                MobileSection.Quality ->
                                                    ManagementScreen(
                                                        state,
                                                        model,
                                                        "quality",
                                                        Modifier.weight(1f),
                                                    )
                                                MobileSection.Settings ->
                                                    SettingsScreen(
                                                        state,
                                                        model,
                                                        onOpenProfile = {
                                                            navigate(MobileSection.Profile)
                                                        },
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                MobileSection.SessionSettings ->
                                                    SessionsScreen(
                                                        state,
                                                        model,
                                                        onOpenChat = {
                                                            navigate(MobileSection.Chat)
                                                        },
                                                        settingsOnly = true,
                                                        modifier = Modifier.weight(1f),
                                                    )
                                                MobileSection.Profile ->
                                                    ManagementScreen(
                                                        state,
                                                        model,
                                                        "profile",
                                                        Modifier.weight(1f),
                                                    )
                                            }
                                        }
                                    }
                                }
                        }
                    }
                }
            }
        }
    }
    // 根页面的处理器注册在 NavHost 之后，避免被导航组件消费；二级页面仍让详情优先返回。
    // 平板首页同时显示会话表单，无修改时由系统处理根返回，有修改先确认再将任务退到后台。
    BackHandler(section == startSection && leave.forms.values.any { it.first() }) {
        leave.request { activity?.moveTaskToBack(true) }
    }
}

@Composable
private fun CompactNavigationBar(
    primarySections: List<MobileSection>,
    moreSections: List<MobileSection>,
    selected: MobileSection,
    iconFor: @Composable (MobileSection) -> Unit,
    onNavigate: (MobileSection) -> Unit,
    moreOpen: Boolean,
    onMoreOpenChange: (Boolean) -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().height(64.dp).navigationBarsPadding(),
        tonalElevation = 2.dp,
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            primarySections.forEach { item ->
                CompactNavigationItem(
                    item = item,
                    selected = item == selected,
                    iconFor = iconFor,
                    onClick = { onNavigate(item) },
                    testTag = "navigation-${item.name.lowercase()}",
                )
            }
            Box {
                CompactNavigationItem(
                    item = null,
                    selected = selected in moreSections,
                    iconFor = iconFor,
                    onClick = { onMoreOpenChange(true) },
                    testTag = "navigation-more",
                )
                DropdownMenu(expanded = moreOpen, onDismissRequest = { onMoreOpenChange(false) }) {
                    moreSections.forEach { item ->
                        DropdownMenuItem(
                            text = { Text(item.label, style = MaterialTheme.typography.bodyMedium) },
                            leadingIcon = { iconFor(item) },
                            onClick = { onMoreOpenChange(false); onNavigate(item) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CompactNavigationItem(
    item: MobileSection?,
    selected: Boolean,
    iconFor: @Composable (MobileSection) -> Unit,
    onClick: () -> Unit,
    testTag: String,
) {
    androidx.compose.material3.Surface(
        onClick = onClick,
        modifier = Modifier.width(72.dp).height(64.dp).testTag(testTag),
        color =
            if (selected) MaterialTheme.colorScheme.secondaryContainer
            else androidx.compose.ui.graphics.Color.Transparent,
        shape = MaterialTheme.shapes.small,
    ) {
        Column(
            Modifier.fillMaxSize().padding(vertical = 4.dp),
            horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
        ) {
            Box(Modifier.height(28.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
                if (item == null) Icon(Icons.Default.MoreHoriz, contentDescription = "更多页面")
                else iconFor(item)
            }
            Text(
                item?.label ?: "更多",
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
