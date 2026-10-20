plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
tasks.register("downloadBabylonAssets") {
    doLast {
        val assetsDir = layout.projectDirectory.dir("src/main/assets").asFile
        val libsDir = java.io.File(assetsDir, "libs").apply { mkdirs() }
        val havokDir = java.io.File(assetsDir, "havok").apply { mkdirs() }

        fun download(url: String, file: java.io.File) {
            if (file.exists()) {
                println("Already exists: ${file.name}")
                return
            }

            println("Downloading $url")

            java.net.URI(url).toURL().openStream().use { input ->
                file.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            println("Saved: ${file.absolutePath}")
        }

        download(
            "https://cdn.babylonjs.com/babylon.js",
            java.io.File(libsDir, "babylon.js")
        )

        download(
            "https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js",
            java.io.File(libsDir, "babylonjs.loaders.min.js")
        )

        download(
            "https://cdn.babylonjs.com/havok/HavokPhysics.js",
            java.io.File(havokDir, "HavokPhysics.js")
        )

        download(
            "https://cdn.babylonjs.com/havok/HavokPhysics.wasm",
            java.io.File(havokDir, "HavokPhysics.wasm")
        )
    }
}
