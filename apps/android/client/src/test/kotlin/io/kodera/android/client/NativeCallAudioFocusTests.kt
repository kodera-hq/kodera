package io.kodera.android.client

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class NativeCallAudioFocusTests {
    @Test fun retirementAtEachAcquisitionBoundaryReleasesFocusAndRestoresNormalMode() {
        for (boundary in listOf("before", "request", "mode", "after")) {
            val owned = AtomicBoolean(boundary != "before")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val abandoned = AtomicInteger(); val focused = AtomicBoolean(false); val communication = AtomicBoolean(false)
            val result = AtomicReference<Boolean?>(); val failure = AtomicReference<Throwable?>()
            val focus = NativeCallAudioFocus(
                request = {
                    if (boundary == "request") { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                    focused.set(true); true
                },
                abandon = { abandoned.incrementAndGet(); focused.set(false) },
                communicationMode = { active -> communication.set(active); if (active && boundary == "mode") owned.set(false) },
            )
            val thread = Thread { try { result.set(focus.acquire("call") { owned.get() }) } catch (error: Throwable) { failure.set(error) } }
            thread.start()
            try {
                if (boundary == "request") { assertTrue(entered.await(5, TimeUnit.SECONDS)); owned.set(false) }
            } finally { release.countDown(); thread.join(5000) }
            assertFalse(thread.isAlive); assertNull(failure.get())
            if (boundary == "after") { owned.set(false); focus.release("call") }
            assertEquals(boundary == "after", result.get())
            assertFalse(focused.get()); assertFalse(communication.get())
            assertEquals(if (boundary == "before") 0 else 1, abandoned.get())
        }
    }

    @Test fun lateReleaseForPreviousCallPreservesCurrentFocus() {
        var focused = false; var communication = false
        val focus = NativeCallAudioFocus({ focused = true; true }, { focused = false }, { communication = it })
        assertTrue(focus.acquire("first") { true }); focus.release("first")
        assertTrue(focus.acquire("second") { true }); focus.release("first")
        assertTrue(focused); assertTrue(communication)
        focus.release(); assertFalse(focused); assertFalse(communication)
    }

    @Test fun deniedFocusNeverEntersCommunicationMode() {
        var abandoned = false; var communication = false
        val focus = NativeCallAudioFocus({ false }, { abandoned = true }, { communication = it })
        assertFalse(focus.acquire("call") { true }); assertTrue(abandoned); assertFalse(communication)
    }
}
