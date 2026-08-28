package site.robotclaw.umaagent

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class Api35SmokeTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun targetSdkAndKeystorePatRoundTrip() {
        assertEquals(35, context.applicationInfo.targetSdkVersion)
        val store = PatStore(context)
        store.save("instrumented-pat")
        assertEquals("instrumented-pat", store.read())
        store.clear()
    }

    @Test
    fun cacheRejectsOldVersionsWithoutFallback() {
        val cache = SnapshotCache(context)
        val file = File(context.filesDir, "cache.json")
        file.writeText(Json.encodeToString(CacheEnvelope(1, emptyList(), emptyMap())))
        assertNotNull(file)
        assertEquals(null, cache.read())
        assertEquals(false, file.exists())
    }
}
