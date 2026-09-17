package site.robotclaw.umaagent

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 共享展示组件不直接改变登录或渠道状态。 */
@Composable
internal fun AssistantAvatar(bitmap: Bitmap?, size: Dp) {
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
        Row(
            Modifier.fillMaxWidth().padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            row.forEach { (label, action) ->
                OutlinedButton(action, Modifier.weight(1f), enabled = enabled) { Text(label) }
            }
            if (row.size == 1) Box(Modifier.weight(1f))
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
