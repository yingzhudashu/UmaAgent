import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// 部署地址属于本地配置；仓库只保留不可用于生产的示例地址。包名与签名保持稳定，确保覆盖升级。
fun deploymentOrigin(property: String, environment: String, example: String): String {
    val value = providers.gradleProperty(property).orNull ?: System.getenv(environment) ?: example
    require(value.startsWith("https://") && !value.contains('"') && !value.contains('\\') && !value.contains('\n')) {
        "Deployment origin must be an HTTPS origin"
    }
    val uri = URI(value)
    require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isNullOrEmpty()) {
        "Deployment origin must not contain credentials, a path, query or fragment"
    }
    return value
}
val productionOrigin = deploymentOrigin("umaBaseUrl", "UMA_ANDROID_BASE_URL", "https://agent.example.com")
val stagingOrigin = deploymentOrigin("umaStagingBaseUrl", "UMA_ANDROID_STAGING_BASE_URL", "https://staging.agent.example.com")

android { namespace = "site.robotclaw.umaagent"; compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "site.robotclaw.umaagent"
        minSdk = 26
        targetSdk = 35
        versionCode = 14
        versionName = "1.4.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("release") {
            val storeFilePath = providers.gradleProperty("umaStoreFile").orNull
                ?: System.getenv("UMA_ANDROID_KEYSTORE")
            val storePasswordValue = providers.gradleProperty("umaStorePassword").orNull
                ?: System.getenv("UMA_ANDROID_KEYSTORE_PASSWORD")
            val keyPasswordValue = providers.gradleProperty("umaKeyPassword").orNull
                ?: System.getenv("UMA_ANDROID_KEY_PASSWORD")
            if (!storeFilePath.isNullOrBlank() && !storePasswordValue.isNullOrBlank() && !keyPasswordValue.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = storePasswordValue
                keyAlias = providers.gradleProperty("umaKeyAlias").orNull ?: System.getenv("UMA_ANDROID_KEY_ALIAS") ?: "umaagent"
                keyPassword = keyPasswordValue
            }
        }
        create("staging") {
            val storeFilePath = providers.gradleProperty("umaStagingStoreFile").orNull
                ?: System.getenv("UMA_ANDROID_STAGING_KEYSTORE")
            val storePasswordValue = providers.gradleProperty("umaStagingStorePassword").orNull
                ?: System.getenv("UMA_ANDROID_STAGING_KEYSTORE_PASSWORD")
            val keyPasswordValue = providers.gradleProperty("umaStagingKeyPassword").orNull
                ?: System.getenv("UMA_ANDROID_STAGING_KEY_PASSWORD")
            if (!storeFilePath.isNullOrBlank() && !storePasswordValue.isNullOrBlank() && !keyPasswordValue.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = storePasswordValue
                keyAlias = providers.gradleProperty("umaStagingKeyAlias").orNull
                    ?: System.getenv("UMA_ANDROID_STAGING_KEY_ALIAS")
                    ?: "umaagent-staging"
                keyPassword = keyPasswordValue
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            resValue("string", "app_name", "UmaAgent 本地验收")
            buildConfigField("String", "UMA_BASE_URL", "\"http://10.0.2.2:33210\"")
            buildConfigField("String", "UMA_UPDATE_MANIFEST_URL", "\"http://10.0.2.2:33210/app/latest.json\"")
            buildConfigField("boolean", "STAGING_BUILD", "false")
        }
        getByName("release") {
            val releaseSigning = signingConfigs.getByName("release")
            if (releaseSigning.storeFile != null) signingConfig = releaseSigning
            isMinifyEnabled = false
            buildConfigField("String", "UMA_BASE_URL", "\"$productionOrigin\"")
            buildConfigField("String", "UMA_UPDATE_MANIFEST_URL", "\"$productionOrigin/app/latest.json\"")
            buildConfigField("boolean", "STAGING_BUILD", "false")
        }
        create("staging") {
            initWith(getByName("release"))
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            signingConfig = null
            val stagingSigning = signingConfigs.getByName("staging")
            if (stagingSigning.storeFile != null) signingConfig = stagingSigning
            buildConfigField("String", "UMA_BASE_URL", "\"$stagingOrigin\"")
            buildConfigField("String", "UMA_UPDATE_MANIFEST_URL", "\"$stagingOrigin/app/latest.json\"")
            buildConfigField("boolean", "STAGING_BUILD", "true")
            resValue("string", "app_name", "UmaAgent 测试版")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom)); implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui); implementation(libs.androidx.compose.material3); implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.navigation.compose); implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx); implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp); implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.core.ktx)
    implementation("androidx.webkit:webkit:1.12.1")
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test)
    testImplementation(libs.junit4)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}

// 正文资源由同一共享模块生成，避免手工复制导致两端版本漂移。
val buildMessageContent by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.parentFile
    inputs.dir("../../packages/message-content/src")
    inputs.files("../../packages/message-content/android.html", "../../packages/message-content/vite.android.config.ts", "../../packages/message-content/package.json", "../../package-lock.json")
    outputs.dir("src/main/assets/message")
    if (System.getProperty("os.name").startsWith("Windows")) commandLine("cmd", "/c", "npm", "run", "build:android:content")
    else commandLine("npm", "run", "build:android:content")
}
val copyShortcutCatalog by tasks.registering(Copy::class) {
    from("../../packages/protocol/src/commands.json")
    into(layout.buildDirectory.dir("generated/shortcutAssets"))
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/shortcutAssets"))
tasks.named("preBuild").configure { dependsOn(buildMessageContent, copyShortcutCatalog) }
