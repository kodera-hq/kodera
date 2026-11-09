package io.kodera.android.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The sealed session must sit where the backup and device-transfer rules exclude it. The rules are the
 * real resource files (the test runs in the :app module directory), the path the real store resolves.
 */
class SessionStorageTests {
    private val filesDir = File("build/session-storage-test/files")
    private val rules = File("src/main/res/xml")

    private fun excludes(element: Element, path: String): Boolean {
        val nodes = element.getElementsByTagName("exclude")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .any { it.getAttribute("domain") == "file" && it.getAttribute("path") == path }
    }

    private fun document(name: String): Element {
        val file = File(rules, name)
        assertTrue("${file.absolutePath} is missing", file.isFile)
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
    }

    @Test fun testTheSessionFileResolvesUnderFilesDir() {
        val file = SessionStorage.sessionFile(filesDir)
        assertEquals(filesDir.canonicalFile, file.parentFile.parentFile.canonicalFile)
        assertEquals("core-session.bin", file.name)
    }

    @Test fun testTheBackupAndTransferRulesExcludeTheSessionDirectory() {
        val excluded = SessionStorage.sessionFile(filesDir).parentFile.relativeTo(filesDir).path
        val extraction = document("data_extraction_rules.xml")
        assertEquals("data-extraction-rules", extraction.tagName)
        for (section in listOf("cloud-backup", "device-transfer")) {
            val sections = extraction.getElementsByTagName(section)
            assertEquals(section, 1, sections.length)
            assertTrue("$section carries $excluded", excludes(sections.item(0) as Element, excluded))
        }
        val backup = document("backup_rules.xml")
        assertEquals("full-backup-content", backup.tagName)
        assertTrue("full backup carries $excluded", excludes(backup, excluded))
    }
}
