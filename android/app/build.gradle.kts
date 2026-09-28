plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tbe.pedidos"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tbe.pedidos"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "4.0"
    }
}
