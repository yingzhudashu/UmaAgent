package site.robotclaw.umaagent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/** 认证页独立处理系统栏与键盘留白，避免登录控件被遮挡。 */
@Composable
internal fun StagingAccessScreen(state: UmaUiState, model: UmaViewModel) {
    var password by rememberSaveable { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("UmaAgent 测试版", style = MaterialTheme.typography.headlineMedium)
        Text("输入测试环境访问口令后继续。该口令只保存在此设备的 Android Keystore 中。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            label = { Text("测试环境口令") },
            enabled = !state.loading,
        )
        Button(
            { model.configureStagingAccess(password) },
            Modifier.fillMaxWidth(),
            enabled = password.isNotBlank() && !state.loading,
        ) { Text("连接测试环境") }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(state.error)
    }
}

@Composable
internal fun AuthScreen(state: UmaUiState, model: UmaViewModel) {
    val clipboard = LocalClipboardManager.current
    var token by rememberSaveable { mutableStateOf("") }
    var authMode by rememberSaveable { mutableStateOf("login") }
    var label by rememberSaveable { mutableStateOf("android") }
    var copied by rememberSaveable(state.registrationToken) { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("UmaAgent", style = MaterialTheme.typography.headlineMedium)
        Text(
            if (authMode == "register") "创建一个新的隔离账户" else "使用访问令牌连接 UmaAgent Core",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (authMode == "register") {
            if (state.registrationToken.isBlank()) {
                OutlinedTextField(
                    label,
                    { if (it.length <= 80) label = it },
                    Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("令牌名称") },
                    enabled = !state.loading,
                )
                Button(
                    { model.register(label) },
                    Modifier.fillMaxWidth(),
                    enabled = !state.loading,
                ) { Text("注册") }
            } else {
                Text("注册成功，请立即保存此访问令牌", color = MaterialTheme.colorScheme.primary)
                OutlinedTextField(
                    state.registrationToken,
                    {},
                    Modifier.fillMaxWidth(),
                    readOnly = true,
                    minLines = 3,
                    label = { Text("访问令牌") },
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        {
                            clipboard.setText(AnnotatedString(state.registrationToken))
                            copied = true
                        },
                        Modifier.weight(1f),
                    ) { Text(if (copied) "已复制" else "复制令牌") }
                    Button(
                        { model.login(state.registrationToken) },
                        Modifier.weight(1f),
                        enabled = !state.loading,
                    ) { Text("继续进入") }
                }
            }
            OutlinedButton(
                { authMode = "login"; model.clearRegistration() },
                Modifier.fillMaxWidth(),
                enabled = !state.loading,
            ) { Text("已有令牌，返回登录") }
        } else {
            OutlinedTextField(
                token,
                { token = it },
                Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                label = { Text("访问令牌") },
            )
            Button(
                { model.login(token) },
                Modifier.fillMaxWidth(),
                enabled = token.isNotBlank() && !state.loading,
            ) { Text("登录") }
            OutlinedButton(
                { authMode = "register"; model.clearRegistration() },
                Modifier.fillMaxWidth(),
                enabled = !state.loading,
            ) { Text("创建新账户") }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ErrorBanner(state.error)
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        UpdatePanel(state, model)
    }
}
