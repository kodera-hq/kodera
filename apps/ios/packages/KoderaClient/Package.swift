// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KoderaClient",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "KoderaClient", targets: ["KoderaClient"])],
    dependencies: [.package(path: "../KoderaDomain")],
    targets: [
        .target(name: "KoderaClient", dependencies: ["KoderaDomain"]),
        .testTarget(name: "KoderaClientTests", dependencies: ["KoderaClient"], resources: [.copy("Fixtures")]),
    ]
)
