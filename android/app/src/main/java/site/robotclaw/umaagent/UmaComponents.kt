package site.robotclaw.umaagent

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** 共享展示组件不直接改变登录或渠道状态。 */
private val prettyJson = Json { prettyPrint = true; ignoreUnknownKeys = true; isLenient = true }

@Composable
internal fun AssistantAvatar(bytes: ByteArray?, size: Dp) {
    val bitmap = remember(bytes) { bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
    if (bitmap != null) {
        Image(
            bitmap.asImageBitmap(),
            contentDescription = "助手头像",
            modifier = Modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    } else {
        Image(
            painterResource(R.drawable.cat_avatar),
            contentDescription = "默认助手头像",
            modifier = Modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    }
}

@Composable
internal fun ActionRows(actions: List<Pair<String, () -> Unit>>, enabled: Boolean) {
    actions.chunked(2).forEach { row ->
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { (label, action) ->
                OutlinedButton(action, Modifier.weight(1f), enabled = enabled) { Text(label) }
            }
            if (row.size == 1) Box(Modifier.weight(1f))
        }
    }
}

@Composable
internal fun ResourceQuery(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    actionLabel: String,
    enabled: Boolean,
    action: () -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(value, onValueChange, Modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true)
        Button(
            action,
            Modifier.align(Alignment.End),
            enabled = enabled && value.isNotBlank(),
        ) { Text(actionLabel) }
    }
}

@Composable
internal fun ReadOnlyOutput(value: String, title: String = "返回结果") {
    val formatted = remember(value) {
        runCatching {
            prettyJson.encodeToString(JsonElement.serializer(), prettyJson.parseToJsonElement(value))
        }.getOrDefault(value)
    }
    val lines = remember(formatted) { formatted.lines() }
    var expanded by rememberSaveable(formatted.hashCode()) { mutableStateOf(false) }
    val preview = if (expanded || lines.size <= 16) formatted else lines.take(16).joinToString("\n")

    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(title, style = MaterialTheme.typography.labelLarge)
            SelectionContainer {
                Text(
                    preview,
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (lines.size > 16) {
                TextButton(
                    onClick = { expanded = !expanded },
                    contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp),
                ) { Text(if (expanded) "收起结果" else "展开全部 ${lines.size} 行") }
            }
        }
    }
}

@Composable
internal fun ErrorBanner(message: String) {
    if (message.isBlank()) return
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Text(
            message,
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
