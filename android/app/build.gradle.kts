plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android { namespace = "site.robotclaw.umaagent"; compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "site.robotclaw.umaagent"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.1"
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
    }
    buildTypes {
        getByName("release") {
            val releaseSigning = signingConfigs.getByName("release")
            if (releaseSigning.storeFile != null) signingConfig = releaseSigning
            isMinifyEnabled = false
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom)); implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui); implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose); implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx); implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp); implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.core.ktx)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
