import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedArtifactResult
import org.gradle.maven.MavenModule
import org.gradle.maven.MavenPomArtifact
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

gradle.projectsEvaluated {
    val appProject = rootProject.findProject(":app") ?: return@projectsEvaluated
    appProject.tasks.register("exportReleaseRuntimeArtifacts") {
        notCompatibleWithConfigurationCache("Exports resolved runtime artifact and POM file paths")
        doLast {
            val outProp = appProject.findProperty("koderaRuntimeArtifactsOut")?.toString()?.trim()
                ?: error("Missing -PkoderaRuntimeArtifactsOut=<path>")
            val outFile = File(outProp)
            outFile.parentFile?.mkdirs()

            val runtimeConfig = appProject.configurations.getByName("releaseRuntimeClasspath")
            val artifacts = runtimeConfig.incoming.artifactView {
                componentFilter { it is ModuleComponentIdentifier }
            }.artifacts.artifacts

            fun resolvePomFile(group: String, module: String, version: String): File? {
                val query = appProject.dependencies.createArtifactResolutionQuery()
                    .forModule(group, module, version)
                    .withArtifacts(MavenModule::class.java, MavenPomArtifact::class.java)
                    .execute()
                for (comp in query.resolvedComponents) {
                    for (art in comp.getArtifacts(MavenPomArtifact::class.java)) {
                        if (art is ResolvedArtifactResult && art.file.isFile) {
                            return art.file
                        }
                    }
                }
                return null
            }

            fun parseParentCoord(pomFile: File): Triple<String, String, String>? {
                return try {
                    val dbf = DocumentBuilderFactory.newInstance()
                    dbf.isNamespaceAware = false
                    dbf.setFeature("http://xml.org/sax/features/external-general-entities", false)
                    dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
                    dbf.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
                    val doc = dbf.newDocumentBuilder().parse(pomFile)
                    val projectEl = doc.documentElement ?: return null
                    val children = projectEl.childNodes
                    for (i in 0 until children.length) {
                        val node = children.item(i)
                        if (node.nodeName == "parent") {
                            var g = ""
                            var a = ""
                            var v = ""
                            val pNodes = node.childNodes
                            for (j in 0 until pNodes.length) {
                                val p = pNodes.item(j)
                                when (p.nodeName) {
                                    "groupId" -> g = p.textContent.trim()
                                    "artifactId" -> a = p.textContent.trim()
                                    "version" -> v = p.textContent.trim()
                                }
                            }
                            if (g.isNotEmpty() && a.isNotEmpty() && v.isNotEmpty() && !v.contains('$')) {
                                return Triple(g, a, v)
                            }
                        }
                    }
                    null
                } catch (_: Exception) {
                    null
                }
            }

            fun collectPomChain(group: String, module: String, version: String): List<String> {
                val chain = mutableListOf<String>()
                var cur: Triple<String, String, String>? = Triple(group, module, version)
                var depth = 0
                while (cur != null && depth < 6) {
                    val pom = resolvePomFile(cur.first, cur.second, cur.third) ?: break
                    chain.add(pom.absolutePath)
                    cur = parseParentCoord(pom)
                    depth += 1
                }
                return chain
            }

            fun jsonEscape(raw: String): String = buildString {
                for (ch in raw) {
                    when (ch) {
                        '"' -> append("\\\"")
                        '\\' -> append("\\\\")
                        '\n' -> append("\\n")
                        '\r' -> append("\\r")
                        '\t' -> append("\\t")
                        else -> append(ch)
                    }
                }
            }

            val entriesJson = artifacts.mapNotNull { art ->
                val id = art.id.componentIdentifier as? ModuleComponentIdentifier ?: return@mapNotNull null
                val file = art.file
                if (!file.isFile) return@mapNotNull null
                val poms = collectPomChain(id.group, id.module, id.version)
                val pomsJson = poms.joinToString(",") { "\"${jsonEscape(it)}\"" }
                """{"group":"${jsonEscape(id.group)}","artifact":"${jsonEscape(id.module)}","version":"${jsonEscape(id.version)}","artifact_path":"${jsonEscape(file.absolutePath)}","pom_paths":[$pomsJson]}"""
            }

            outFile.writeText("[\n  " + entriesJson.joinToString(",\n  ") + "\n]\n", Charsets.UTF_8)
        }
    }
}
