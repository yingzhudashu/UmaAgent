package site.robotclaw.umaagent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel

/** 应用入口仅协调认证状态与系统权限。 */
@Composable
fun UmaScreen(model: UmaViewModel = viewModel()) {
    val state by model.uiState.collectAsState()
    val context = LocalContext.current
    val installPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        val path = state.updateFilePath ?: return@rememberLauncherForActivityResult
        val file = java.io.File(path)
        if (!file.exists() || !context.packageManager.canRequestPackageInstalls()) {
            model.clearUpdateFile()
            return@rememberLauncherForActivityResult
        }
        runCatching { context.startActivity(UpdateService.installIntent(context, file)) }
            .onFailure { model.clearUpdateFile() }
    }

    LaunchedEffect(state.updateFilePath) {
        val path = state.updateFilePath ?: return@LaunchedEffect
        val file = java.io.File(path)
        if (!file.exists()) return@LaunchedEffect
        if (!context.packageManager.canRequestPackageInstalls()) {
            val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                data = android.net.Uri.parse("package:${context.packageName}")
            }
            runCatching { installPermissionLauncher.launch(settingsIntent) }
                .onFailure { model.clearUpdateFile() }
        } else {
            runCatching { context.startActivity(UpdateService.installIntent(context, file)) }
                .onFailure { model.clearUpdateFile() }
        }
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }
    LaunchedEffect(state.userRole, state.workspace) {
        if (state.userRole == "admin" && state.workspace == "xianyu" && Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (state.stagingAccessRequired) {
            StagingAccessScreen(state, model)
        } else if (!state.tokenPresent) {
            AuthScreen(state, model)
        } else {
            AuthenticatedScreen(state, model)
        }
    }
}
