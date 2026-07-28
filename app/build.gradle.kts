plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val hikariApiUrl = (project.findProperty("HIKARI_API_URL") as String?) ?: "https://YOUR-HIKARI-SERVER.vercel.app"
val ciVersionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()?.coerceAtLeast(2) ?: 2

android {
    namespace = "com.charlesess6.hikari"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.charlesess6.hikari"
        minSdk = 24
        targetSdk = 35
        versionCode = ciVersionCode
        versionName = "1.2.${ciVersionCode}"
        buildConfigField("String", "HIKARI_API_URL", "\"${hikariApiUrl.trimEnd('/')}\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
