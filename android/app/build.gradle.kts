plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android { namespace = "site.robotclaw.umaagent"; compileSdk = 35
    defaultConfig { applicationId = "site.robotclaw.umaagent"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "1.0" }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom)); implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui); implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose); implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.okhttp); implementation(libs.kotlinx.serialization.json)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
