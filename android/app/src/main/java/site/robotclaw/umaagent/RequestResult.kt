package site.robotclaw.umaagent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal fun xianyuErrorMessage(error: Throwable): String =
    if (error.message?.contains("not configured", ignoreCase = true) == true)
        "尚未配置闲鱼渠道，请由管理员完成服务配置后重试。"
    else requestErrorMessage(error, "无法读取闲鱼渠道状态。")

/** 网络异常给出可操作的中文信息；业务错误保留服务端说明，不把连接地址和英文堆栈铺满页面。 */
internal fun requestErrorMessage(error: Throwable, defaultMessage: String): String =
    when (error) {
        is java.net.SocketTimeoutException -> "连接超时，请检查网络后重试。"
        is javax.net.ssl.SSLException -> "无法建立安全连接，请检查服务证书与设备时间。"
        is java.net.ConnectException,
        is java.net.UnknownHostException,
        is java.net.NoRouteToHostException,
        is java.net.SocketException -> "无法连接服务，请检查网络后重试。"
        else -> error.message?.takeIf { it.isNotBlank() } ?: defaultMessage
    }

/** 请求失败可展示给用户；账号切换和页面销毁触发的取消必须直接终止协程。 */
internal suspend inline fun <T> runRequestCatching(action: () -> T): Result<T> {
    currentCoroutineContext().ensureActive()
    return try {
        val result = action()
        currentCoroutineContext().ensureActive()
        Result.success(result)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        currentCoroutineContext().ensureActive()
        Result.failure(error)
    }
}
