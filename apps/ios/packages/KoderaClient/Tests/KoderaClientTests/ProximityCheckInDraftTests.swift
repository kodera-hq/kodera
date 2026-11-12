import XCTest
import KoderaDomain
@testable import KoderaClient

final class ProximityCheckInDraftTests: XCTestCase {
    func testPreparationReplacesLocalChoiceAndClearDropsIt() {
        var draft = ProximityCheckInDraft()
        XCTAssertNil(draft.status)
        XCTAssertTrue(draft.prepare(.safe)); XCTAssertEqual(draft.status, .safe)
        XCTAssertTrue(draft.prepare(.needAssistance)); XCTAssertEqual(draft.status, .needAssistance)
        XCTAssertTrue(draft.prepare(.musterPoint)); XCTAssertEqual(draft.status, .musterPoint)
        XCTAssertFalse(draft.prepare(.messageOnly)); XCTAssertEqual(draft.status, .musterPoint)
        draft.clear(); XCTAssertNil(draft.status)
        XCTAssertNil(ProximityCheckInDraft().status)
    }
    func testScopedPreparationCannotSurviveOrganisationReplacementOrAwayBack() {
        let first = "11111111-1111-4111-8111-111111111111"
        let second = "22222222-2222-4222-8222-222222222222"
        var draft = ProximityCheckInDraft()
        XCTAssertTrue(draft.configure(organisationId: first))
        let old = draft.preparationContext(forOrganisationId: first)
        XCTAssertTrue(draft.prepare(.safe, context: old))
        XCTAssertEqual(draft.status, .safe)
        XCTAssertTrue(draft.configure(organisationId: second))
        XCTAssertNil(draft.status)
        XCTAssertNil(draft.preparationContext(forOrganisationId: first))
        XCTAssertFalse(draft.prepare(.needAssistance, context: old))
        XCTAssertTrue(draft.configure(organisationId: first))
        XCTAssertFalse(draft.prepare(.musterPoint, context: old))
        XCTAssertNil(draft.status)
        XCTAssertTrue(draft.prepare(.musterPoint, context: draft.preparationContext(forOrganisationId: first)))
    }
    func testMissingForeignAndInvalidOwnersFailClosedWithoutChangingCurrentChoice() {
        let org = "11111111-1111-4111-8111-111111111111"
        var draft = ProximityCheckInDraft(), foreign = ProximityCheckInDraft()
        XCTAssertEqual(draft, foreign, "visible empty draft values remain equal despite private callback ownership")
        XCTAssertNil(draft.preparationContext(forOrganisationId: org))
        XCTAssertFalse(draft.prepare(.safe, context: nil))
        XCTAssertTrue(draft.configure(organisationId: org))
        XCTAssertTrue(foreign.configure(organisationId: org))
        XCTAssertFalse(draft.prepare(.safe, context: foreign.preparationContext(forOrganisationId: org)))
        let current = draft.preparationContext(forOrganisationId: org)
        XCTAssertTrue(draft.prepare(.safe, context: current))
        XCTAssertFalse(draft.prepare(.messageOnly, context: current))
        XCTAssertEqual(draft.status, .safe)
        for invalid in ["", "not-an-org", "00000000-0000-0000-0000-000000000000", org.uppercased().replacingOccurrences(of: "1", with: "A")] {
            XCTAssertFalse(draft.configure(organisationId: invalid))
            XCTAssertNil(draft.status); XCTAssertNil(draft.organisationId)
            XCTAssertFalse(draft.prepare(.needAssistance, context: current))
        }
        XCTAssertTrue(draft.configure(organisationId: nil))
        XCTAssertNil(draft.preparationContext(forOrganisationId: nil))
    }
    func testClearInvalidatesCapturedSheetEvenWithinTheSameOrganisation() {
        let org = "11111111-1111-4111-8111-111111111111"
        var draft = ProximityCheckInDraft()
        draft.configure(organisationId: org)
        let old = draft.preparationContext(forOrganisationId: org)
        draft.clear()
        XCTAssertFalse(draft.prepare(.safe, context: old))
        draft.configure(organisationId: org)
        XCTAssertFalse(draft.prepare(.safe, context: old))
        XCTAssertNil(draft.status)
    }

}
