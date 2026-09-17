package site.robotclaw.umaagent

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

private val LightColors =
    lightColorScheme(
        primary = Color(0xFF365F45),
        onPrimary = Color.White,
        secondary = Color(0xFF365F45),
        secondaryContainer = Color(0xFFE6EFE7),
        onSecondaryContainer = Color(0xFF17212B),
        primaryContainer = Color(0xFFE6EFE7),
        onPrimaryContainer = Color(0xFF17212B),
        background = Color(0xFFF5F3ED),
        surface = Color.White,
        onSurface = Color(0xFF17212B),
        surfaceTint = Color(0xFF365F45),
        surfaceContainer = Color(0xFFEDF0E9),
        surfaceContainerLow = Color(0xFFF3F5EF),
        surfaceContainerHigh = Color(0xFFE7EBE2),
        surfaceContainerHighest = Color(0xFFE0E6DC),
        surfaceContainerLowest = Color.White,
        onSurfaceVariant = Color(0xFF52616E),
        outline = Color(0xFF7B8A98),
        surfaceVariant = Color(0xFFE6EFE7),
    )
private val DarkColors =
    darkColorScheme(
        primary = Color(0xFFA5D6B0),
        onPrimary = Color(0xFF153C23),
        secondary = Color(0xFFA5D6B0),
        secondaryContainer = Color(0xFF263D30),
        onSecondaryContainer = Color(0xFFD6EFDE),
        primaryContainer = Color(0xFF263D30),
        onPrimaryContainer = Color(0xFFD6EFDE),
        background = Color(0xFF111820),
        surface = Color(0xFF1B2632),
        onSurface = Color(0xFFF1F5F9),
        surfaceTint = Color(0xFFA5D6B0),
        surfaceContainer = Color(0xFF202B26),
        surfaceContainerLow = Color(0xFF18231F),
        surfaceContainerHigh = Color(0xFF29352E),
        surfaceContainerHighest = Color(0xFF334037),
        surfaceContainerLowest = Color(0xFF101814),
        onSurfaceVariant = Color(0xFFBCC8D5),
        outline = Color(0xFF65768A),
        surfaceVariant = Color(0xFF293E54),
    )

@Composable
fun UmaAgentTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode)
        SideEffect {
            // 系统图标跟随应用的实际主题，而不是仅跟随系统主题，浅色背景不再显示白色状态图标。
            (view.context as? Activity)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !darkTheme
                    isAppearanceLightNavigationBars = !darkTheme
                }
            }
        }
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography =
            Typography(
                bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                bodyMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                bodySmall = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
            ),
        shapes =
            Shapes(
                small = RoundedCornerShape(8.dp),
                medium = RoundedCornerShape(12.dp),
                large = RoundedCornerShape(20.dp),
            ),
        content = content,
    )
}
