package site.robotclaw.umaagent

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

internal data class MenuAction(
    val label: String,
    val enabled: Boolean = true,
    val action: () -> Unit,
)

/** 可发现、只有一层的辅助操作入口；禁用状态与原操作一致。 */
@Composable
internal fun ActionMenu(actions: List<MenuAction>, label: String = "更多") {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }) {
            Text(
                label,
                Modifier.widthIn(max = 112.dp),
            )
        }
        DropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            actions.forEach { item ->
                DropdownMenuItem(
                    text = { Text(item.label) },
                    enabled = item.enabled,
                    onClick = {
                        expanded = false
                        item.action()
                    },
                )
            }
        }
    }
}
