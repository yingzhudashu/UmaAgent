package site.robotclaw.umaagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UpdateTest {
    private val versionName = if (BuildConfig.STAGING_BUILD) "1.2.3-staging" else "1.2.3"

    private fun validManifest(
        url: String = "/app/releases/12-abcdef0/UmaAgent-$versionName.apk",
    ) = UpdateManifest(
        packageName = BuildConfig.APPLICATION_ID,
        versionName = versionName,
        versionCode = 12,
        minSupportedVersionCode = 1,
        releaseId = "12-abcdef0",
        apk = ApkUpdate(
            url = url,
            sha256 = "a".repeat(64),
            sizeBytes = 7_454_493,
        ),
        publishedAt = "2026-08-31T00:00:00Z",
        releaseNotes = listOf("稳定性改进"),
    )

    @Test
    fun acceptsTheSharedReleaseContract() {
        val manifest = validManifest()

        assertEquals(manifest, UpdateService.validateManifest(manifest))
        assertEquals(
            "${BuildConfig.UMA_BASE_URL}/app/releases/12-abcdef0/UmaAgent-$versionName.apk",
            UpdateService.resolveDownloadUrl(manifest).toString(),
        )
    }

    @Test
    fun rejectsCrossOriginAndMismatchedReleasePaths() {
        val unsafeUrls = listOf(
            "https://cdn.example/UmaAgent-$versionName.apk",
            "/uploads/UmaAgent-$versionName.apk",
            "/app/releases/13-abcdef1/UmaAgent-$versionName.apk",
            "/app/releases/12-abcdef0/other.apk",
            "/app/releases/12-abcdef0/UmaAgent-$versionName.apk?mirror=1",
        )

        unsafeUrls.forEach { url ->
            assertThrows(UpdateException::class.java) {
                UpdateService.validateManifest(validManifest(url))
            }
        }
    }

    @Test
    fun rejectsMalformedHashesAndReleaseIdentifiers() {
        assertThrows(UpdateException::class.java) {
            UpdateService.validateManifest(
                validManifest().copy(apk = validManifest().apk.copy(sha256 = "z".repeat(64))),
            )
        }
        assertThrows(UpdateException::class.java) {
            UpdateService.validateManifest(validManifest().copy(releaseId = "12-not-hex"))
        }
    }

    @Test
    fun rejectsInvalidVersionBoundsAndOversizedApks() {
        assertThrows(UpdateException::class.java) {
            UpdateService.validateManifest(validManifest().copy(minSupportedVersionCode = 13))
        }
        assertThrows(UpdateException::class.java) {
            UpdateService.validateManifest(
                validManifest().copy(
                    apk = validManifest().apk.copy(sizeBytes = UpdateService.maxApkSizeBytes + 1),
                ),
            )
        }
    }

    @Test
    fun rejectsTimestampsWithoutTimezones() {
        assertThrows(UpdateException::class.java) {
            UpdateService.validateManifest(validManifest().copy(publishedAt = "2026-08-31"))
        }
    }
}
