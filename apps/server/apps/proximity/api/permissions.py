"""Contract declarations; current workspace membership is enforced on every request."""

from core.api.scopes import Operation

BOOTSTRAP = Operation("POST", "bootstrapProximity", "proximity:read")
CHECK_IN = Operation("POST", "checkInProximity", "proximity:act")
RESOLVE = Operation("POST", "resolveProximityTokens", "proximity:read")
NEARBY = Operation("GET", "getNearbyProximity", "proximity:read")
CHECK_OUT = Operation("POST", "checkOutProximity", "proximity:act")
