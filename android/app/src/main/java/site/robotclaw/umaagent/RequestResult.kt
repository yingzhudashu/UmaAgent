package site.robotclaw.umaagent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

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
