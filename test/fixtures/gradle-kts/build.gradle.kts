plugins { java }
subprojects {
    apply(plugin = "java")
    java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
    tasks.test { useJUnitPlatform() }
}
