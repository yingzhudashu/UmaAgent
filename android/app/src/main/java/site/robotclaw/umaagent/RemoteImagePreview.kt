package site.robotclaw.umaagent

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

// 外部图片使用独立、无凭据的连接池，绝不携带账号或测试环境认证头。
private val imageClient =
    OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).followSslRedirects(false).build()

/** 原生预览和系统文件保存；有限读取与采样解码防止大图片耗尽应用内存。 */
@Composable
internal fun RemoteImagePreview(url: String, onDismiss: () -> Unit) {
    var bytes by remember(url) { mutableStateOf<ByteArray?>(null) }
    var bitmap by remember(url) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var error by remember(url) { mutableStateOf("") }
    var saved by remember(url) { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val call =
        remember(url) {
            runCatching { imageClient.newCall(Request.Builder().url(url).build()) }.getOrNull()
        }
    // 关闭预览立即取消网络读取，不让离屏图片继续占用连接和解码内存。
    DisposableEffect(call) { onDispose { call?.cancel() } }
    val saver =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/*")) { uri
            ->
            val content = bytes
            if (uri != null && content != null)
                scope.launch {
                    runRequestCatching {
                        withContext(Dispatchers.IO) {
                            val output =
                                context.contentResolver.openOutputStream(uri) ?: error("无法打开保存位置")
                            output.use { it.write(content) }
                        }
                    }
                        .onSuccess { saved = true }
                        .onFailure { error = it.message ?: "保存失败" }
                }
        }
    LaunchedEffect(url) {
        runRequestCatching {
            withContext(Dispatchers.IO) {
                require(Uri.parse(url).scheme == "https") { "图片必须使用 HTTPS" }
                requireNotNull(call) { "图片地址无效" }
                    .execute()
                    .use { response ->
                        check(response.isSuccessful) { "图片读取失败（${response.code}）" }
                        val body = response.body ?: error("图片为空")
                        val limit = 20 * 1024 * 1024
                        check(body.contentLength() <= limit) { "图片超过 20 MiB 预览限制" }
                        // 使用项目已有 Okio 有界预读，支持最低 API 26；未知长度也不能无限读取。
                        val source = body.source()
                        check(!source.request(limit.toLong() + 1)) { "图片超过 20 MiB 预览限制" }
                        val data = source.readByteArray()
                        data to (decodePreviewBitmap(data) ?: error("不支持此图片格式"))
                    }
            }
        }
            .onSuccess { (data, decoded) ->
                bytes = data
                bitmap = decoded
            }
            .onFailure { error = it.message ?: "图片读取失败" }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("图片预览") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                bitmap?.let {
                    Image(
                        it.asImageBitmap(),
                        "消息图片",
                        Modifier.fillMaxWidth().heightIn(max = 420.dp),
                        contentScale = ContentScale.Fit,
                    )
                }
                    ?: if (error.isEmpty()) {
                        CircularProgressIndicator()
                    } else {
                        Unit
                    }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                if (saved) Text("图片已保存")
            }
        },
        confirmButton = {
            TextButton(
                {
                    saver.launch(
                        Uri.parse(url).lastPathSegment?.takeIf { it.contains('.') } ?: "image.png"
                    )
                },
                enabled = bytes != null,
            ) {
                Text("保存图片")
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("关闭") } },
    )
}
