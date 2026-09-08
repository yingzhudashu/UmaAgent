package site.robotclaw.umaagent

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** 渠道工作台只操作界面和明确的服务控制；切换账号不停止后台 Adapter。 */
@Composable
internal fun XianyuWorkspaceScreen(state: UmaUiState, model: UmaViewModel, modifier: Modifier = Modifier) {
    val login = remember(state.xianyuLogin, state.xianyuStatus) {
        parseXianyuLogin(state.xianyuLogin) ?: parseXianyuLogin(state.xianyuStatus)
    }
    val qr = remember(login?.qrDataUrl) { decodeDataUrlBitmap(login?.qrDataUrl) }
    val buyers = state.sessions.filter { it.workspace.contains("xianyu") && !it.title.contains("总控") }
    val control = state.sessions.firstOrNull { it.title.contains("总控") }
    Column(modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("咸鱼工作台", style = MaterialTheme.typography.titleMedium)
                        Text(if (state.offline) "离线只读" else "管理员会话已连接", style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton({ model.switchAccount() }, enabled = !state.loading) {
                        Text("切换普通账号")
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("自动回复", style = MaterialTheme.typography.labelMedium)
                        Text(
                            if (state.xianyuAutoReply) "AI 回复直接发送给买家" else "AI 回复保存为草稿，确认后发送",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = state.xianyuAutoReply,
                        onCheckedChange = model::setXianyuAutoReply,
                        enabled = !state.offline && !state.loading,
                    )
                }
                // 买家数量增长时只组合可见项，稳定会话 ID 避免切换或重排时复用错误状态。
                LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    control?.let { session ->
                        item(key = session.id) { OutlinedButton({ model.selectSession(session.id) }) { Text("总控") } }
                    }
                    items(buyers, key = { it.id }) { session ->
                        OutlinedButton({ model.selectSession(session.id) }, Modifier.widthIn(max = 200.dp)) { Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
        if (login?.status != "authenticated") {
            Surface(Modifier.fillMaxWidth().padding(top = 8.dp), color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium) {
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("需要扫码登录闲鱼", style = MaterialTheme.typography.titleSmall)
                        Text(login?.message ?: "首次部署或登录过期后，请使用闲鱼 App 扫码。", style = MaterialTheme.typography.bodySmall)
                        Button({ model.xianyuStartLogin() }, enabled = !state.offline && !state.loading) { Text(if (login?.qrDataUrl == null) "生成二维码" else "重新生成二维码") }
                    }
                    qr?.let { Image(it.asImageBitmap(), "闲鱼登录二维码", Modifier.size(128.dp), contentScale = ContentScale.Fit) }
                }
            }
        }
        ChatScreen(
            state,
            model,
            onOpenSessions = {},
            xianyuDraftMessageIds = state.xianyuDraftMessageIds[state.selectedSessionId].orEmpty(),
            onSendXianyuDraft = model::sendXianyuDraft,
            modifier = Modifier.weight(1f),
        )
    }
}
