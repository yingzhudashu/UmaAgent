package site.robotclaw.umaagent

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF1769AA),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD3E9FF),
    onPrimaryContainer = Color(0xFF082E4A),
    secondary = Color(0xFF2F6F55),
    secondaryContainer = Color(0xFFB8ECCC),
    tertiary = Color(0xFF8A5A00),
    error = Color(0xFFB3261E),
    background = Color(0xFFF7F9FC),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFE8EDF2),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8CC8FF),
    onPrimary = Color(0xFF003354),
    primaryContainer = Color(0xFF0E4D78),
    onPrimaryContainer = Color(0xFFD3E9FF),
    secondary = Color(0xFF78D6AA),
    secondaryContainer = Color(0xFF16513B),
    tertiary = Color(0xFFF4BF65),
    error = Color(0xFFFFB4AB),
    background = Color(0xFF101418),
    surface = Color(0xFF171C20),
    surfaceVariant = Color(0xFF283038),
)

@Composable
fun UmaAgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
